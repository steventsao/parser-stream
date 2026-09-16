import { Clock, Context, Effect, Layer, Option, Schedule, Schema, Stream } from "effect"
import {
  type DocumentInput,
  type DocumentState,
  initialState,
  partBlockId,
  reduce,
  renderPartSection,
  type Transition,
  validate
} from "./domain/Document.js"
import type { ConvertEvent } from "./domain/Events.js"
import {
  extractBlocks,
  isCompleteElement,
  normalizeBlocks,
  provisionalTail,
  stripFence,
  withRootId,
  wrapTable
} from "./domain/Html.js"
import { HtmlStream, type HtmlStreamError, type PartRef } from "./HtmlStream.js"
import { PostParse, type PostParseError, run as runPostParse } from "./PostParse.js"
import { type SanitizeError, Sanitizer } from "./Sanitizer.js"
import type { Source } from "./Source.js"
import { type Split, SplitError, Splitter } from "./Splitter.js"
import * as PdfSplitter from "./splitters/Pdf.js"

/**
 * The conversion engine. It depends only on three ports (`HtmlStream`,
 * `Sanitizer`, `Splitter`) and emits `ConvertEvent`s. It knows nothing about
 * prompts, models, credentials, or which HTML tags a parser produces: it cuts
 * complete blocks out of the stream, sanitizes them, and numbers them.
 *
 * - `whole`: one parser request for the whole source. Each complete block is
 *   appended as it arrives.
 * - `split`: one request per part (for example per page), `concurrency` at a
 *   time. An empty section per part is appended first, which pins reading
 *   order; then each part replaces its own section as it streams. Parts can
 *   finish in any order. A part that fails after its retries shows an error in
 *   place and does not affect the others.
 * - `auto`: `split` when the splitter finds more than one part, else `whole`.
 */

export type Mode = "auto" | "whole" | "split"

export interface ConvertOptions {
  readonly mode: Mode
  /** Parts converted at the same time (split mode). */
  readonly concurrency: number
  /** Fail a parser request that produces no output for this long. */
  readonly idleTimeoutMs: number
  /** Extra attempts for a failed part (split mode). A whole stream is never retried: it would duplicate blocks. */
  readonly retries: number
  /** Refuse documents with more parts than this. */
  readonly maxParts: number
  /**
   * A streaming part repaints its whole section, so repainting on every block
   * sends O(blocks²) bytes. Instead a part repaints when it grew by
   * `paintGrowth`, or when `paintMaxQuietMs` passed with new content, but never
   * more often than `paintMinIntervalMs`. The first and final paints are immediate.
   */
  readonly paintGrowth: number
  readonly paintMinIntervalMs: number
  readonly paintMaxQuietMs: number
}

export const defaultOptions: ConvertOptions = {
  mode: "auto",
  concurrency: 4,
  idleTimeoutMs: 90_000,
  retries: 2,
  maxParts: 100,
  paintGrowth: 1.25,
  paintMinIntervalMs: 120,
  paintMaxQuietMs: 1_200
}

export class PartLimitError extends Schema.TaggedError<PartLimitError>()("PartLimitError", {
  count: Schema.Int,
  maxParts: Schema.Int,
  message: Schema.String
}) {}

export class ParserIdleError extends Schema.TaggedError<ParserIdleError>()("ParserIdleError", {
  message: Schema.String
}) {}

export class ContractError extends Schema.TaggedError<ContractError>()("ContractError", {
  message: Schema.String
}) {}

export type ConvertError =
  | HtmlStreamError
  | ParserIdleError
  | SanitizeError
  | PostParseError
  | SplitError
  | PartLimitError

/** Validate and apply one input. `undefined` means the document is already terminal. */
export const step = (
  state: DocumentState,
  input: DocumentInput
): Effect.Effect<Transition | undefined, ContractError> => {
  const violation = validate(state, input)
  return violation ? Effect.fail(new ContractError({ message: violation })) : Effect.succeed(reduce(state, input))
}

/** Fold a stream of events into the finished document. */
export const toDocument = <E, R>(
  events: Stream.Stream<ConvertEvent, E, R>
): Effect.Effect<DocumentState, E | ContractError, R> =>
  Effect.gen(function*() {
    let state = initialState
    const apply = (input: DocumentInput) =>
      Effect.map(step(state, input), (transition) => {
        if (transition) state = transition.state
      })
    yield* Stream.runForEach(events, apply)
    yield* apply({ type: "done" })
    return state
  })

const failIfIdle = (options: ConvertOptions, what: string) => <A, E, R>(self: Stream.Stream<A, E, R>) =>
  Stream.timeoutOrElse(self, {
    duration: options.idleTimeoutMs,
    orElse: () =>
      Stream.fail(
        new ParserIdleError({ message: `${what} produced no output for ${Math.round(options.idleTimeoutMs / 1000)}s.` })
      )
  })

const UNIT_RE = /^[a-z][a-z-]{0,23}$/

const make = Effect.gen(function*() {
  const parser = yield* HtmlStream
  const sanitizer = yield* Sanitizer
  const splitter = yield* Splitter

  /**
   * Everything the core emits goes through here: the sanitizer first, then the
   * post-parse hooks. A growing table's provisional rows leave the core too,
   * so they cross the same pipeline. A hook can therefore see overlapping
   * content more than once, and must be deterministic.
   */
  const prepare = (html: string) =>
    Effect.gen(function*() {
      const safe = yield* sanitizer.sanitize(html)
      return yield* runPostParse(yield* PostParse, safe)
    })

  const wholeStream = (source: Source, options: ConvertOptions): Stream.Stream<ConvertEvent, ConvertError> =>
    Stream.suspend(() => {
      let buffer = ""
      let count = 0
      const appendAll = (raw: ReadonlyArray<string>) =>
        Effect.forEach(raw, (block) => Effect.map(prepare(block), normalizeBlocks)).pipe(
          Effect.map((groups) =>
            groups.flat().map((html): ConvertEvent => {
              count += 1
              const id = `block-${count}`
              return { type: "append", id, html: withRootId(wrapTable(html), id) }
            })
          )
        )
      const flushTail = Effect.suspend(() => {
        const tail = stripFence(buffer).trim()
        buffer = ""
        return tail ? appendAll([tail]) : Effect.succeed([])
      })
      return parser.parse({ source, part: undefined }).pipe(
        failIfIdle(options, "The parser"),
        Stream.mapEffect((delta) => {
          const { blocks, rest } = extractBlocks(buffer + delta)
          buffer = rest
          return appendAll(blocks)
        }),
        Stream.concat(Stream.fromEffect(flushTail)),
        Stream.flattenIterable
      )
    })

  /** One attempt at one part. All paint state lives inside the attempt, so a retry starts clean. */
  const partAttempt = (
    source: Source,
    part: PartRef,
    options: ConvertOptions
  ): Stream.Stream<ConvertEvent, HtmlStreamError | ParserIdleError | SanitizeError | PostParseError> =>
    Stream.suspend(() => {
      const id = partBlockId(part.unit, part.index)
      const children: Array<string> = []
      let provisional: string | undefined
      let provisionalChildren = 0
      let buffer = ""
      let painted = false
      let lastPaintAt = 0
      let lastPaintSize = 0

      const size = () => children.reduce((n, child) => n + child.length, 0) + (provisional?.length ?? 0)

      const paint = (now: number): ConvertEvent => {
        painted = true
        lastPaintAt = now
        lastPaintSize = size()
        return { type: "replace", id, html: renderPartSection({ ...part, children, provisional }) }
      }

      const shouldPaint = (now: number) => {
        if (!painted) return true
        const since = now - lastPaintAt
        if (since < options.paintMinIntervalMs) return false
        return size() >= lastPaintSize * options.paintGrowth || since >= options.paintMaxQuietMs
      }

      const accept = (raw: string) =>
        Effect.map(prepare(raw), (clean) => {
          for (const block of normalizeBlocks(clean)) children.push(wrapTable(block))
          provisional = undefined
          provisionalChildren = 0
        })

      const onDelta = Effect.fn("Converter.partDelta")(function*(delta: string) {
        const { blocks, rest } = extractBlocks(buffer + delta)
        buffer = rest
        let grew = blocks.length > 0
        for (const raw of blocks) yield* accept(raw)
        // Paint the finished rows of a table that has not closed yet, instead of waiting for `</table>`.
        const tail = provisionalTail(buffer)
        if (tail && tail.children > provisionalChildren) {
          const split = extractBlocks(yield* prepare(tail.html))
          if (split.blocks.length === 1 && !split.rest.trim() && isCompleteElement(split.blocks[0]!)) {
            provisional = wrapTable(split.blocks[0]!)
            provisionalChildren = tail.children
            grew = true
          }
        }
        if (!grew) return []
        const now = yield* Clock.currentTimeMillis
        return shouldPaint(now) ? [paint(now)] : []
      })

      const finish = Effect.gen(function*() {
        const trailing = stripFence(buffer).trim()
        buffer = ""
        if (trailing) yield* accept(trailing)
        provisional = undefined
        return [paint(yield* Clock.currentTimeMillis)]
      })

      return parser.parse({ source, part }).pipe(
        failIfIdle(options, `${part.unit} ${part.index}`),
        Stream.mapEffect(onDelta),
        Stream.concat(Stream.fromEffect(finish)),
        Stream.flattenIterable
      )
    })

  const splitStream = (split: Split, options: ConvertOptions): Stream.Stream<ConvertEvent> => {
    const unit = UNIT_RE.test(split.unit) ? split.unit : "part"
    const total = split.count
    const indexes = Array.from({ length: total }, (_, i) => i + 1)
    const retrySchedule = Schedule.max([
      Schedule.min([Schedule.exponential(600), Schedule.spaced(5_000)]),
      Schedule.recurs(options.retries)
    ])
    const failed = (index: number, reason: string): Stream.Stream<ConvertEvent> =>
      Stream.succeed({
        type: "replace",
        id: partBlockId(unit, index),
        html: renderPartSection({
          unit,
          index,
          total,
          children: [],
          error: `${unit.charAt(0).toUpperCase() + unit.slice(1)} ${index} could not be converted. ${reason}`
        })
      })

    const partStream = (index: number): Stream.Stream<ConvertEvent> =>
      Stream.unwrap(
        Effect.map(split.part(index), (source) =>
          partAttempt(source, { unit, index, total }, options).pipe(Stream.retry(retrySchedule)))
      ).pipe(
        Stream.catchTags({
          SplitError: (error) => failed(index, error.message),
          HtmlStreamError: (error) => failed(index, error.message),
          ParserIdleError: (error) => failed(index, error.message),
          SanitizeError: () => failed(index, "Its output could not be sanitized."),
          PostParseError: (error) => failed(index, error.message)
        })
      )

    const scaffolds = Stream.fromIterable(indexes.map((index): ConvertEvent => ({
      type: "append",
      id: partBlockId(unit, index),
      html: renderPartSection({ unit, index, total, children: [] })
    })))

    return scaffolds.pipe(
      Stream.concat(Stream.succeed<ConvertEvent>({
        type: "progress",
        phase: `Converting ${total} ${unit}${total === 1 ? "" : "s"}`
      })),
      Stream.concat(Stream.fromIterable(indexes).pipe(Stream.flatMap(partStream, { concurrency: options.concurrency })))
    )
  }

  const convert = (source: Source, overrides?: Partial<ConvertOptions>): Stream.Stream<ConvertEvent, ConvertError> =>
    Stream.unwrap(Effect.gen(function*() {
      const options: ConvertOptions = { ...defaultOptions, ...overrides }
      // `split` needs a splittable source. `auto` and `whole` fall back to parsing the source as it is.
      const split = options.mode === "split"
        ? yield* splitter.split(source)
        : yield* splitter.split(source).pipe(Effect.orElseSucceed(() => Option.none<Split>()))
      if (options.mode === "split" && Option.isNone(split)) {
        return yield* new SplitError({ message: `No splitter is available for ${source.mediaType}.` })
      }
      if (Option.isSome(split) && split.value.count > options.maxParts) {
        const { count, unit } = split.value
        return yield* new PartLimitError({
          count,
          maxParts: options.maxParts,
          message: `The document has ${count} ${unit}s; the limit is ${options.maxParts}.`
        })
      }
      if (Option.isSome(split) && (options.mode === "split" || (options.mode === "auto" && split.value.count > 1))) {
        return splitStream(split.value, options)
      }
      return Stream.succeed<ConvertEvent>({ type: "progress", phase: "Parsing" }).pipe(
        Stream.concat(wholeStream(source, options))
      )
    })).pipe(Stream.withSpan("Converter.convert", { attributes: { mediaType: source.mediaType } }))

  const render = (source: Source, overrides?: Partial<ConvertOptions>) => toDocument(convert(source, overrides))

  return Converter.of({ convert, render })
})

export class Converter extends Context.Service<Converter, {
  readonly convert: (source: Source, options?: Partial<ConvertOptions>) => Stream.Stream<ConvertEvent, ConvertError>
  readonly render: (
    source: Source,
    options?: Partial<ConvertOptions>
  ) => Effect.Effect<DocumentState, ConvertError | ContractError>
}>()("parser-stream/Converter") {
  /** Requires `HtmlStream`, `Sanitizer`, and `Splitter`. */
  static readonly layerNoDeps = Layer.effect(Converter, make)

  /**
   * Requires `HtmlStream` and `Sanitizer` (pick the one for your runtime:
   * `node/Sanitizer` or `workers/Sanitizer`). Splits PDFs into pages.
   */
  static readonly layer = this.layerNoDeps.pipe(Layer.provide(PdfSplitter.layer))
}

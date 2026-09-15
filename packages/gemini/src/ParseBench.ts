import * as ParseBench from "@parser-stream/parsebench"
import { Config, Effect, Layer, Option, type Redacted, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { Credential } from "parser-stream/Credential"
import { extractBlocks } from "parser-stream/domain/Html"
import { HtmlStream, HtmlStreamError, type HtmlStreamRequest, type PartRef } from "parser-stream/HtmlStream"
import type { Source } from "parser-stream/Source"
import * as Transport from "./Transport.js"

/**
 * Gemini Flash plus the ParseBench layout contract: the parser this project
 * ships. The transport is here, the contract is in `@parser-stream/parsebench`,
 * and the core knows neither.
 */

export const DEFAULT_MODEL = "gemini-3-flash-preview"
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
/** The layout pass runs best with room to think. This is the budget our benchmark runs use. */
export const DEFAULT_THINKING_BUDGET = 32_768

export interface GeminiFlashParseBenchOptions extends ParseBench.RenderOptions {
  /** Used when a conversion brings no `Credential`. */
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly model?: string | undefined
  readonly baseUrl?: string | undefined
  readonly maxOutputTokens?: number | undefined
  readonly thinkingBudget?: number | undefined
}

/** The typed element stream: labels and boxes, before any HTML. */
export const elements = (
  source: Source,
  options: GeminiFlashParseBenchOptions & {
    readonly apiKey: Redacted.Redacted<string>
    readonly part?: PartRef | undefined
  }
): Stream.Stream<ParseBench.LayoutElement, HtmlStreamError, HttpClient.HttpClient> =>
  Stream.suspend(() => {
    let buffer = ""
    const { prompt, systemInstruction } = ParseBench.promptsFor(options.part)
    return Transport.stream({
      parser: "gemini-parsebench",
      apiKey: options.apiKey,
      model: options.model ?? DEFAULT_MODEL,
      baseUrl: options.baseUrl,
      source,
      systemInstruction,
      prompt,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: options.thinkingBudget ?? DEFAULT_THINKING_BUDGET }
      }
    }).pipe(
      Stream.map((delta) => {
        const { blocks, rest } = extractBlocks(buffer + delta)
        buffer = rest
        return blocks
      }),
      Stream.concat(Stream.fromEffect(Effect.sync(() => {
        const tail = buffer.trim()
        buffer = ""
        return tail ? [tail] : []
      }))),
      Stream.flattenIterable,
      Stream.mapEffect(ParseBench.decodeDiv)
    )
  })

/** Build the parser. Requires an `HttpClient`. */
export const make = Effect.fn("GeminiFlashParseBench.make")(function*(options: GeminiFlashParseBenchOptions) {
  const client = yield* HttpClient.HttpClient
  const model = options.model ?? DEFAULT_MODEL

  const parse = (request: HtmlStreamRequest): Stream.Stream<string, HtmlStreamError> =>
    Stream.unwrap(Effect.gen(function*() {
      const supplied = yield* Credential
      const apiKey = Option.getOrUndefined(supplied) ?? options.apiKey
      if (!apiKey) {
        return Stream.fail(
          new HtmlStreamError({
            parser: "gemini-parsebench",
            message: "No Gemini API key. Bring your own key, or set GEMINI_API_KEY on the server."
          })
        )
      }
      return ParseBench.toHtml(elements(request.source, { ...options, apiKey, part: request.part }), options)
    })).pipe(
      Stream.provideService(HttpClient.HttpClient, client),
      Stream.withSpan("GeminiFlashParseBench.parse", {
        attributes: { model, mediaType: request.source.mediaType, part: request.part?.index }
      })
    )

  return HtmlStream.of({ name: `gemini-parsebench:${model}`, parse })
})

export const layer = (
  options: GeminiFlashParseBenchOptions = {}
): Layer.Layer<HtmlStream, never, HttpClient.HttpClient> => Layer.effect(HtmlStream, make(options))

/** Layer from the optional `GEMINI_API_KEY` and `GEMINI_MODEL`. */
export const layerConfig: Layer.Layer<HtmlStream, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(
  HtmlStream,
  Effect.gen(function*() {
    const apiKey = yield* Config.option(Config.Redacted("GEMINI_API_KEY"))
    const model = yield* Config.String("GEMINI_MODEL").pipe(Config.withDefault(DEFAULT_MODEL))
    return yield* make({ apiKey: Option.getOrUndefined(apiKey), model })
  })
)

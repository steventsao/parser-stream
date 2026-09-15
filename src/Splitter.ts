import { Context, Effect, Layer, Option, Schema } from "effect"
import type { Source } from "./Source.js"

/**
 * Optional port: cut a source into parts that can be parsed in parallel, for
 * example the pages of a PDF. A splitter returns `None` for sources it does not
 * understand, and the converter then parses them whole.
 */

export class SplitError extends Schema.TaggedError<SplitError>()("SplitError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export interface Split {
  /** What one part is called, for example `page` or `slide`. Lowercase: it becomes part of block ids. */
  readonly unit: string
  readonly count: number
  /** Part `index` (1-based) as a source of its own. */
  readonly part: (index: number) => Effect.Effect<Source, SplitError>
}

export class Splitter extends Context.Service<Splitter, {
  readonly split: (source: Source) => Effect.Effect<Option.Option<Split>, SplitError>
}>()("parser-stream/Splitter") {
  /** Never split: every source is parsed whole. */
  static readonly none: Layer.Layer<Splitter> = Layer.succeed(Splitter)(Splitter.of({
    split: () => Effect.succeed(Option.none())
  }))
}

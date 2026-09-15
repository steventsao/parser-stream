import { Context, Layer, type Redacted, Schema, type Stream } from "effect"
import type { Source } from "./Source.js"

/**
 * The one port you implement to bring your own parser.
 *
 * A parser turns a `Source` (bytes + media type) into a stream of HTML text.
 * Chunks can split anywhere, even mid-tag: the converter buffers them, cuts out
 * complete top-level blocks, sanitizes each block, and assigns ids. A parser
 * that does not stream can emit its whole output as one chunk.
 *
 * Interruption is structured: when the converter gives up on a request (idle
 * timeout, retry, or a closed client) the stream is interrupted, so release
 * resources with `Stream.ensuring` or `Effect.acquireRelease`.
 */

/** Set when the source is one part (for example one page) of a larger document. */
export interface PartRef {
  /** What a part is called, for example `page`. */
  readonly unit: string
  /** 1-based position in the original document. */
  readonly index: number
  readonly total: number
}

export interface ParseRequest {
  readonly source: Source
  /** Default instruction for vision-language models. Other parsers can ignore it. */
  readonly prompt: string
  readonly part: PartRef | undefined
  /**
   * A secret the caller supplied for this conversion only, for example their
   * own API key. Prefer it over a key the parser was configured with.
   */
  readonly credential: Redacted.Redacted<string> | undefined
}

export class ParserError extends Schema.TaggedError<ParserError>()("ParserError", {
  parser: Schema.String,
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

export class Parser extends Context.Service<Parser, {
  /** Short identifier for logs and error messages. */
  readonly name: string
  readonly parse: (request: ParseRequest) => Stream.Stream<string, ParserError>
}>()("parser-stream/Parser") {
  /** Build a parser layer from a plain function. */
  static readonly fromFunction = (
    name: string,
    parse: (request: ParseRequest) => Stream.Stream<string, ParserError>
  ): Layer.Layer<Parser> => Layer.succeed(Parser)(Parser.of({ name, parse }))
}

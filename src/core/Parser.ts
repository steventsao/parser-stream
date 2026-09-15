import { Context, Layer, Schema, type Stream } from "effect"
import type { Source } from "./Source.js"

/**
 * The one port you implement to bring your own parser.
 *
 * A parser turns a `Source` (bytes + media type) into a stream of HTML text.
 * Chunks can split anywhere, even mid-tag: the converter buffers them, cuts out
 * complete top-level blocks, sanitizes each block, and assigns ids. A parser
 * that does not stream can emit its whole output as one chunk.
 *
 * The parser owns everything specific to it: its prompt, the shape it asks for,
 * how it decodes that shape, which HTML tags the result uses, and which
 * credentials it needs (see `ParserCredential`). The library never assumes a
 * heading, a paragraph, or an API key.
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
  /** Present when the source is one part of a larger document, absent for the whole thing. */
  readonly part: PartRef | undefined
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

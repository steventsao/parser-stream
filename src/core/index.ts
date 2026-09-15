/**
 * The core: the parser port, the streaming DOM engine, and the document input
 * it understands.
 *
 * It holds the block contract (cut, sanitize, number), the document reducer,
 * the event stream, the ports a parser plugs into, and PDF page splitting,
 * which is common enough to belong here. It has no HTTP, no sessions, no
 * storage, and no transport, so you can build your own app on it.
 *
 * - concrete parsers: `parser-stream/parsers`
 * - live sessions, HTTP routes, and a plain UI: `parser-stream/app`
 */
export {
  ContractError,
  type ConvertError,
  type ConvertOptions,
  Converter,
  defaultOptions,
  type Mode,
  PartLimitError,
  ParserIdleError,
  step,
  toDocument
} from "./Converter.js"
export * as Document from "./domain/Document.js"
export * as Events from "./domain/Events.js"
export * as Html from "./domain/Html.js"
export { Parser, ParserError, type ParseRequest, type PartRef } from "./Parser.js"
export * as ParserCredential from "./ParserCredential.js"
export {
  type RewriterComment,
  type RewriterElement,
  SanitizeError,
  Sanitizer,
  sanitizerHandlers
} from "./Sanitizer.js"
export * as Source from "./Source.js"
export * as PdfSplitter from "./splitters/Pdf.js"
export { type Split, SplitError, Splitter } from "./Splitter.js"

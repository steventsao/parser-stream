/**
 * `parser-stream` — the core: the `HtmlStream` port and the streaming DOM engine.
 *
 * It holds the block contract (cut, sanitize, number), the document reducer,
 * the event stream, the ports a plugin plugs into, and PDF page splitting,
 * which is common enough to belong here. It has no HTTP, no sessions, no
 * storage, and no transport.
 *
 * Plugins live in their own packages (`@parser-stream/gemini`,
 * `@parser-stream/openai-compatible`, `@parser-stream/http`, ...), and one app
 * over this core is `@parser-stream/app`.
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
export * as Credential from "./Credential.js"
export * as Document from "./domain/Document.js"
export * as Events from "./domain/Events.js"
export * as Html from "./domain/Html.js"
export * as HtmlHandlers from "./HtmlHandlers.js"
export { HtmlStream, HtmlStreamError, type HtmlStreamRequest, type PartRef } from "./HtmlStream.js"
export {
  type RewriterComment,
  type RewriterElement,
  type RewriterText,
  SanitizeError,
  Sanitizer,
  sanitizerHandlers
} from "./Sanitizer.js"
export * as Source from "./Source.js"
export * as PdfSplitter from "./splitters/Pdf.js"
export { type Split, SplitError, Splitter } from "./Splitter.js"

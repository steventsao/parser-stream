/**
 * `@parser-stream/gemini` — the Gemini plugins.
 *
 * - `GeminiFlashParseBenchParser`: Gemini Flash running the ParseBench layout
 *   contract, with labels and bounding boxes. This is the parser the project ships.
 * - `GeminiHtmlParser`: asks Gemini for semantic HTML directly. Cheaper, no boxes on text.
 * - `GeminiTransport`: the shared streaming transport both use.
 */
export * as GeminiFlashParseBenchParser from "./ParseBench.js"
export * as GeminiHtmlParser from "./Html.js"
export * as GeminiTransport from "./Transport.js"

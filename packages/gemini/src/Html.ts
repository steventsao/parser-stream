import { Config, Effect, Layer, Option, type Redacted, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { HtmlStream, HtmlStreamError, type HtmlStreamRequest, type PartRef } from "parser-stream/HtmlStream"
import { Credential } from "parser-stream/Credential"
import * as GeminiTransport from "./Transport.js"

/**
 * Asks Gemini for semantic HTML directly, block by block. Simpler and cheaper
 * than the layout pass in `ParseBench.ts`, with no bounding boxes on text.
 *
 * The prompts live here, not in the library: which tags the output uses is this
 * parser's decision, and so is the key it needs.
 */

export const DEFAULT_MODEL = "gemini-3-flash-preview"

export const HTML_PROMPT = "Convert this document into a clean, semantic HTML web page. Output ONLY HTML block " +
  "elements (<h1>,<h2>,<h3>,<p>,<ul>,<ol>,<table> with <thead>/<tbody>/<th scope>, <figure>) in natural " +
  "reading order. No <html>/<head>/<body> wrapper, no markdown code fences, no page headers, footers, or " +
  "page numbers. Faithfully preserve headings, lists, and tables. " +
  "For every chart, graph, diagram, map, photo or other figure, emit a top-level " +
  "<figure data-page=\"P\" data-bbox=\"ymin,xmin,ymax,xmax\"> whose <figcaption> describes the figure in one " +
  "informative sentence usable as alt text. P is the 1-based page number (1 for a single image); " +
  "ymin,xmin,ymax,xmax are four integers 0-1000 normalized to that page or image. The bbox must cover the " +
  "figure itself, its title, and its legend, and must stop before prose captions and any line beginning Note " +
  "or Source. If a chart has underlying data, ALSO emit the data as a following <table>. " +
  "Do NOT wrap blocks in <div> and do NOT nest figures. Start immediately with the first block."

const partPrompt = (part: PartRef) =>
  `${HTML_PROMPT} This is ${part.unit} ${part.index} of ${part.total} of a larger document, provided on its own. ` +
  `Convert ONLY what is in this ${part.unit}: do not invent a document title, a table of contents, or any ` +
  "heading that is not printed here. If it opens mid-sentence, mid-list or mid-table, continue it as the same " +
  "kind of block rather than restating a heading. " +
  (part.index > 1 ? "Do NOT repeat a running header or the document title carried over from earlier parts. " : "") +
  (part.unit === "page" ? `For every <figure>, set data-page="${part.index}".` : "")

export interface GeminiOptions {
  /** Used when a conversion brings no `Credential`. */
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly model?: string | undefined
  readonly baseUrl?: string | undefined
}

/** Build the parser. Requires an `HttpClient`. */
export const make = Effect.fn("GeminiParser.make")(function*(options: GeminiOptions) {
  const client = yield* HttpClient.HttpClient
  const model = options.model ?? DEFAULT_MODEL

  const parse = (request: HtmlStreamRequest): Stream.Stream<string, HtmlStreamError> =>
    Stream.unwrap(Effect.gen(function*() {
      const supplied = yield* Credential
      const apiKey = Option.getOrUndefined(supplied) ?? options.apiKey
      if (!apiKey) {
        return Stream.fail(
          new HtmlStreamError({
            parser: "gemini",
            message: "No Gemini API key. Bring your own key, or set GEMINI_API_KEY on the server."
          })
        )
      }
      return GeminiTransport.stream({
        parser: "gemini",
        apiKey,
        model,
        baseUrl: options.baseUrl,
        source: request.source,
        prompt: request.part ? partPrompt(request.part) : HTML_PROMPT,
        generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel: "low" } }
      })
    })).pipe(
      Stream.provideService(HttpClient.HttpClient, client),
      Stream.withSpan("GeminiParser.parse", {
        attributes: { model, mediaType: request.source.mediaType, part: request.part?.index }
      })
    )

  return HtmlStream.of({ name: `gemini:${model}`, parse })
})

export const layer = (options: GeminiOptions = {}): Layer.Layer<HtmlStream, never, HttpClient.HttpClient> =>
  Layer.effect(HtmlStream, make(options))

/** HtmlStream layer from the optional `GEMINI_API_KEY` and `GEMINI_MODEL`. */
export const layerConfig: Layer.Layer<HtmlStream, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(
  HtmlStream,
  Effect.gen(function*() {
    const apiKey = yield* Config.option(Config.Redacted("GEMINI_API_KEY"))
    const model = yield* Config.String("GEMINI_MODEL").pipe(Config.withDefault(DEFAULT_MODEL))
    return yield* make({ apiKey: Option.getOrUndefined(apiKey), model })
  })
)

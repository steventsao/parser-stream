import { Config, Effect, Encoding, Layer, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HtmlStream, HtmlStreamError, type HtmlStreamRequest } from "parser-stream/HtmlStream"
import { Credential } from "parser-stream/Credential"
import type { Source } from "parser-stream/Source"
import * as Markdown from "@parser-stream/markdown"
import * as ParseBench from "@parser-stream/parsebench"

/**
 * Any OpenAI-compatible chat server: vLLM, Ollama, LM Studio, llama.cpp, or a
 * hosted API that speaks the same shape. This is how the open-weight document
 * VLMs run (Qwen3-VL, dots.ocr, Infinity-Parser2, DeepSeek-OCR, Gemma).
 *
 * Two prompt modes, the same two those models are benchmarked with:
 *
 * - `markdown`: ask for markdown with HTML tables, then render it here.
 * - `layout`: ask for one `<div data-bbox data-label>` per element, then reuse
 *   the ParseBench decoder and renderer.
 *
 * These servers take **images**, not PDFs. Give this parser an image source, or
 * a `Splitter` that rasterizes pages into images.
 */

export type PromptMode = "markdown" | "layout"

export const MARKDOWN_PROMPT = "Convert this document image to clean, well-structured markdown. " +
  "Preserve headings, paragraphs, lists, and reading order. " +
  "Convert tables to HTML (<table>, <tr>, <th>, <td>), using colspan and rowspan for merged cells. " +
  "For charts and graphs, emit the data as an HTML table with flat combined column headers. " +
  "Describe images and figures briefly in square brackets, like [Figure: description]. " +
  "Do not add commentary: output only the parsed content."

export interface OpenAiCompatibleOptions {
  /** For example `http://127.0.0.1:11434/v1` (Ollama) or `http://127.0.0.1:8000/v1` (vLLM). */
  readonly baseUrl: string
  readonly model: string
  /** Most local servers need none. */
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly mode?: PromptMode | undefined
  readonly prompt?: string | undefined
  readonly systemPrompt?: string | undefined
  readonly maxTokens?: number | undefined
  readonly temperature?: number | undefined
  /** Layout mode only: keep running headers and footers. */
  readonly keepPageFurniture?: boolean | undefined
}

const StreamChunk = Schema.Struct({
  choices: Schema.optionalKey(Schema.Array(Schema.Struct({
    delta: Schema.optionalKey(Schema.Struct({ content: Schema.optionalKey(Schema.String) })),
    message: Schema.optionalKey(Schema.Struct({ content: Schema.optionalKey(Schema.String) }))
  })))
})

const decodeChunk = Schema.decodeUnknownEffect(Schema.fromJsonString(StreamChunk))

const chunkText = (chunk: typeof StreamChunk.Type): string => {
  const choice = chunk.choices?.[0]
  return choice?.delta?.content ?? choice?.message?.content ?? ""
}

const dataUrl = (source: Source) => `data:${source.mediaType};base64,${Encoding.encodeBase64(source.bytes)}`

/** Text deltas from `/chat/completions`. */
const textStream = (
  request: HtmlStreamRequest,
  options: OpenAiCompatibleOptions,
  apiKey: Redacted.Redacted<string> | undefined
): Stream.Stream<string, HtmlStreamError, HttpClient.HttpClient> => {
  const fail = (message: string) => new HtmlStreamError({ parser: "openai-compatible", message })
  return Stream.unwrap(Effect.gen(function*() {
    if (!request.source.mediaType.startsWith("image/")) {
      return Stream.fail(
        fail(
          `This server takes images, not ${request.source.mediaType}. ` +
            "Send an image source, or add a Splitter that rasterizes pages into images."
        )
      )
    }
    const client = yield* HttpClient.HttpClient
    const mode = options.mode ?? "markdown"
    const system = options.systemPrompt ?? (mode === "layout" ? ParseBench.SYSTEM_PROMPT : undefined)
    const prompt = options.prompt ?? (mode === "layout" ? ParseBench.USER_PROMPT : MARKDOWN_PROMPT)
    let httpRequest = HttpClientRequest.post(`${options.baseUrl.replace(/\/$/, "")}/chat/completions`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        model: options.model,
        stream: true,
        temperature: options.temperature ?? 0,
        ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: dataUrl(request.source) } }
            ]
          }
        ]
      })
    )
    if (apiKey) httpRequest = HttpClientRequest.bearerToken(httpRequest, Redacted.value(apiKey))
    const response = yield* client.execute(httpRequest).pipe(
      Effect.mapError((error) => fail(`Request to the model server failed: ${error.message}`))
    )
    if (response.status < 200 || response.status >= 300) {
      const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
      return yield* fail(`The model server returned HTTP ${response.status}: ${detail.slice(0, 300)}`)
    }
    return response.stream.pipe(
      Stream.mapError((error) => fail(`The model stream failed: ${error.message}`)),
      Stream.decodeText,
      Stream.splitLines,
      Stream.filter((line) => line.startsWith("data:")),
      Stream.map((line) => line.slice(5).trim()),
      Stream.filter((json) => json.length > 0 && json !== "[DONE]"),
      Stream.mapEffect((json) =>
        decodeChunk(json).pipe(Effect.mapError(() => fail("The server sent a stream event that is not valid JSON.")))
      ),
      Stream.map(chunkText),
      Stream.filter((text) => text.length > 0)
    )
  }))
}

/** Build the parser. Requires an `HttpClient`. */
export const make = Effect.fn("OpenAiCompatibleParser.make")(function*(options: OpenAiCompatibleOptions) {
  const client = yield* HttpClient.HttpClient
  const mode = options.mode ?? "markdown"

  const parse = (request: HtmlStreamRequest): Stream.Stream<string, HtmlStreamError> =>
    Stream.unwrap(Effect.gen(function*() {
      const supplied = yield* Credential
      const apiKey = Option.getOrUndefined(supplied) ?? options.apiKey
      const text = textStream(request, options, apiKey)
      const attributes = request.part?.unit === "page" ? ` data-page="${request.part.index}"` : ""
      return mode === "layout"
        ? ParseBench.toHtml(Stream.mapEffect(text, ParseBench.decodeDiv), options)
        : Markdown.fromMarkdown(text, { attributes })
    })).pipe(
      Stream.provideService(HttpClient.HttpClient, client),
      Stream.withSpan("OpenAiCompatibleParser.parse", {
        attributes: { model: options.model, mode, mediaType: request.source.mediaType }
      })
    )

  return HtmlStream.of({ name: `openai-compatible:${options.model}`, parse })
})

export const layer = (
  options: OpenAiCompatibleOptions
): Layer.Layer<HtmlStream, never, HttpClient.HttpClient> => Layer.effect(HtmlStream, make(options))

/**
 * The same parser, with its settings read from configuration. Defaults to
 * `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_API_KEY`, and `PARSER_MODE`; pass
 * your own `Config` values to read them from somewhere else.
 */
export const layerConfig = (
  options?: {
    readonly baseUrl?: Config.Config<string> | undefined
    readonly model?: Config.Config<string> | undefined
    readonly apiKey?: Config.Config<Redacted.Redacted<string> | undefined> | undefined
    readonly mode?: Config.Config<PromptMode> | undefined
  }
): Layer.Layer<HtmlStream, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    HtmlStream,
    Effect.gen(function*() {
      const baseUrl = options?.baseUrl ? yield* options.baseUrl : yield* Config.String("OPENAI_BASE_URL")
      const model = options?.model ? yield* options.model : yield* Config.String("OPENAI_MODEL")
      const apiKey = options?.apiKey
        ? yield* options.apiKey
        : Option.getOrUndefined(yield* Config.option(Config.Redacted("OPENAI_API_KEY")))
      const mode = options?.mode
        ? yield* options.mode
        : yield* Config.Literals(["markdown", "layout"], "PARSER_MODE").pipe(Config.withDefault("markdown"))
      return yield* make({ baseUrl, model, apiKey, mode })
    })
  )

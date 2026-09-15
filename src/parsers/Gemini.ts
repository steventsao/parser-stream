import { Config, Effect, Encoding, Layer, Option, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser, ParserError, type ParseRequest } from "../Parser.js"

/**
 * Gemini reads the source natively (PDF, images, text, ...) and streams HTML
 * over SSE. Bring your own key: per request (`ParseRequest.credential`) or for
 * the whole server (`GEMINI_API_KEY`). `GEMINI_MODEL` is optional.
 */

export const DEFAULT_MODEL = "gemini-3-flash-preview"
export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

export interface GeminiOptions {
  /** Used when a request brings no key of its own. */
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly model?: string | undefined
  readonly baseUrl?: string | undefined
}

const StreamChunk = Schema.Struct({
  candidates: Schema.optional(Schema.Array(Schema.Struct({
    content: Schema.optional(Schema.Struct({
      parts: Schema.optional(Schema.Array(Schema.Struct({
        text: Schema.optional(Schema.String),
        thought: Schema.optional(Schema.Boolean)
      })))
    }))
  })))
})

const decodeChunk = Schema.decodeUnknownEffect(Schema.fromJsonString(StreamChunk))

const chunkText = (chunk: typeof StreamChunk.Type): string =>
  (chunk.candidates?.[0]?.content?.parts ?? [])
    .filter((part) => part.thought !== true)
    .map((part) => part.text ?? "")
    .join("")

const fail = (message: string) => new ParserError({ parser: "gemini", message })

/** Build a Gemini parser. Requires an `HttpClient`. */
export const make = Effect.fn("GeminiParser.make")(function*(options: GeminiOptions) {
  const client = yield* HttpClient.HttpClient
  const model = options.model ?? DEFAULT_MODEL
  const url = `${options.baseUrl ?? DEFAULT_BASE_URL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`

  const parse = (request: ParseRequest): Stream.Stream<string, ParserError> =>
    Stream.unwrap(Effect.gen(function*() {
      const apiKey = request.credential ?? options.apiKey
      if (!apiKey) return yield* fail("No Gemini API key. Bring your own key, or set GEMINI_API_KEY on the server.")
      const httpRequest = HttpClientRequest.post(url).pipe(
        // The key travels in a header, never in the URL, so it cannot leak into logs or error messages.
        HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(apiKey)),
        HttpClientRequest.bodyJsonUnsafe({
          contents: [{
            parts: [
              {
                inline_data: {
                  mime_type: request.source.mediaType,
                  data: Encoding.encodeBase64(request.source.bytes)
                }
              },
              { text: request.prompt }
            ]
          }],
          generationConfig: { temperature: 0, thinkingConfig: { thinkingLevel: "low" } }
        })
      )
      const response = yield* client.execute(httpRequest).pipe(
        Effect.mapError((error) => fail(`Request to Gemini failed: ${error.message}`))
      )
      if (response.status < 200 || response.status >= 300) {
        const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* fail(`Gemini returned HTTP ${response.status}: ${detail.slice(0, 300)}`)
      }
      return response.stream.pipe(
        Stream.mapError((error) => fail(`Gemini stream failed: ${error.message}`)),
        Stream.decodeText,
        Stream.splitLines,
        Stream.filter((line) => line.startsWith("data:")),
        Stream.map((line) => line.slice(5).trim()),
        Stream.filter((json) => json.length > 0 && json !== "[DONE]"),
        Stream.mapEffect((json) =>
          decodeChunk(json).pipe(Effect.mapError(() => fail("Gemini sent a stream event that is not valid JSON.")))
        ),
        Stream.map(chunkText),
        Stream.filter((text) => text.length > 0)
      )
    })).pipe(
      Stream.withSpan("GeminiParser.parse", {
        attributes: { model, mediaType: request.source.mediaType, part: request.part?.index }
      })
    )

  return Parser.of({ name: `gemini:${model}`, parse })
})

/** Gemini parser layer from explicit options. */
export const layer = (options: GeminiOptions): Layer.Layer<Parser, never, HttpClient.HttpClient> =>
  Layer.effect(Parser, make(options))

/** Gemini parser layer from the optional `GEMINI_API_KEY` and `GEMINI_MODEL`. */
export const layerConfig: Layer.Layer<Parser, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(
  Parser,
  Effect.gen(function*() {
    const apiKey = yield* Config.option(Config.Redacted("GEMINI_API_KEY"))
    const model = yield* Config.String("GEMINI_MODEL").pipe(Config.withDefault(DEFAULT_MODEL))
    return yield* make({ apiKey: Option.getOrUndefined(apiKey), model })
  })
)

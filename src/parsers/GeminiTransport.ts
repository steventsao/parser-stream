import { Effect, Encoding, Redacted, Schema, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { ParserError } from "../core/Parser.js"
import type { Source } from "../core/Source.js"

/**
 * Shared Gemini streaming transport. It carries bytes and prompts to the
 * model and hands back raw text deltas. It holds no opinion about the output
 * format: each parser owns its prompt and its own decoding.
 */

export const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta"

export interface GeminiRequest {
  readonly parser: string
  readonly apiKey: Redacted.Redacted<string>
  readonly model: string
  readonly baseUrl?: string | undefined
  readonly source: Source
  readonly systemInstruction?: string | undefined
  readonly prompt: string
  readonly generationConfig?: Record<string, unknown> | undefined
}

const StreamChunk = Schema.Struct({
  candidates: Schema.optionalKey(Schema.Array(Schema.Struct({
    content: Schema.optionalKey(Schema.Struct({
      parts: Schema.optionalKey(Schema.Array(Schema.Struct({
        text: Schema.optionalKey(Schema.String),
        thought: Schema.optionalKey(Schema.Boolean)
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

/** Text deltas from `streamGenerateContent`, in arrival order. */
export const stream = (request: GeminiRequest): Stream.Stream<string, ParserError, HttpClient.HttpClient> => {
  const fail = (message: string) => new ParserError({ parser: request.parser, message })
  return Stream.unwrap(Effect.gen(function*() {
    const client = yield* HttpClient.HttpClient
    const url = `${request.baseUrl ?? DEFAULT_BASE_URL}/models/${
      encodeURIComponent(request.model)
    }:streamGenerateContent?alt=sse`
    const httpRequest = HttpClientRequest.post(url).pipe(
      // The key travels in a header, never in the URL, so it cannot leak into logs or error messages.
      HttpClientRequest.setHeader("x-goog-api-key", Redacted.value(request.apiKey)),
      HttpClientRequest.bodyJsonUnsafe({
        ...(request.systemInstruction ? { systemInstruction: { parts: [{ text: request.systemInstruction }] } } : {}),
        contents: [{
          role: "user",
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
        generationConfig: request.generationConfig ?? { temperature: 0 }
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
  }))
}

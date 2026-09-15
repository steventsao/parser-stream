import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import * as GeminiParser from "../src/parsers/Gemini.js"
import { Parser } from "../src/Parser.js"
import { imageSource } from "./fixtures.js"

interface Captured {
  url?: string
  headers?: Record<string, string>
}

const fakeGemini = (captured: Captured, response: () => Response) =>
  Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request, url) => {
    captured.url = url.toString()
    captured.headers = { ...request.headers }
    return Effect.succeed(HttpClientResponse.fromWeb(request, response()))
  }))

const sse = (...texts: Array<string>) =>
  new Response(
    texts.map((text) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\r\n\r\n`)
      .join("") + `data: ${JSON.stringify({ usageMetadata: { totalTokenCount: 1 } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  )

const parserLayer = (captured: Captured, response: () => Response) =>
  GeminiParser.layer({ apiKey: Redacted.make("test-key"), model: "gemini-test" }).pipe(
    Layer.provide(fakeGemini(captured, response))
  )

describe("GeminiParser", () => {
  const captured: Captured = {}

  it.effect("streams text out of SSE events, with the key in a header", () =>
    Effect.gen(function*() {
      const parser = yield* Parser
      const chunks = yield* Stream.runCollect(parser.parse({ source: imageSource, prompt: "convert", part: undefined }))
      assert.deepStrictEqual(chunks, ["<h1>Hi", "</h1>"])
      assert.strictEqual(
        captured.url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
      )
      assert.strictEqual(captured.headers?.["x-goog-api-key"], "test-key")
      assert.notInclude(captured.url ?? "", "test-key")
    }).pipe(Effect.provide(parserLayer(captured, () => sse("<h1>Hi", "</h1>")))))

  it.effect("turns an HTTP error into a ParserError", () =>
    Effect.gen(function*() {
      const parser = yield* Parser
      const error = yield* Stream.runDrain(parser.parse({ source: imageSource, prompt: "convert", part: undefined }))
        .pipe(Effect.flip)
      assert.strictEqual(error._tag, "ParserError")
      assert.include(error.message, "HTTP 429")
      assert.include(error.message, "quota")
    }).pipe(Effect.provide(parserLayer({}, () => new Response("quota exceeded", { status: 429 })))))
})

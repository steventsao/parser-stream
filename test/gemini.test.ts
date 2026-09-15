import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import * as GeminiParser from "../src/parsers/Gemini.js"
import { Parser, type ParseRequest } from "../src/Parser.js"
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

const parserLayer = (options: GeminiParser.GeminiOptions, captured: Captured, response: () => Response) =>
  GeminiParser.layer({ model: "gemini-test", ...options }).pipe(Layer.provide(fakeGemini(captured, response)))

const request = (credential?: string): ParseRequest => ({
  source: imageSource,
  prompt: "convert",
  part: undefined,
  credential: credential ? Redacted.make(credential) : undefined
})

const parse = Effect.fn("parse")(function*(input: ParseRequest) {
  const parser = yield* Parser
  return yield* Stream.runCollect(parser.parse(input))
})

describe("GeminiParser", () => {
  const configured: Captured = {}
  it.effect("streams text out of SSE events, with the key in a header", () =>
    Effect.gen(function*() {
      assert.deepStrictEqual(yield* parse(request()), ["<h1>Hi", "</h1>"])
      assert.strictEqual(
        configured.url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
      )
      assert.strictEqual(configured.headers?.["x-goog-api-key"], "server-key")
      assert.notInclude(configured.url ?? "", "server-key")
    }).pipe(Effect.provide(parserLayer({ apiKey: Redacted.make("server-key") }, configured, () => sse("<h1>Hi", "</h1>")))))

  const override: Captured = {}
  it.effect("prefers the caller's own key", () =>
    Effect.gen(function*() {
      yield* parse(request("caller-key"))
      assert.strictEqual(override.headers?.["x-goog-api-key"], "caller-key")
    }).pipe(Effect.provide(parserLayer({ apiKey: Redacted.make("server-key") }, override, () => sse("<p>x</p>")))))

  const keyless: Captured = {}
  it.effect("fails before any request when there is no key", () =>
    Effect.gen(function*() {
      const error = yield* parse(request()).pipe(Effect.flip)
      assert.include(error.message, "No Gemini API key")
      assert.isUndefined(keyless.url)
    }).pipe(Effect.provide(parserLayer({}, keyless, () => sse("<p>x</p>")))))

  it.effect("turns an HTTP error into a ParserError", () =>
    Effect.gen(function*() {
      const error = yield* parse(request("k")).pipe(Effect.flip)
      assert.strictEqual(error._tag, "ParserError")
      assert.include(error.message, "HTTP 429")
      assert.include(error.message, "quota")
    }).pipe(Effect.provide(parserLayer({}, {}, () => new Response("quota exceeded", { status: 429 })))))
})

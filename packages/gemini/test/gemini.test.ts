import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted, Stream } from "effect"
import { HtmlStream } from "parser-stream/HtmlStream"
import * as GeminiParser from "@parser-stream/gemini/Html"
import { type CapturedRequest, fakeGemini, geminiSse, imageSource, withKey } from "@parser-stream/testkit"

const collect = Effect.gen(function*() {
  const parser = yield* HtmlStream
  return yield* Stream.runCollect(parser.parse({ source: imageSource, part: undefined }))
})

const parserLayer = (
  options: GeminiParser.GeminiOptions,
  captured: CapturedRequest,
  response: () => Response
) => GeminiParser.layer({ model: "gemini-test", ...options }).pipe(Layer.provide(fakeGemini(captured, response)))

describe("GeminiParser", () => {
  it.effect("streams text out of SSE events, with the key in a header", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      assert.deepStrictEqual(yield* collect, ["<h1>Hi", "</h1>"])
      assert.strictEqual(
        captured.url,
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:streamGenerateContent?alt=sse"
      )
      assert.strictEqual(captured.headers?.["x-goog-api-key"], "server-key")
      assert.notInclude(captured.url ?? "", "server-key")
      assert.include(captured.body?.["contents"][0].parts[1].text, "semantic HTML")
    }).pipe(
      Effect.provide(
        parserLayer({ apiKey: Redacted.make("server-key") }, captured, () => geminiSse("<h1>Hi", "</h1>"))
      )
    )
  })

  it.effect("prefers the key the conversion brought", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      yield* withKey(collect, "caller-key")
      assert.strictEqual(captured.headers?.["x-goog-api-key"], "caller-key")
    }).pipe(
      Effect.provide(parserLayer({ apiKey: Redacted.make("server-key") }, captured, () => geminiSse("<p>x</p>")))
    )
  })

  it.effect("fails before any request when there is no key", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      const error = yield* collect.pipe(Effect.flip)
      assert.include(error.message, "No Gemini API key")
      assert.isUndefined(captured.url)
    }).pipe(Effect.provide(parserLayer({}, captured, () => geminiSse("<p>x</p>"))))
  })

  it.effect("turns an HTTP error into a HtmlStreamError", () =>
    Effect.gen(function*() {
      const error = yield* withKey(collect, "k").pipe(Effect.flip)
      assert.strictEqual(error._tag, "HtmlStreamError")
      assert.include(error.message, "HTTP 429")
      assert.include(error.message, "quota")
    }).pipe(Effect.provide(parserLayer({}, {}, () => new Response("quota exceeded", { status: 429 })))))
})

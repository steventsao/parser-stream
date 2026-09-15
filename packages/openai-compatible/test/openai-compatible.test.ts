import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { HtmlStream } from "parser-stream/HtmlStream"
import * as OpenAiCompatibleParser from "@parser-stream/openai-compatible"
import { type CapturedRequest, fakeGemini as fakeServer, imageSource, pdfSource, withKey } from "@parser-stream/testkit"

/** An OpenAI-compatible streaming body. */
const sse = (...texts: Array<string>) =>
  new Response(
    texts.map((text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`).join("") +
      "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } }
  )

const collect = (source = imageSource) =>
  Effect.gen(function*() {
    const parser = yield* HtmlStream
    return yield* Stream.runCollect(parser.parse({ source, part: undefined }))
  })

const parserLayer = (
  options: Partial<OpenAiCompatibleParser.OpenAiCompatibleOptions>,
  captured: CapturedRequest,
  response: () => Response
) =>
  OpenAiCompatibleParser.layer({
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3-vl-8b",
    ...options
  }).pipe(Layer.provide(fakeServer(captured, response)))

describe("OpenAiCompatibleParser", () => {
  it.effect("sends the image as a data URL and renders the markdown it streams", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      const html = yield* collect()
      assert.deepStrictEqual(html, ["<h1>Season Report</h1>", "<p>Turnout grew.</p>"])
      assert.strictEqual(captured.url, "http://127.0.0.1:11434/v1/chat/completions")
      assert.strictEqual(captured.body?.["stream"], true)
      assert.strictEqual(captured.body?.["model"], "qwen3-vl-8b")
      const content = captured.body?.["messages"][0].content
      assert.include(content[1].image_url.url, "data:image/png;base64,")
      assert.include(content[0].text, "markdown")
      // No key configured and none supplied: a local server needs no authorization.
      assert.isUndefined(captured.headers?.["authorization"])
    }).pipe(
      Effect.provide(parserLayer({}, captured, () => sse("# Season Rep", "ort\n\nTurnout grew.")))
    )
  })

  it.effect("uses the layout prompt and the ParseBench decoder in layout mode", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      const html = yield* collect()
      assert.deepStrictEqual(html, [`<h2 data-bbox="10,20,30,40">Findings</h2>`, "<p>Turnout grew.</p>"])
      assert.include(captured.body?.["messages"][0].content, "data-label=\"<category>\"")
    }).pipe(
      Effect.provide(parserLayer({ mode: "layout" }, captured, () =>
        sse(
          `<div data-label="Section-header" data-bbox="[10,20,30,40]">## Findings</div>`,
          `<div data-label="Text">Turnout grew.</div>`
        )))
    )
  })

  it.effect("sends the caller's key when there is one", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      yield* withKey(collect(), "local-token")
      assert.strictEqual(captured.headers?.["authorization"], "Bearer local-token")
    }).pipe(Effect.provide(parserLayer({}, captured, () => sse("text"))))
  })

  it.effect("refuses a PDF and says what to do instead", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      const error = yield* collect(yield* pdfSource(1)).pipe(Effect.flip)
      assert.strictEqual(error._tag, "HtmlStreamError")
      assert.include(error.message, "takes images")
      assert.include(error.message, "rasterizes pages")
      assert.isUndefined(captured.url)
    }).pipe(Effect.provide(parserLayer({}, captured, () => sse("text"))))
  })
})

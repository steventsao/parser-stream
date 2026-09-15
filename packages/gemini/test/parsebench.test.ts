import * as GeminiFlashParseBenchParser from "@parser-stream/gemini/ParseBench"
import { type CapturedRequest, fakeGemini, geminiSse, imageSource, pdfSource, withKey } from "@parser-stream/testkit"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { HtmlStream } from "parser-stream/HtmlStream"

/** The composition: Gemini Flash carrying the ParseBench contract. The contract itself is tested in its own package. */
describe("GeminiFlashParseBenchParser", () => {
  const collect = (source = imageSource, part?: { unit: string; index: number; total: number }) =>
    Effect.gen(function*() {
      const stream = yield* HtmlStream
      return yield* Stream.runCollect(stream.parse({ source, part }))
    })

  it.effect("sends the layout prompt and turns the divs into HTML", () => {
    const captured: CapturedRequest = {}
    const body = geminiSse(
      `<div data-label="Title" data-bbox="[10,20,30,40]" data-page="1">Season Report</div><div data-la`,
      `bel="Text" data-page="1">Turnout grew.</div><div data-label="Table" data-page="1"><table><tr><td>42`,
      "</td></tr></table></div>"
    )
    return Effect.gen(function*() {
      const html = yield* withKey(collect(), "caller-key")
      assert.deepStrictEqual(html, [
        `<h1 data-page="1" data-bbox="10,20,30,40">Season Report</h1>`,
        `<p data-page="1">Turnout grew.</p>`,
        "<table><tr><td>42</td></tr></table>"
      ])
      assert.strictEqual(captured.headers?.["x-goog-api-key"], "caller-key")
      assert.include(captured.body?.["systemInstruction"].parts[0].text, "data-label=\"<category>\"")
      assert.include(captured.body?.["systemInstruction"].parts[0].text, "[y_min, x_min, y_max, x_max]")
      assert.strictEqual(
        captured.body?.["generationConfig"].thinkingConfig.thinkingBudget,
        GeminiFlashParseBenchParser.DEFAULT_THINKING_BUDGET
      )
    }).pipe(
      Effect.provide(GeminiFlashParseBenchParser.layer().pipe(Layer.provide(fakeGemini(captured, () => body))))
    )
  })

  it.effect("drops the multi-page instruction for a single part", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      const source = yield* pdfSource(1)
      yield* withKey(collect(source, { unit: "page", index: 2, total: 5 }), "k")
      assert.notInclude(captured.body?.["systemInstruction"].parts[0].text, "multi-page PDF")
    }).pipe(
      Effect.provide(
        GeminiFlashParseBenchParser.layer().pipe(
          Layer.provide(fakeGemini(captured, () => geminiSse(`<div>x</div>`)))
        )
      )
    )
  })

  it.effect("fails before any request when the conversion brings no key", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      const error = yield* withKey(collect()).pipe(Effect.flip)
      assert.strictEqual(error._tag, "HtmlStreamError")
      assert.include(error.message, "No Gemini API key")
      assert.isUndefined(captured.url)
    }).pipe(
      Effect.provide(
        GeminiFlashParseBenchParser.layer().pipe(
          Layer.provide(fakeGemini(captured, () => geminiSse(`<div>x</div>`)))
        )
      )
    )
  })
})

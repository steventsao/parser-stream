import * as GeminiFlashParseBenchParser from "@parser-stream/gemini/ParseBench"
import * as NodeSanitizer from "@parser-stream/node/Sanitizer"
import * as ParseBench from "@parser-stream/parsebench"
import { type CapturedRequest, fakeGemini, geminiSse, imageSource, pdfSource, withKey } from "@parser-stream/testkit"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { Converter } from "parser-stream/Converter"
import { HtmlStream } from "parser-stream/HtmlStream"
import * as PdfSplitter from "parser-stream/splitters/Pdf"

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

  /**
   * The whole path, with only the network faked: a two-page PDF splits into one
   * request per page, and the key the caller brought reaches both of them.
   */
  it.live("converts a two-page PDF with one request per page, each carrying the caller's key", () => {
    const captured: Array<CapturedRequest> = []
    const recorder = Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request, url) => {
      const raw = (request.body as { body?: Uint8Array }).body
      captured.push({
        url: url.toString(),
        headers: { ...request.headers },
        body: raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined
      })
      return Effect.succeed(HttpClientResponse.fromWeb(
        request,
        geminiSse(`<div data-label="Title" data-bbox="[1,2,3,4]">Page ${captured.length} heading</div>`)
      ))
    }))

    return Effect.gen(function*() {
      const converter = yield* Converter
      const source = yield* pdfSource(2)
      // `concurrency: 1` keeps the page order fixed, so each response belongs to a known page.
      const document = yield* withKey(converter.render(source, { concurrency: 1 }), "caller-key")

      assert.strictEqual(document.status, "done")
      assert.deepStrictEqual(document.blocks.map((block) => block.id), ["page-1", "page-2"])
      assert.include(document.blocks[0]!.html, `<h1 data-bbox="1,2,3,4">Page 1 heading</h1>`)
      assert.include(document.blocks[1]!.html, `<h1 data-bbox="1,2,3,4">Page 2 heading</h1>`)

      assert.strictEqual(captured.length, 2, "one Gemini request per page")
      for (const request of captured) {
        assert.strictEqual(request.headers?.["x-goog-api-key"], "caller-key")
        assert.notInclude(request.url ?? "", "caller-key")
        assert.strictEqual(request.body?.["contents"][0].parts[0].inline_data.mime_type, "application/pdf")
        // Each request holds one page, so it gets the single-part prompt, not the multi-page one.
        assert.strictEqual(request.body?.["systemInstruction"].parts[0].text, ParseBench.SYSTEM_PROMPT)
      }
      assert.notStrictEqual(
        captured[0]!.body?.["contents"][0].parts[0].inline_data.data,
        captured[1]!.body?.["contents"][0].parts[0].inline_data.data,
        "each request carries a different page"
      )
    }).pipe(
      Effect.provide(
        Converter.layerNoDeps.pipe(
          Layer.provide([
            GeminiFlashParseBenchParser.layer().pipe(Layer.provide(recorder)),
            NodeSanitizer.layer,
            PdfSplitter.layer
          ])
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

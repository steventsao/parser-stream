import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Stream } from "effect"
import { Parser } from "../src/core/Parser.js"
import * as ParseBenchParser from "../src/parsers/ParseBench.js"
import { type CapturedRequest, fakeGemini, geminiSse, imageSource, pdfSource, withKey } from "./fixtures.js"

const element = (
  label: ParseBenchParser.LayoutLabel,
  content: string
): ParseBenchParser.LayoutElement => ({ label, content })

describe("ParseBenchParser output contract", () => {
  it.effect("decodes labels, boxes and pages", () =>
    Effect.gen(function*() {
      const decoded = yield* ParseBenchParser.decodeDiv(
        `<div data-bbox="[10, 20, 30, 40]" data-label="Section-header" data-page="3">## Findings</div>`
      )
      assert.deepStrictEqual(decoded, {
        label: "Section-header",
        bbox: [10, 20, 30, 40],
        page: 3,
        content: "## Findings"
      })
    }))

  it.effect("degrades an unknown label and a malformed box to Text", () =>
    Effect.gen(function*() {
      const decoded = yield* ParseBenchParser.decodeDiv(`<div data-label="Sidebar" data-bbox="oops">Loose text</div>`)
      assert.deepStrictEqual(decoded, { label: "Text", content: "Loose text" })
    }))

  it("renders each label into the tags this parser chooses", () => {
    const render = (label: ParseBenchParser.LayoutLabel, content: string) =>
      ParseBenchParser.render(element(label, content))
    expect(render("Title", "# Season Report")).toBe("<h1>Season Report</h1>")
    expect(render("Section-header", "## Findings")).toBe("<h2>Findings</h2>")
    expect(render("Text", "Volunteer turnout **grew** at every site.")).toBe(
      "<p>Volunteer turnout <strong>grew</strong> at every site.</p>"
    )
    expect(render("Table", "<table><tr><td>1</td></tr></table>")).toBe("<table><tr><td>1</td></tr></table>")
    expect(render("Formula", "$$\nE = mc^2\n$$")).toBe("<pre><code>E = mc^2</code></pre>")
    expect(render("Picture", "[Figure: harvest by site]")).toBe(
      "<figure><figcaption>harvest by site</figcaption></figure>"
    )
    expect(render("Page-footer", "Page 2 of 3")).toBe("")
    expect(ParseBenchParser.render(element("Page-footer", "Page 2 of 3"), { keepPageFurniture: true })).toBe(
      "<p>Page 2 of 3</p>"
    )
  })

  it("keeps the box and page on the element it renders", () => {
    const rendered = ParseBenchParser.render({ label: "Title", bbox: [1, 2, 3, 4], page: 2, content: "Report" })
    expect(rendered).toBe(`<h1 data-page="2" data-bbox="1,2,3,4">Report</h1>`)
  })

  it("escapes text that a model wrote as markup", () => {
    expect(ParseBenchParser.render(element("Text", "1 < 2 & <b>bold</b>"))).toBe(
      "<p>1 &lt; 2 &amp; &lt;b&gt;bold&lt;/b&gt;</p>"
    )
  })

  it.effect("groups consecutive list items into one list", () =>
    Effect.gen(function*() {
      const html = yield* Stream.runCollect(ParseBenchParser.toHtml(Stream.fromIterable([
        element("Title", "Report"),
        element("List-item", "- raised beds cut weeding time"),
        element("List-item", "2. weekend workdays drew more people"),
        element("Text", "After the list."),
        element("List-item", "- a trailing item")
      ])))
      assert.deepStrictEqual(html, [
        "<h1>Report</h1>",
        "<ul><li>raised beds cut weeding time</li><li>weekend workdays drew more people</li></ul>",
        "<p>After the list.</p>",
        "<ul><li>a trailing item</li></ul>"
      ])
    }))
})

describe("ParseBenchParser over Gemini", () => {
  const collect = (source = imageSource, part?: { unit: string; index: number; total: number }) =>
    Effect.gen(function*() {
      const parser = yield* Parser
      return yield* Stream.runCollect(parser.parse({ source, part }))
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
      // A whole document asks for page numbers; one page on its own does not need them.
      assert.include(captured.body?.["systemInstruction"].parts[0].text, "multi-page PDF")
      assert.strictEqual(
        captured.body?.["generationConfig"].thinkingConfig.thinkingBudget,
        ParseBenchParser.DEFAULT_THINKING_BUDGET
      )
    }).pipe(Effect.provide(ParseBenchParser.layer().pipe(Layer.provide(fakeGemini(captured, () => body)))))
  })

  it.effect("drops the multi-page instruction for a single part", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      const source = yield* pdfSource(1)
      yield* withKey(collect(source, { unit: "page", index: 2, total: 5 }), "k")
      assert.notInclude(captured.body?.["systemInstruction"].parts[0].text, "multi-page PDF")
    }).pipe(
      Effect.provide(
        ParseBenchParser.layer().pipe(Layer.provide(fakeGemini(captured, () => geminiSse(`<div>x</div>`))))
      )
    )
  })

  it.effect("fails before any request when the conversion brings no key", () => {
    const captured: CapturedRequest = {}
    return Effect.gen(function*() {
      const error = yield* withKey(collect()).pipe(Effect.flip)
      assert.strictEqual(error._tag, "ParserError")
      assert.include(error.message, "No Gemini API key")
      assert.isUndefined(captured.url)
    }).pipe(
      Effect.provide(
        ParseBenchParser.layer().pipe(Layer.provide(fakeGemini(captured, () => geminiSse(`<div>x</div>`))))
      )
    )
  })
})

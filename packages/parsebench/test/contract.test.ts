import * as ParseBench from "@parser-stream/parsebench"
import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"

const element = (label: ParseBench.LayoutLabel, content: string): ParseBench.LayoutElement => ({ label, content })

describe("ParseBench contract", () => {
  it.effect("decodes labels, boxes and pages", () =>
    Effect.gen(function*() {
      const decoded = yield* ParseBench.decodeDiv(
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
      const decoded = yield* ParseBench.decodeDiv(`<div data-label="Sidebar" data-bbox="oops">Loose text</div>`)
      assert.deepStrictEqual(decoded, { label: "Text", content: "Loose text" })
    }))

  it("renders each label into the tags this contract chooses", () => {
    const render = (label: ParseBench.LayoutLabel, content: string) => ParseBench.render(element(label, content))
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
    expect(ParseBench.render(element("Page-footer", "Page 2 of 3"), { keepPageFurniture: true })).toBe(
      "<p>Page 2 of 3</p>"
    )
  })

  it("keeps the box and page on the element it renders", () => {
    const rendered = ParseBench.render({ label: "Title", bbox: [1, 2, 3, 4], page: 2, content: "Report" })
    expect(rendered).toBe(`<h1 data-page="2" data-bbox="1,2,3,4">Report</h1>`)
  })

  it("escapes text that a model wrote as markup", () => {
    expect(ParseBench.render(element("Text", "1 < 2 & <b>bold</b>"))).toBe(
      "<p>1 &lt; 2 &amp; &lt;b&gt;bold&lt;/b&gt;</p>"
    )
  })

  it("asks for page numbers only when the model reads the whole document", () => {
    expect(ParseBench.promptsFor(undefined).systemInstruction).toContain("multi-page PDF")
    expect(ParseBench.promptsFor({ unit: "page", index: 2, total: 5 }).systemInstruction).not.toContain(
      "multi-page PDF"
    )
  })

  it.effect("groups consecutive list items into one list", () =>
    Effect.gen(function*() {
      const html = yield* Stream.runCollect(ParseBench.toHtml(Stream.fromIterable([
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

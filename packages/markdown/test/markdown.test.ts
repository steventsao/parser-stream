import { assert, describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as Markdown from "@parser-stream/markdown"

describe("Markdown blocks", () => {
  it("renders the shapes document models emit", () => {
    expect(Markdown.blockToHtml("# Season Report")).toBe("<h1>Season Report</h1>")
    expect(Markdown.blockToHtml("### Water use")).toBe("<h3>Water use</h3>")
    expect(Markdown.blockToHtml("Turnout **grew** at every site.")).toBe(
      "<p>Turnout <strong>grew</strong> at every site.</p>"
    )
    expect(Markdown.blockToHtml("- one\n- two")).toBe("<ul><li>one</li><li>two</li></ul>")
    expect(Markdown.blockToHtml("1. first\n2. second")).toBe("<ol><li>first</li><li>second</li></ol>")
    expect(Markdown.blockToHtml("> quoted line")).toBe("<blockquote><p>quoted line</p></blockquote>")
    expect(Markdown.blockToHtml("---")).toBe("<hr>")
    expect(Markdown.blockToHtml("[Figure: harvest by site]")).toBe(
      "<figure><figcaption>harvest by site</figcaption></figure>"
    )
    expect(Markdown.blockToHtml("```python\nprint(1 < 2)\n```")).toBe(
      "<pre><code>print(1 &lt; 2)</code></pre>"
    )
    // The model's own HTML table passes through; the sanitizer still checks it.
    expect(Markdown.blockToHtml("<table><tr><td>1</td></tr></table>")).toBe("<table><tr><td>1</td></tr></table>")
  })

  it("converts a markdown table into a real table", () => {
    expect(Markdown.blockToHtml("| Site | Plots |\n| --- | --- |\n| Riverside | 42 |")).toBe(
      `<table><thead><tr><th scope="col">Site</th><th scope="col">Plots</th></tr></thead>` +
        "<tbody><tr><td>Riverside</td><td>42</td></tr></tbody></table>"
    )
  })

  it("adds the attributes the parser asks for", () => {
    expect(Markdown.blockToHtml("Body text", ` data-page="3"`)).toBe(`<p data-page="3">Body text</p>`)
  })

  it("keeps a fenced block together and waits for an unfinished one", () => {
    const { blocks, rest } = Markdown.cutBlocks("# Title\n\n```js\nconst a = 1\n\nconst b = 2\n```\n\n| a |\n")
    assert.deepStrictEqual(blocks, ["# Title", "```js\nconst a = 1\n\nconst b = 2\n```"])
    assert.strictEqual(rest, "| a |\n")
  })
})

describe("Markdown streaming", () => {
  it.effect("emits complete HTML blocks from chunks that split anywhere", () =>
    Effect.gen(function*() {
      const html = yield* Stream.runCollect(Markdown.fromMarkdown(Stream.fromIterable([
        "# Season Rep",
        "ort\n\nTurnout grew.\n\n- rais",
        "ed beds\n- tool shed\n\n| Site | Plots |\n| --- | --- |\n| Riverside | 42 |\n\nLast line."
      ])))
      assert.deepStrictEqual(html, [
        "<h1>Season Report</h1>",
        "<p>Turnout grew.</p>",
        "<ul><li>raised beds</li><li>tool shed</li></ul>",
        `<table><thead><tr><th scope="col">Site</th><th scope="col">Plots</th></tr></thead>` +
          "<tbody><tr><td>Riverside</td><td>42</td></tr></tbody></table>",
        "<p>Last line.</p>"
      ])
    }))
})

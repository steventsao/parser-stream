import { chunked, converterWith, pdfSource } from "@parser-stream/testkit"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Converter, HtmlHandlers, Source } from "parser-stream"

const textSource = Source.text("ignored by the fake parser")

const redact = HtmlHandlers.text("*", (text) => text.replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]"))

describe("HtmlHandlers", () => {
  it.effect("rewrites text the parser split across chunks", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const document = yield* HtmlHandlers.provide(converter.render(textSource), [redact])
      assert.include(document.blocks[0]!.html, "[SSN]")
      assert.notInclude(document.blocks[0]!.html, "123")
    }).pipe(Effect.provide(converterWith(() => chunked(["<p>SSN 123-4", "5-6789 here</p>"])))))

  it.effect("keeps a dropped script out of the output, although a handler still sees its text", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const seen: Array<string> = []
      const spy = HtmlHandlers.text("*", (text) => {
        seen.push(text)
        return text
      })
      const document = yield* HtmlHandlers.provide(converter.render(textSource), [spy])

      // The allowlist decides the output, so the script never reaches a viewer.
      assert.notInclude(document.blocks[0]!.html, "alert")
      assert.include(document.blocks[0]!.html, "Hi")
      // Removal is not dispatch: a handler on `*` does observe the dropped text.
      assert.include(seen.join(" "), "alert(1)")
    }).pipe(Effect.provide(converterWith(() => chunked(["<p>Hi <script>alert(1)</script>there</p>"])))))

  it.effect("applies a selector, and leaves other elements alone", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const cellsOnly = HtmlHandlers.text("td", () => "[cell]")
      const document = yield* HtmlHandlers.provide(converter.render(textSource), [cellsOnly])
      assert.include(document.blocks[0]!.html, "[cell]")
      assert.include(document.blocks[0]!.html, "<th>Keep</th>")
    }).pipe(Effect.provide(
      converterWith(() => chunked(["<table><tr><th>Keep</th></tr><tr><td>Secret</td></tr></table>"]))
    )))

  it.effect("rewrites text inside a table cell exactly once", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      // `*` matches td, tr, tbody and table, so a handler that fires per ancestor would double this.
      const mark = HtmlHandlers.text("*", (text) => (text.trim() ? `[${text}]` : text))
      const document = yield* HtmlHandlers.provide(converter.render(textSource), [mark])
      assert.include(document.blocks[0]!.html, "[cell]")
      assert.notInclude(document.blocks[0]!.html, "[[cell]]")
    }).pipe(Effect.provide(converterWith(() => chunked(["<table><tr><td>cell</td></tr></table>"])))))

  it.effect("lets an element handler set an allowed attribute", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const stamp = HtmlHandlers.make("p", () => ({
        element: (element) => {
          element.setAttribute("data-page", "7")
        }
      }))
      const document = yield* HtmlHandlers.provide(converter.render(textSource), [stamp])
      assert.include(document.blocks[0]!.html, `data-page="7"`)
    }).pipe(Effect.provide(converterWith(() => chunked(["<p>text</p>"])))))

  it.live("runs on every part of a split source, with state per block", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      // `open` runs once per block, so each block counts its own elements from 1.
      const number = HtmlHandlers.make("*", () => {
        let n = 0
        return {
          element: (element) => {
            n += 1
            element.setAttribute("data-page", String(n))
          }
        }
      })
      const document = yield* HtmlHandlers.provide(converter.render(yield* pdfSource(2)), [number])
      assert.strictEqual(document.blocks.length, 2)
      // Both reach 1, so the count did not carry from the first block into the second.
      for (const block of document.blocks) assert.include(block.html, `data-page="1"`)
    }).pipe(Effect.provide(converterWith((request) => chunked([`<h2>Part ${request.part!.index}</h2>`])))))

  it.effect("changes nothing when no handler is declared", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const document = yield* converter.render(textSource)
      assert.include(document.blocks[0]!.html, "123-45-6789")
    }).pipe(Effect.provide(converterWith(() => chunked(["<p>SSN 123-4", "5-6789 here</p>"])))))
})

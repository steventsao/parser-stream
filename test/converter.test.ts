import { assert, describe, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import { Converter, toDocument } from "../src/Converter.js"
import type { ConvertEvent } from "../src/domain/Events.js"
import { chunked, converterWith, imageSource, partChunks, parserError, pdfSource } from "./fixtures.js"

describe("Converter whole mode", () => {
  it.effect("appends sanitized blocks as they complete", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const events = yield* Stream.runCollect(converter.convert(imageSource))
      const appends = events.filter((event) => event.type === "append")
      assert.deepStrictEqual(appends.map((event) => event.id), ["block-1", "block-2", "block-3", "block-4"])
      const document = yield* converter.render(imageSource)
      assert.strictEqual(document.status, "done")
      const html = document.blocks.map((block) => block.html).join("")
      assert.include(html, `<h1 id="block-1">Title</h1>`)
      assert.include(html, `<div id="block-3" class="table-scroll"><table>`)
      assert.include(html, `<p id="block-4">trailing text</p>`)
      assert.notInclude(html, "<script")
    }).pipe(Effect.provide(converterWith((request) => {
      assert.strictEqual(request.part, undefined)
      assert.strictEqual(request.source.mediaType, "image/png")
      return chunked([
        "```html\n<h1>Title</h1><p>Hello <scr",
        "ipt>x()</script>world</p><table><tr><td>1</td></tr>",
        "</table>\n<p>trailing text</p>\n```"
      ])
    }))))

  it.effect("refuses split mode for a source no splitter understands", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const error = yield* Stream.runDrain(converter.convert(imageSource, { mode: "split" })).pipe(Effect.flip)
      assert.strictEqual(error._tag, "SplitError")
    }).pipe(Effect.provide(converterWith(() => Stream.empty))))
})

describe("Converter split mode", () => {
  it.live("scaffolds parts in order, paints them out of order, and assembles the document", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const source = yield* pdfSource(3)
      const events: Array<ConvertEvent> = []
      const document = yield* toDocument(
        converter.convert(source, { concurrency: 3 }).pipe(Stream.tap((event) => Effect.sync(() => events.push(event))))
      )

      assert.deepStrictEqual(
        events.slice(0, 4).map((event) => (event.type === "progress" ? event.phase : event.id)),
        ["page-1", "page-2", "page-3", "Converting 3 pages"]
      )
      const lastPaint = (id: string) => events.findLastIndex((event) => event.type === "replace" && event.id === id)
      assert.isTrue(lastPaint("page-3") < lastPaint("page-1"), "page 3 streams faster and should finish first")

      assert.strictEqual(document.status, "done")
      assert.deepStrictEqual(document.blocks.map((block) => block.id), ["page-1", "page-2", "page-3"])
      for (const [index, block] of document.blocks.entries()) {
        assert.include(block.html, `<h2>Part ${index + 1}</h2>`)
        assert.include(
          block.html,
          `<div class="table-scroll"><table><tr><td>a</td></tr><tr><td>b</td></tr></table></div>`
        )
        assert.notInclude(block.html, "script")
      }
    }).pipe(Effect.provide(converterWith((request) => {
      const part = request.part!
      assert.strictEqual(part.unit, "page")
      assert.strictEqual(part.total, 3)
      return chunked(partChunks(part.index), (part.total - part.index + 1) * 15)
    }))))

  it.live("shows a failed part in place and keeps the others", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const document = yield* converter.render(yield* pdfSource(3), { retries: 1 })
      assert.strictEqual(document.status, "done")
      assert.include(document.blocks[1]!.html, "Page 2 could not be converted. model overloaded")
      assert.include(document.blocks[0]!.html, "Part 1")
      assert.include(document.blocks[2]!.html, "Part 3")
    }).pipe(Effect.provide(converterWith((request) =>
      request.part!.index === 2
        ? Stream.fail(parserError("model overloaded"))
        : chunked(partChunks(request.part!.index))
    ))))

  it.live("retries a part that fails once", () => {
    let attempts = 0
    return Effect.gen(function*() {
      const converter = yield* Converter
      const document = yield* converter.render(yield* pdfSource(1), { mode: "split", retries: 1 })
      assert.strictEqual(attempts, 2)
      assert.include(document.blocks[0]!.html, "Part 1")
      assert.notInclude(document.blocks[0]!.html, "could not be converted")
    }).pipe(Effect.provide(converterWith((request) => {
      attempts += 1
      return attempts === 1
        ? chunked(["<p>half"]).pipe(Stream.concat(Stream.fail(parserError("dropped connection"))))
        : chunked(partChunks(request.part!.index))
    })))
  })

  it.effect("enforces the part limit", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const error = yield* converter.render(yield* pdfSource(3), { maxParts: 2 }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "PartLimitError")
    }).pipe(Effect.provide(converterWith(() => Stream.empty))))
})

describe("Converter timeouts", () => {
  it.live("fails a whole stream that goes quiet", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const error = yield* converter.render(imageSource, { idleTimeoutMs: 50 }).pipe(Effect.flip)
      assert.strictEqual(error._tag, "ParserIdleError")
    }).pipe(Effect.provide(converterWith(() => Stream.fromEffect(Effect.never)))))
})

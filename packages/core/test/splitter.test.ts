import { imageSource } from "@parser-stream/testkit"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Option } from "effect"
import { PDFDocument } from "pdf-lib"
import * as Source from "parser-stream/Source"
import { Splitter } from "parser-stream/Splitter"
import * as PdfSplitter from "parser-stream/splitters/Pdf"

/** Two pages of different sizes, so a lost or repeated page cannot pass unnoticed. */
const twoPagePdf = Effect.promise(async () => {
  const document = await PDFDocument.create()
  document.addPage([200, 200])
  document.addPage([300, 400])
  return document.save()
})

const shapeOf = (bytes: Uint8Array) =>
  Effect.promise(async () => {
    const document = await PDFDocument.load(bytes)
    const page = document.getPage(0)
    return {
      pages: document.getPageCount(),
      width: Math.round(page.getWidth()),
      height: Math.round(page.getHeight())
    }
  })

describe("PdfSplitter", () => {
  it.effect("gives one single-page PDF per page, in page order", () =>
    Effect.gen(function*() {
      const splitter = yield* Splitter
      const bytes = yield* twoPagePdf
      const split = Option.getOrThrow(yield* splitter.split(Source.pdf(bytes)))

      assert.strictEqual(split.unit, "page")
      assert.strictEqual(split.count, 2)
      const first = yield* split.part(1)
      const second = yield* split.part(2)
      assert.strictEqual(first.mediaType, "application/pdf")
      assert.deepStrictEqual(yield* shapeOf(first.bytes), { pages: 1, width: 200, height: 200 })
      assert.deepStrictEqual(yield* shapeOf(second.bytes), { pages: 1, width: 300, height: 400 })
    }).pipe(Effect.provide(PdfSplitter.layer)))

  it.effect("splits the pages independently when they are asked for at the same time", () =>
    Effect.gen(function*() {
      const splitter = yield* Splitter
      const bytes = yield* twoPagePdf
      const split = Option.getOrThrow(yield* splitter.split(Source.pdf(bytes)))
      // pdf-lib shares one document, so the splitter serializes the copies. Both must still be right.
      const parts = yield* Effect.all([split.part(1), split.part(2)], { concurrency: 2 })
      assert.deepStrictEqual(yield* shapeOf(parts[0].bytes), { pages: 1, width: 200, height: 200 })
      assert.deepStrictEqual(yield* shapeOf(parts[1].bytes), { pages: 1, width: 300, height: 400 })
    }).pipe(Effect.provide(PdfSplitter.layer)))

  it.effect("leaves a source that is not a PDF whole", () =>
    Effect.gen(function*() {
      const splitter = yield* Splitter
      assert.isTrue(Option.isNone(yield* splitter.split(imageSource)))
    }).pipe(Effect.provide(PdfSplitter.layer)))

  it.effect("fails with SplitError for bytes that are not a PDF", () =>
    Effect.gen(function*() {
      const splitter = yield* Splitter
      const error = yield* splitter.split(Source.pdf(new Uint8Array([1, 2, 3]))).pipe(Effect.flip)
      assert.strictEqual(error._tag, "SplitError")
      assert.include(error.message, "Unable to read the PDF")
    }).pipe(Effect.provide(PdfSplitter.layer)))
})

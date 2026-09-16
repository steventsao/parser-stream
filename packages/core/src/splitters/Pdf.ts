import { Effect, Layer, Option, Semaphore } from "effect"
import { PDFDocument } from "pdf-lib"
import * as Source from "../Source.js"
import { type Split, SplitError, Splitter } from "../Splitter.js"

/** Splits `application/pdf` sources into single-page PDFs with pdf-lib. Other media types are not split. */
export const layer: Layer.Layer<Splitter> = Layer.succeed(Splitter)(Splitter.of({
  split: Effect.fn("PdfSplitter.split")(function*(source) {
    if (!Source.isPdf(source)) return Option.none<Split>()
    const document = yield* Effect.tryPromise({
      try: () => PDFDocument.load(source.bytes, { ignoreEncryption: true }),
      catch: (cause) => new SplitError({ message: "Unable to read the PDF.", cause })
    })
    // pdf-lib copies pages out of one shared document, which is not safe across concurrent awaits.
    const lock = yield* Semaphore.make(1)
    const part = (index: number) =>
      Semaphore.withPermit(
        lock,
        Effect.tryPromise({
          try: async () => {
            const out = await PDFDocument.create()
            const [copied] = await out.copyPages(document, [index - 1])
            out.addPage(copied!)
            return out.save({ useObjectStreams: false })
          },
          catch: (cause) => new SplitError({ message: `Unable to extract page ${index}.`, cause })
        })
      ).pipe(
        Effect.map((bytes) => Source.pdf(bytes, source.name)),
        Effect.withSpan("PdfSplitter.part", { attributes: { index } })
      )
    return Option.some<Split>({ unit: "page", count: document.getPageCount(), part })
  })
}))

import { Effect, Layer, Stream } from "effect"
import { PDFDocument } from "pdf-lib"
import { Converter } from "../src/Converter.js"
import * as NodeSanitizer from "../src/node/Sanitizer.js"
import { Parser, ParserError, type ParseRequest } from "../src/Parser.js"
import type { Source } from "../src/Source.js"

export const makePdf = (pages: number): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const document = await PDFDocument.create()
    for (let i = 0; i < pages; i += 1) document.addPage([200, 200])
    return document.save()
  })

export const pdfSource = (pages: number): Effect.Effect<Source> =>
  Effect.map(makePdf(pages), (bytes) => ({ bytes, mediaType: "application/pdf", name: "test" }))

export const imageSource: Source = { bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png", name: "scan" }

/** Emits `chunks` one by one with an optional delay between them. */
export const chunked = (chunks: ReadonlyArray<string>, delayMs = 0): Stream.Stream<string, ParserError> =>
  Stream.fromIterable(chunks).pipe(Stream.tap(() => (delayMs > 0 ? Effect.sleep(delayMs) : Effect.void)))

/** Output for one part, split mid-tag on purpose, with a script the sanitizer must remove. */
export const partChunks = (index: number): ReadonlyArray<string> => [
  `<h2>Part ${index}</h2><p>Body <scr`,
  `ipt>alert(1)</script>${index}</p><table><tr><td>a</td></tr>`,
  "<tr><td>b</td></tr></table>"
]

export const fakeParser = (parse: (request: ParseRequest) => Stream.Stream<string, ParserError>) =>
  Parser.fromFunction("fake", parse)

export const converterWith = (parse: (request: ParseRequest) => Stream.Stream<string, ParserError>) =>
  Converter.layer.pipe(Layer.provide([fakeParser(parse), NodeSanitizer.layer]))

export const parserError = (message: string) => new ParserError({ parser: "fake", message })

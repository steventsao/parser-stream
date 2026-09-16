import { Effect, Layer, Option, Redacted, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { PDFDocument } from "pdf-lib"
import { Converter } from "parser-stream/Converter"
import * as NodeSanitizer from "@parser-stream/node/Sanitizer"
import { HtmlStream, HtmlStreamError, type HtmlStreamRequest } from "parser-stream/HtmlStream"
import { provide } from "parser-stream/Credential"
import type { Source } from "parser-stream/Source"
import * as PdfSplitter from "parser-stream/splitters/Pdf"

/**
 * Every page gets its own size. Identical blank pages serialize to identical
 * bytes, which would hide a splitter that repeats or loses a page.
 */
export const makePdf = (pages: number): Effect.Effect<Uint8Array> =>
  Effect.promise(async () => {
    const document = await PDFDocument.create()
    for (let i = 0; i < pages; i += 1) document.addPage([200, 200 + i * 20])
    return document.save()
  })

export const pdfSource = (pages: number): Effect.Effect<Source> =>
  Effect.map(makePdf(pages), (bytes) => ({ bytes, mediaType: "application/pdf", name: "test" }))

export const imageSource: Source = { bytes: new Uint8Array([137, 80, 78, 71]), mediaType: "image/png", name: "scan" }

/** Emits `chunks` one by one with an optional delay between them. */
export const chunked = (chunks: ReadonlyArray<string>, delayMs = 0): Stream.Stream<string, HtmlStreamError> =>
  Stream.fromIterable(chunks).pipe(Stream.tap(() => (delayMs > 0 ? Effect.sleep(delayMs) : Effect.void)))

/** Output for one part, split mid-tag on purpose, with a script the sanitizer must remove. */
export const partChunks = (index: number): ReadonlyArray<string> => [
  `<h2>Part ${index}</h2><p>Body <scr`,
  `ipt>alert(1)</script>${index}</p><table><tr><td>a</td></tr>`,
  "<tr><td>b</td></tr></table>"
]

export const fakeParser = (parse: (request: HtmlStreamRequest) => Stream.Stream<string, HtmlStreamError>) =>
  HtmlStream.fromFunction("fake", parse)

export const converterWith = (parse: (request: HtmlStreamRequest) => Stream.Stream<string, HtmlStreamError>) =>
  Converter.layerNoDeps.pipe(Layer.provide([fakeParser(parse), NodeSanitizer.layer, PdfSplitter.layer]))

export const parserError = (message: string) => new HtmlStreamError({ parser: "fake", message })

/** Run with (or without) a caller-supplied key, the way a server would. */
export const withKey = <A, E, R>(effect: Effect.Effect<A, E, R>, key?: string): Effect.Effect<A, E, R> =>
  provide(effect, key ? Option.some(Redacted.make(key)) : Option.none())

export interface CapturedRequest {
  url?: string
  headers?: Record<string, string>
  body?: Record<string, any>
}

/** An HttpClient that answers every request from `response` and records what was sent. */
export const fakeGemini = (captured: CapturedRequest, response: () => Response) =>
  Layer.succeed(HttpClient.HttpClient)(HttpClient.make((request, url) => {
    captured.url = url.toString()
    captured.headers = { ...request.headers }
    const raw = (request.body as { body?: Uint8Array }).body
    captured.body = raw ? JSON.parse(new TextDecoder().decode(raw)) : undefined
    return Effect.succeed(HttpClientResponse.fromWeb(request, response()))
  }))

/** A Gemini SSE body that streams `texts` as one text delta each. */
export const geminiSse = (...texts: Array<string>) =>
  new Response(
    texts.map((text) => `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] })}\r\n\r\n`)
      .join("") + `data: ${JSON.stringify({ usageMetadata: { totalTokenCount: 1 } })}\n\n`,
    { headers: { "content-type": "text/event-stream" } }
  )

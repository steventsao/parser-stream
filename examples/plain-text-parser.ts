/**
 * A parser that has nothing to do with PDFs or models: plain text in, HTML out.
 *
 *   pnpm tsx examples/plain-text-parser.ts
 */
import { NodeRuntime } from "@effect/platform-node"
import { Console, Effect, Layer, Stream } from "effect"
import { Converter, Document, Html, HtmlStream, Source } from "parser-stream"
import { NodeSanitizer } from "@parser-stream/node"

const PlainTextParser = HtmlStream.fromFunction("plain-text", (request) =>
  Stream.fromIterable(new TextDecoder().decode(request.source.bytes).split(/\n\s*\n/)).pipe(
    Stream.map((paragraph) => paragraph.trim()),
    Stream.filter((paragraph) => paragraph.length > 0),
    Stream.map((paragraph) =>
      paragraph.startsWith("# ")
        ? `<h1>${Html.escapeHtml(paragraph.slice(2))}</h1>`
        : `<p>${Html.escapeHtml(paragraph)}</p>`
    )
  ))

const program = Effect.gen(function*() {
  const converter = yield* Converter
  const text = "# Hello\n\nThis page came from a custom parser.\n\nNo PDF and no API key <script>were</script> involved."
  const document = yield* converter.render(Source.text(text))
  yield* Console.log(Document.renderHtmlDocument({ title: "Hello", blocks: document.blocks }))
}).pipe(Effect.provide(Converter.layer.pipe(Layer.provide([PlainTextParser, NodeSanitizer.layer]))))

NodeRuntime.runMain(program)

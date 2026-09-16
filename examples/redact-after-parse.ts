/**
 * Redact a document as it is parsed, with declared HTML handlers.
 *
 *   pnpm tsx examples/redact-after-parse.ts
 *
 * A handler runs while the runtime rewrites a finished block, in the same pass
 * as the allowlist. It receives the text of a node, not a string of markup, so
 * nothing here matches HTML by hand.
 *
 * The parser below emits `123-4` and then `5-6789`, the way a real model does.
 * The core cuts the complete block first, so the handler always sees whole
 * text.
 *
 * The allowlist runs first and keeps the script out of the output. It does not
 * limit what a handler observes: a handler on `*` still sees the text inside a
 * dropped element, so treat what it sees as untrusted.
 */
import { NodeRuntime } from "@effect/platform-node"
import { NodeSanitizer } from "@parser-stream/node"
import { Console, Effect, Layer, Stream } from "effect"
import { Converter, Document, HtmlHandlers, HtmlStream, Source } from "parser-stream"

/** Text in, text out. */
const redact = HtmlHandlers.text("*", (text) =>
  text
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]")
    .replace(/\bJohn Smith\b/g, "[PERSON]"))

const FakeParser = HtmlStream.fromFunction("fake", () =>
  Stream.fromIterable([
    "<h1>Case file</h1><p>Filed by John Sm",
    "ith, SSN 123-4",
    "5-6789.</p><p>Reviewed by <script>alert(1)</script>John Smith.</p>"
  ]))

const program = Effect.gen(function*() {
  const converter = yield* Converter
  const document = yield* converter.render(Source.text("ignored by the fake parser"))
  yield* Console.log(Document.renderHtmlDocument({ title: "Redacted", blocks: document.blocks }))
}).pipe(
  Effect.provide(Converter.layer.pipe(Layer.provide([FakeParser, NodeSanitizer.layer]))),
  // Handlers go to the program: the sanitizer reads them from the running fiber.
  Effect.provide(HtmlHandlers.layer(redact))
)

NodeRuntime.runMain(program)

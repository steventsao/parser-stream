/**
 * Redact after the parser, before anything is stored or sent.
 *
 *   pnpm tsx examples/redact-after-parse.ts
 *
 * A post-parse hook runs on every finished block, after the sanitizer. The
 * core cuts complete blocks out of a parser's stream, so a hook always sees
 * whole HTML. A redactor inside a parser would not: the fake parser below
 * emits `123-4` and then `5-6789`, and the redaction still works.
 *
 * The sanitizer runs first on purpose. It is the security boundary, and it
 * unwraps unknown tags, so it surfaces text the hook must see.
 */
import { NodeRuntime } from "@effect/platform-node"
import { NodeSanitizer } from "@parser-stream/node"
import { Console, Effect, Layer, Stream } from "effect"
import { Converter, Document, HtmlStream, PostParse, Source } from "parser-stream"

/** A plain function is enough here. A real redactor may call out over HTTP: use `PostParse.make`. */
const redact = PostParse.sync("redact", (html) =>
  html
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]")
    .replace(/\bJohn Smith\b/g, "[PERSON]"))

/** Splits an SSN and a name across chunk boundaries, the way a real model does. */
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
  // The hooks go to the program, because the converter reads them from the running fiber.
  Effect.provide(PostParse.layer(redact))
)

NodeRuntime.runMain(program)

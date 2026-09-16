/**
 * Redact after the parser, before anything is stored or sent.
 *
 *   pnpm tsx examples/redact-after-parse.ts
 *
 * The core calls `Sanitizer` once per **complete** block, so that is the seam a
 * redactor wants. A redactor cannot sit inside the parser: a parser emits
 * chunks that split anywhere, even mid-token, so `123-45-6789` can arrive as
 * `123-4` then `5-6789`. The fake parser below does exactly that, and the
 * redaction still works, because the core cuts the block first.
 *
 * Order matters: sanitize first, redact second. Sanitizing is the security
 * boundary, and it unwraps unknown tags, so it can surface text that a
 * redactor would otherwise never see.
 */
import { NodeRuntime } from "@effect/platform-node"
import { NodeSanitizer } from "@parser-stream/node"
import { Console, Effect, Layer, Stream } from "effect"
import { Converter, Document, HtmlStream, Sanitizer, Source } from "parser-stream"

/** Stands in for a real redactor, such as a Presidio call. It may be async and may fail. */
const redact = (html: string) =>
  Effect.succeed(
    html
      .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[SSN]")
      .replace(/\bJohn Smith\b/g, "[PERSON]")
  )

/**
 * A decorator layer: it provides `Sanitizer` and also consumes the host's
 * `Sanitizer`, which `Layer.provide` supplies at build time. The core keeps its
 * three ports and needs no change.
 */
const RedactingSanitizer = Layer.effect(
  Sanitizer,
  Effect.gen(function*() {
    const base = yield* Sanitizer
    return Sanitizer.of({
      sanitize: (html) => Effect.flatMap(base.sanitize(html), redact)
    })
  })
).pipe(Layer.provide(NodeSanitizer.layer))

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
}).pipe(Effect.provide(Converter.layer.pipe(Layer.provide([FakeParser, RedactingSanitizer]))))

NodeRuntime.runMain(program)

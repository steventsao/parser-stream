import { chunked, converterWith, pdfSource } from "@parser-stream/testkit"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import { Converter, PostParse, Source } from "parser-stream"

const textSource = Source.text("ignored by the fake parser")

describe("PostParse", () => {
  it.effect("runs the hooks in order on a whole-source block", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const document = yield* PostParse.provide(converter.render(textSource), [
        PostParse.sync("first", (html) => html.replace("SECRET", "[redacted]")),
        PostParse.sync("second", (html) => html.replace("[redacted]", "[gone]"))
      ])
      // The parser split the word, so only a hook that runs after the cut can match it.
      assert.include(document.blocks[0]!.html, "[gone]")
      assert.notInclude(document.blocks[0]!.html, "SECRET")
    }).pipe(Effect.provide(converterWith(() => chunked(["<p>SEC", "RET</p>"])))))

  it.live("runs the hooks on every part of a split source", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const document = yield* PostParse.provide(
        converter.render(yield* pdfSource(2)),
        [PostParse.sync("redact", (html) => html.replace(/Part \d/g, "[part]"))]
      )
      assert.strictEqual(document.blocks.length, 2)
      for (const block of document.blocks) {
        assert.include(block.html, "[part]")
        assert.notInclude(block.html, "Part 1")
        assert.notInclude(block.html, "Part 2")
      }
    }).pipe(Effect.provide(converterWith((request) => chunked([`<h2>Part ${request.part!.index}</h2>`])))))

  it.live("shows a failing hook in place, with the hook's own message", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const document = yield* PostParse.provide(
        converter.render(yield* pdfSource(1), { mode: "split", retries: 0 }),
        [PostParse.make("redact", () =>
          Effect.fail(new PostParse.PostParseError({ hook: "redact", message: "The redactor is down." })))]
      )
      // Not "could not be sanitized": a hook failure reports itself.
      assert.include(document.blocks[0]!.html, "The redactor is down.")
    }).pipe(Effect.provide(converterWith(() => chunked(["<p>x</p>"])))))

  it.effect("changes nothing when no hook is installed", () =>
    Effect.gen(function*() {
      const converter = yield* Converter
      const document = yield* converter.render(textSource)
      assert.include(document.blocks[0]!.html, "SECRET")
    }).pipe(Effect.provide(converterWith(() => chunked(["<p>SEC", "RET</p>"])))))
})

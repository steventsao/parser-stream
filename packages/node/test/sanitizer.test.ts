import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"
import * as NodeSanitizer from "@parser-stream/node/Sanitizer"
import { Sanitizer } from "parser-stream/Sanitizer"

const sanitize = Effect.fn("sanitize")(function*(html: string) {
  const sanitizer = yield* Sanitizer
  return yield* sanitizer.sanitize(html)
})

describe("Sanitizer", () => {
  it.effect("drops scripts, handlers, styles, ids and unsafe URLs", () =>
    Effect.gen(function*() {
      const out = yield* sanitize(
        `<p id="x" onclick="steal()" style="color:red">Hi<script>alert(1)</script>` +
          `<a href="javascript:alert(1)">bad</a><a href="https://example.com">good</a>` +
          `<img src="data:image/png;base64,AAAA" alt="pic"><!-- note --></p>`
      )
      assert.strictEqual(
        out,
        `<p>Hi<a>bad</a><a href="https://example.com" rel="noopener noreferrer nofollow">good</a><img alt="pic"></p>`
      )
    }).pipe(Effect.provide(NodeSanitizer.layer)))

  it.effect("unwraps unknown wrappers and keeps table structure", () =>
    Effect.gen(function*() {
      const out = yield* sanitize(
        `<div class="x"><table><tr><th scope="col" onmouseover="x">A</th></tr></table></div>`
      )
      assert.strictEqual(out, `<table><tr><th scope="col">A</th></tr></table>`)
    }).pipe(Effect.provide(NodeSanitizer.layer)))

  it.effect("keeps figure crop hints", () =>
    Effect.gen(function*() {
      const out = yield* sanitize(`<figure data-page="2" data-bbox="1,2,3,4"><figcaption>Chart</figcaption></figure>`)
      assert.strictEqual(out, `<figure data-page="2" data-bbox="1,2,3,4"><figcaption>Chart</figcaption></figure>`)
    }).pipe(Effect.provide(NodeSanitizer.layer)))
})

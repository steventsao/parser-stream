import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { type Comment, type Element, HTMLRewriter } from "html-rewriter-wasm"

/**
 * Parser output comes from a model (or other code) that read an untrusted PDF.
 * Prompt instructions are not a security boundary, so every block crosses this
 * allowlist before it is stored, broadcast, or rendered.
 */

export class SanitizeError extends Schema.TaggedError<SanitizeError>()("SanitizeError", {
  cause: Schema.Defect()
}) {}

export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
  "figure", "figcaption", "img", "blockquote", "pre", "code",
  "strong", "em", "b", "i", "u", "s", "sub", "sup", "small", "mark", "span", "br", "hr", "a", "abbr"
])

/** Removed together with their content. Any other unknown tag is unwrapped and its text is kept. */
export const DROPPED_TAGS: ReadonlySet<string> = new Set([
  "script", "style", "iframe", "object", "embed", "noscript", "template", "svg", "math",
  "link", "meta", "base", "form", "input", "button", "textarea", "select", "option"
])

/** No `id`: block ids are assigned by the converter, never by the parser. */
export const ALLOWED_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  "*": new Set(["data-page", "data-bbox"]),
  img: new Set(["src", "alt", "width", "height"]),
  a: new Set(["href", "title"]),
  th: new Set(["scope", "colspan", "rowspan", "headers"]),
  td: new Set(["colspan", "rowspan", "headers"]),
  col: new Set(["span"]),
  colgroup: new Set(["span"])
}

/** Safe URL schemes only. No `data:` and no `javascript:`. */
export const isSafeUrl = (value: string): boolean => {
  const s = value.trim().toLowerCase()
  return s.startsWith("https://") || s.startsWith("http://") || s.startsWith("mailto:") || s.startsWith("#")
}

const handlers = {
  element(el: Element) {
    const tag = el.tagName.toLowerCase()
    if (DROPPED_TAGS.has(tag)) {
      el.remove()
      return
    }
    if (!ALLOWED_TAGS.has(tag)) {
      el.removeAndKeepContent()
      return
    }
    const allowed = ALLOWED_ATTRIBUTES[tag]
    const global = ALLOWED_ATTRIBUTES["*"]!
    const drop: Array<string> = []
    for (const [name, value] of el.attributes) {
      const n = name.toLowerCase()
      if (!global.has(n) && !allowed?.has(n)) drop.push(name)
      else if ((n === "src" || n === "href") && !isSafeUrl(value)) drop.push(name)
    }
    for (const name of drop) el.removeAttribute(name)
    if (tag === "a" && el.hasAttribute("href")) el.setAttribute("rel", "noopener noreferrer nofollow")
  },
  comments(comment: Comment) {
    comment.remove()
  }
}

export class Sanitizer extends Context.Service<Sanitizer, {
  readonly sanitize: (html: string) => Effect.Effect<string, SanitizeError>
}>()("parser-stream/Sanitizer") {
  /** Allowlist sanitizer backed by lol-html (WebAssembly). */
  static readonly layer = Layer.effect(
    Sanitizer,
    Effect.gen(function*() {
      // The WebAssembly module runs one rewriter at a time; parallel page fibers share this lock.
      const lock = yield* Semaphore.make(1)
      const encoder = new TextEncoder()

      const run = (html: string) =>
        Effect.suspend(() => {
          const decoder = new TextDecoder()
          let out = ""
          return Effect.acquireUseRelease(
            Effect.sync(() =>
              new HTMLRewriter((chunk) => {
                out += decoder.decode(chunk, { stream: true })
              })
            ),
            (rewriter) =>
              Effect.tryPromise({
                try: async () => {
                  rewriter.on("*", handlers)
                  await rewriter.write(encoder.encode(html))
                  await rewriter.end()
                  return out + decoder.decode()
                },
                catch: (cause) => new SanitizeError({ cause })
              }),
            (rewriter) => Effect.sync(() => rewriter.free())
          )
        })

      const sanitize = Effect.fn("Sanitizer.sanitize")(function*(html: string) {
        return yield* Semaphore.withPermit(lock, run(html))
      })

      return Sanitizer.of({ sanitize })
    })
  )
}

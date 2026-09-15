import { Context, type Effect, Schema } from "effect"

/**
 * HtmlStream output comes from a model (or other code) that read an untrusted
 * document. Prompt instructions are not a security boundary, so every block
 * crosses this allowlist before it is stored, broadcast, or rendered.
 *
 * The policy is runtime-neutral: `node/Sanitizer.ts` runs it through lol-html
 * (WebAssembly), `workers/Sanitizer.ts` through Cloudflare's HTMLRewriter.
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

/** The element API that lol-html and Cloudflare's HTMLRewriter share. */
export interface RewriterElement {
  readonly tagName: string
  readonly attributes: Iterable<ReadonlyArray<string>>
  remove(): unknown
  removeAndKeepContent(): unknown
  hasAttribute(name: string): boolean
  setAttribute(name: string, value: string): unknown
  removeAttribute(name: string): unknown
}

export interface RewriterComment {
  remove(): unknown
}

/** Rewriter handlers for the allowlist. Register them on `*`. */
export const sanitizerHandlers = {
  element(el: RewriterElement) {
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
    for (const [name = "", value = ""] of el.attributes) {
      const n = name.toLowerCase()
      if (!global.has(n) && !allowed?.has(n)) drop.push(name)
      else if ((n === "src" || n === "href") && !isSafeUrl(value)) drop.push(name)
    }
    for (const name of drop) el.removeAttribute(name)
    if (tag === "a" && el.hasAttribute("href")) el.setAttribute("rel", "noopener noreferrer nofollow")
  },
  comments(comment: RewriterComment) {
    comment.remove()
  }
}

export class Sanitizer extends Context.Service<Sanitizer, {
  readonly sanitize: (html: string) => Effect.Effect<string, SanitizeError>
}>()("parser-stream/Sanitizer") {}

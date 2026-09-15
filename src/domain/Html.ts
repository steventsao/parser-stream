/**
 * Pure helpers for streamed HTML. No Effect, no IO: everything here is a
 * synchronous string transform that is safe to unit test in isolation.
 */

/** CSS-selector-safe block ids. `#${id}` works in the DOM without escaping. */
export const BLOCK_ID_PATTERN = "^[A-Za-z][A-Za-z0-9_-]*$"
const BLOCK_ID_RE = new RegExp(BLOCK_ID_PATTERN)

export const isBlockId = (id: string): boolean => BLOCK_ID_RE.test(id)

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "\"" ? "&quot;" : "&#39;")

/** Strip a leading ```html / ``` fence that a model may emit despite instructions. */
export const stripFence = (s: string): string =>
  s.replace(/^﻿?\s*```(?:html)?\s*/i, "").replace(/\s*```\s*$/i, "")

const VOID_TAG_RE = /^(br|hr|img|input|meta|source|col|area|wbr)$/i

/** Index just past the complete top-level element that starts at `start`, or -1 when incomplete. */
export const findElementEnd = (s: string, start: number): number => {
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g
  tagRe.lastIndex = start
  let depth = 0
  let entered = false
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(s))) {
    const whole = m[0]
    const isClose = whole.startsWith("</")
    const selfClose = whole.endsWith("/>") || VOID_TAG_RE.test(m[1]!)
    if (!entered) {
      entered = true
      if (selfClose && !isClose) return m.index + whole.length
    }
    if (isClose) depth -= 1
    else if (!selfClose) depth += 1
    if (depth === 0) return m.index + whole.length
  }
  return -1
}

/**
 * Split complete top-level blocks out of a growing buffer so each block renders
 * whole. Stray top-level text becomes a `<p>`. `rest` is the incomplete tail.
 */
export const extractBlocks = (buffer: string): { blocks: Array<string>; rest: string } => {
  const blocks: Array<string> = []
  let s = stripFence(buffer)
  for (;;) {
    const ws = s.search(/\S/)
    if (ws === -1) {
      s = ""
      break
    }
    if (ws > 0) s = s.slice(ws)
    if (s[0] !== "<") {
      const lt = s.indexOf("<")
      if (lt === -1) break
      const text = s.slice(0, lt).trim()
      if (text) blocks.push(`<p>${text}</p>`)
      s = s.slice(lt)
      continue
    }
    const end = findElementEnd(s, 0)
    if (end === -1) break
    const block = s.slice(0, end).trim()
    if (block) blocks.push(block)
    s = s.slice(end)
  }
  return { blocks, rest: s }
}

/**
 * Make the root element of `html` carry `id`. Any id already on the root is
 * replaced: ids are always assigned by the server, never by the model.
 */
export const withRootId = (html: string, id: string): string => {
  const open = html.match(/^<([a-zA-Z][\w-]*)\b([^>]*)>/)
  if (!open) return html
  const attrs = open[2]!.replace(/\s\bid\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, "")
  return `<${open[1]} id="${id}"${attrs}>` + html.slice(open[0].length)
}

/** Wrap a top-level `<table>` in a scroll container so wide tables do not force page scroll. */
export const wrapTable = (html: string): string =>
  /^\s*<table[\s>]/i.test(html) ? `<div class="table-scroll">${html}</div>` : html

const PROVISIONAL_CONTAINERS = new Set(["table", "thead", "tbody", "tfoot", "ul", "ol", "dl"])

/**
 * For the incomplete tail of a stream, return a provisionally closed render of
 * the complete children received so far (for example the finished rows of a
 * table that has not closed yet). Returns undefined when nothing is paintable.
 */
export const provisionalTail = (rest: string): { html: string; children: number } | undefined => {
  const s = stripFence(rest).replace(/^\s+/, "")
  if (!s.startsWith("<")) return undefined
  const built = buildProvisional(s)
  return built && built.children > 0 ? built : undefined
}

const buildProvisional = (s: string): { html: string; children: number } | undefined => {
  const open = s.match(/^<([a-zA-Z][\w-]*)\b[^>]*>/)
  if (!open) return undefined
  const tag = open[1]!.toLowerCase()
  if (!PROVISIONAL_CONTAINERS.has(tag)) return undefined
  if (findElementEnd(s, 0) !== -1) return undefined
  let body = s.slice(open[0].length)
  let inner = ""
  let children = 0
  for (;;) {
    const ws = body.search(/\S/)
    if (ws === -1) {
      body = ""
      break
    }
    body = body.slice(ws)
    if (body[0] !== "<") {
      const lt = body.indexOf("<")
      if (lt === -1) {
        body = ""
        break
      }
      body = body.slice(lt)
      continue
    }
    if (body.startsWith("</")) {
      body = ""
      break
    }
    const end = findElementEnd(body, 0)
    if (end === -1) break
    inner += body.slice(0, end)
    children += 1
    body = body.slice(end)
  }
  const nested = body.trim().startsWith("<") ? buildProvisional(body.trim()) : undefined
  if (nested) {
    inner += nested.html
    children += nested.children
  }
  if (!children) return undefined
  return { html: `${open[0]}${inner}</${tag}>`, children }
}

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"
])

/** Index just after a tag's `>`, ignoring `>` inside quoted attribute values. */
const tagEnd = (html: string, start: number): number => {
  let quote: "\"" | "'" | undefined
  for (let i = start + 1; i < html.length; i += 1) {
    const char = html[i]
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (char === "\"" || char === "'") quote = char
    else if (char === ">") return i + 1
  }
  return -1
}

/** The `id` attribute of the root element, parsed attribute by attribute. */
export const rootId = (html: string): string | undefined => {
  const normalized = html.trim()
  const end = tagEnd(normalized, 0)
  if (end === -1) return undefined
  const openingTag = normalized.slice(0, end)
  const root = openingTag.match(/^<[a-zA-Z][a-zA-Z0-9-]*\b/)
  if (!root) return undefined
  let cursor = root[0].length
  const isSpace = (c: string | undefined) => c !== undefined && /[\t\n\f\r ]/.test(c)
  while (cursor < openingTag.length) {
    while (isSpace(openingTag[cursor])) cursor += 1
    if (openingTag[cursor] === ">" || (openingTag[cursor] === "/" && openingTag[cursor + 1] === ">")) return undefined
    const nameStart = cursor
    while (cursor < openingTag.length && !/[\t\n\f\r />=]/.test(openingTag[cursor]!)) cursor += 1
    if (cursor === nameStart) return undefined
    const name = openingTag.slice(nameStart, cursor).toLowerCase()
    while (isSpace(openingTag[cursor])) cursor += 1
    let value: string | undefined
    if (openingTag[cursor] === "=") {
      cursor += 1
      while (isSpace(openingTag[cursor])) cursor += 1
      const quote = openingTag[cursor]
      if (quote === "\"" || quote === "'") {
        const valueStart = ++cursor
        while (cursor < openingTag.length && openingTag[cursor] !== quote) cursor += 1
        if (cursor >= openingTag.length) return undefined
        value = openingTag.slice(valueStart, cursor)
        cursor += 1
      } else {
        const valueStart = cursor
        while (cursor < openingTag.length && !/[\t\n\f\r >]/.test(openingTag[cursor]!)) cursor += 1
        value = openingTag.slice(valueStart, cursor)
      }
    }
    if (name === "id") return value || undefined
  }
  return undefined
}

/** Index after the first balanced top-level element, or -1 when it is incomplete or malformed. */
const balancedElementEnd = (html: string): number => {
  const stack: Array<string> = []
  let cursor = 0
  let entered = false
  while (cursor < html.length) {
    const start = html.indexOf("<", cursor)
    if (start === -1) return -1
    if (html.startsWith("<!--", start)) {
      if (!entered) return -1
      const commentEnd = html.indexOf("-->", start + 4)
      if (commentEnd === -1) return -1
      cursor = commentEnd + 3
      continue
    }
    const end = tagEnd(html, start)
    if (end === -1) return -1
    const token = html.slice(start, end)
    const closing = token.startsWith("</")
    const match = token.match(closing ? /^<\/([a-zA-Z][a-zA-Z0-9-]*)[\t\n\f\r ]*>$/ : /^<([a-zA-Z][a-zA-Z0-9-]*)\b/)
    if (!match) return -1
    const tag = match[1]!.toLowerCase()
    if (closing) {
      if (!entered || stack.at(-1) !== tag) return -1
      stack.pop()
      if (stack.length === 0) return end
    } else {
      if (!entered) {
        if (start !== 0) return -1
        entered = true
      }
      if (VOID_TAGS.has(tag)) {
        if (stack.length === 0) return end
      } else {
        stack.push(tag)
      }
    }
    cursor = end
  }
  return -1
}

/** True only for exactly one complete top-level element whose root carries `id`. */
export const isSingleBlock = (html: string, id: string): boolean => {
  const normalized = html.trim()
  return isBlockId(id) && balancedElementEnd(normalized) === normalized.length && rootId(normalized) === id
}

/** True for exactly one balanced top-level element. */
export const isCompleteElement = (html: string): boolean => {
  const normalized = html.trim()
  return normalized.length > 0 && balancedElementEnd(normalized) === normalized.length
}

/** Fallback for malformed markup: keep the visible text as one paragraph. */
export const textParagraph = (html: string): string => {
  const text = html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().replace(/</g, "&lt;").replace(/>/g, "&gt;")
  return text ? `<p>${text}</p>` : ""
}

/**
 * Turn sanitized HTML into a list of balanced top-level blocks. Sanitizing can
 * unwrap one element into several siblings or bare text, and a model can emit
 * unbalanced tags: both cases degrade to text paragraphs instead of failing.
 */
export const normalizeBlocks = (sanitized: string): Array<string> => {
  const { blocks, rest } = extractBlocks(sanitized)
  const out = blocks.map((block) => isCompleteElement(block) ? block : textParagraph(block))
  if (rest.trim()) out.push(textParagraph(rest))
  return out.filter((block) => block.length > 0)
}

/** Force a top-level `<figure>` to carry the true page number. A split page always looks like page 1 to a model. */
export const stampFigurePage = (html: string, page: number): string => {
  const open = html.match(/^<figure\b([^>]*)>/i)
  if (!open) return html
  const attrs = /\bdata-page\s*=\s*["'][^"']*["']/i.test(open[1]!)
    ? open[1]!.replace(/\bdata-page\s*=\s*["'][^"']*["']/i, `data-page="${page}"`)
    : ` data-page="${page}"${open[1]}`
  return `<figure${attrs}>` + html.slice(open[0].length)
}

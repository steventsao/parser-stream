import { Effect, Stream } from "effect"

/**
 * Markdown to HTML, for the many parsers whose model answers in markdown
 * (docling, PyMuPDF4LLM, and the `parse` prompt of most open-weight VLMs).
 *
 * This is a parser-layer helper, not a general markdown engine: it covers the
 * block shapes those models emit, and it is streaming-safe, so a parser can
 * hand the runtime complete HTML blocks as they finish.
 */

export const escapeText = (text: string): string =>
  text.replace(/&(?![a-zA-Z#0-9]+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Inline markdown only: code, bold, italic, and safe links. */
export const inline = (markdown: string): string =>
  escapeText(markdown.trim())
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2">$1</a>`)

const FENCE = /^\s*(?:```|~~~)/
const isFence = (line: string) => FENCE.test(line)

/**
 * Cut complete markdown blocks out of a growing buffer. A block ends at a
 * blank line, except inside a fenced code block. `rest` is the tail that is
 * still arriving.
 */
export const cutBlocks = (buffer: string): { blocks: Array<string>; rest: string } => {
  const blocks: Array<string> = []
  const lines = buffer.split("\n")
  let current: Array<string> = []
  let fenced = false
  let consumed = 0
  for (let index = 0; index < lines.length - 1; index += 1) {
    const line = lines[index]!
    consumed += line.length + 1
    if (isFence(line)) {
      current.push(line)
      if (fenced) {
        blocks.push(current.join("\n"))
        current = []
      }
      fenced = !fenced
      continue
    }
    if (!fenced && line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"))
        current = []
      }
      continue
    }
    current.push(line)
  }
  const tail = current.length > 0 ? current.join("\n") + "\n" : ""
  return { blocks: blocks.filter((block) => block.trim() !== ""), rest: tail + lines.at(-1)! }
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/
const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim())

const tableHtml = (lines: ReadonlyArray<string>, attributes: string) => {
  const head = cells(lines[0]!).map((cell) => `<th scope="col">${inline(cell)}</th>`).join("")
  const body = lines.slice(2)
    .filter((line) => line.trim() !== "")
    .map((line) => `<tr>${cells(line).map((cell) => `<td>${inline(cell)}</td>`).join("")}</tr>`)
    .join("")
  return `<table${attributes}><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

const listHtml = (lines: ReadonlyArray<string>, attributes: string) => {
  const ordered = /^\s*\d+[.)]\s/.test(lines[0]!)
  const items = lines
    .filter((line) => line.trim() !== "")
    .map((line) => `<li>${inline(line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, ""))}</li>`)
    .join("")
  return ordered ? `<ol${attributes}>${items}</ol>` : `<ul${attributes}>${items}</ul>`
}

const figureHtml = (alt: string, url: string | undefined, attributes: string) => {
  const caption = alt.trim() || "Figure"
  const image = url && /^https?:\/\//.test(url) ? `<img src="${escapeText(url)}" alt="${escapeText(caption)}">` : ""
  return `<figure${attributes}>${image}<figcaption>${inline(caption)}</figcaption></figure>`
}

/** One markdown block as one complete HTML element. `attributes` is added to the root. */
export const blockToHtml = (block: string, attributes = ""): string => {
  const text = block.trim()
  if (!text) return ""
  const lines = text.split("\n")
  if (isFence(lines[0]!)) {
    const body = lines.slice(1, isFence(lines.at(-1)!) ? -1 : undefined).join("\n")
    return `<pre${attributes}><code>${escapeText(body)}</code></pre>`
  }
  // HTML the model wrote itself (a table, most often) passes through; the sanitizer still checks it.
  if (text.startsWith("<")) return text
  const heading = text.match(/^(#{1,6})\s+(.*)$/s)
  if (heading) {
    const level = heading[1]!.length
    return `<h${level}${attributes}>${inline(heading[2]!.split("\n")[0]!)}</h${level}>`
  }
  if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(text)) return `<hr${attributes}>`
  if (lines.length > 1 && lines[0]!.includes("|") && TABLE_SEPARATOR.test(lines[1]!)) return tableHtml(lines, attributes)
  if (/^\s*(?:[-*+]|\d+[.)])\s/.test(lines[0]!)) return listHtml(lines, attributes)
  if (text.startsWith(">")) {
    const quote = lines.map((line) => line.replace(/^\s*>\s?/, "")).join(" ")
    return `<blockquote${attributes}><p>${inline(quote)}</p></blockquote>`
  }
  const image = text.match(/^!\[([^\]]*)\]\(([^)]*)\)$/)
  if (image) return figureHtml(image[1]!, image[2], attributes)
  const bracketFigure = text.match(/^\[(?:figure|image|chart|picture)\s*:\s*([^\]]+)\]$/i)
  if (bracketFigure) return figureHtml(bracketFigure[1]!, undefined, attributes)
  return `<p${attributes}>${inline(lines.join(" "))}</p>`
}

export interface FromMarkdownOptions {
  /** Added to every root element, for example ` data-page="2"`. */
  readonly attributes?: string | undefined
}

/** A stream of markdown text into a stream of complete HTML blocks. */
export const fromMarkdown = <E, R>(
  text: Stream.Stream<string, E, R>,
  options: FromMarkdownOptions = {}
): Stream.Stream<string, E, R> =>
  Stream.suspend(() => {
    let buffer = ""
    const attributes = options.attributes ?? ""
    return text.pipe(
      Stream.map((delta) => {
        const { blocks, rest } = cutBlocks(buffer + delta)
        buffer = rest
        return blocks.map((block) => blockToHtml(block, attributes)).filter((html) => html !== "")
      }),
      Stream.concat(Stream.fromEffect(Effect.sync(() => {
        const tail = buffer.trim()
        buffer = ""
        if (!tail) return []
        const { blocks, rest } = cutBlocks(`${tail}\n\n`)
        return [...blocks, rest].map((block) => blockToHtml(block, attributes)).filter((html) => html !== "")
      }))),
      Stream.flattenIterable
    )
  })

import { Config, Effect, Layer, Option, type Redacted, Schema, Stream } from "effect"
import { HttpClient } from "effect/unstable/http"
import { extractBlocks } from "../domain/Html.js"
import { Parser, ParserError, type ParseRequest, type PartRef } from "../Parser.js"
import { ParserCredential } from "../ParserCredential.js"
import type { Source } from "../Source.js"
import * as GeminiTransport from "./GeminiTransport.js"

/**
 * A layout parser for Gemini Flash, with the prompt and the output contract we
 * use for ParseBench runs: markdown content, HTML tables, and one
 * `<div data-bbox data-label>` wrapper per layout element, labelled with the
 * DocLayNet categories.
 *
 * Everything specific to it lives here, and nothing of it reaches the runtime:
 *
 * 1. `elements` decodes the model's output into typed `LayoutElement`s.
 * 2. `render` turns one element into HTML. This is the only place that picks
 *    tags, so a heading or a paragraph is never a library decision.
 * 3. The key comes from `ParserCredential` or from this parser's options.
 */

export const DEFAULT_MODEL = "gemini-3-flash-preview"
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384
/** The layout pass runs best with room to think. This is the budget our benchmark runs use. */
export const DEFAULT_THINKING_BUDGET = 32_768

// ── the output contract ───────────────────────────────────────────────────────

/** DocLayNet categories, exactly as the prompt asks for them. */
export const LayoutLabel = Schema.Literals([
  "Caption",
  "Footnote",
  "Formula",
  "List-item",
  "Page-footer",
  "Page-header",
  "Picture",
  "Section-header",
  "Table",
  "Text",
  "Title"
])
export type LayoutLabel = typeof LayoutLabel.Type

/** `[y_min, x_min, y_max, x_max]`, normalized to 0-1000. This is Gemini's own order. */
export const LayoutBbox = Schema.Tuple([Schema.Int, Schema.Int, Schema.Int, Schema.Int])
export type LayoutBbox = typeof LayoutBbox.Type

export const LayoutElement = Schema.Struct({
  label: LayoutLabel,
  bbox: Schema.optionalKey(LayoutBbox),
  /** 1-based page, present when the model read more than one page. */
  page: Schema.optionalKey(Schema.Int),
  /** The element's content: markdown, or HTML for a table. */
  content: Schema.String
})
export type LayoutElement = typeof LayoutElement.Type

const decodeElement = Schema.decodeUnknownEffect(LayoutElement)

const CANONICAL_LABEL: Readonly<Record<string, LayoutLabel>> = Object.fromEntries(
  LayoutLabel.literals.flatMap((label) => {
    const key = label.toLowerCase()
    return [[key, label], [key.replace("-", "_"), label]] as const
  })
)

// ── prompts ───────────────────────────────────────────────────────────────────

export const SYSTEM_PROMPT = "You are a document parser. Your task is to convert " +
  "document images to clean, well-structured markdown." +
  "\n\nGuidelines:\n" +
  "- Preserve the document structure (headings, paragraphs, lists, tables)\n" +
  "- Convert tables to HTML format (<table>, <tr>, <th>, <td>)\n" +
  "- For existing tables in the document: use colspan and rowspan attributes to preserve merged cells " +
  "and hierarchical headers\n" +
  "- For charts/graphs being converted to tables: use flat combined column headers (e.g., " +
  "\"Primary 2015\" not separate rows) so each data cell's row contains all its labels\n" +
  "- Describe images/figures briefly in square brackets like [Figure: description]\n" +
  "- Preserve any code blocks with appropriate syntax highlighting\n" +
  "- Maintain reading order (left-to-right, top-to-bottom for Western documents)\n" +
  "- Do not add commentary or explanations - only output the parsed content\n\n" +
  "Additionally, wrap each layout element in a <div> tag with:\n" +
  "- data-bbox=\"[y_min, x_min, y_max, x_max]\" — bounding box in normalized 0-1000 coordinates where x is " +
  "horizontal (left edge = 0, right edge = 1000) and y is vertical (top = 0, bottom = 1000). " +
  "The order is [y_min, x_min, y_max, x_max].\n" +
  "- data-label=\"<category>\" — one of: Caption, Footnote, Formula, List-item, Page-footer, Page-header, " +
  "Picture, Section-header, Table, Text, Title\n\n" +
  "Place elements in reading order. Every piece of content must be inside exactly one <div> wrapper."

export const USER_PROMPT = "Parse this document page and output its content as clean markdown, with each " +
  "layout element wrapped in a <div data-bbox=\"[y_min,x_min,y_max,x_max]\" data-label=\"Category\"> tag. " +
  "Use HTML tables for any tabular data. For charts/graphs, use flat combined column headers. " +
  "Output ONLY the parsed content with div wrappers, no explanations."

const MULTIPAGE_SYSTEM_SUFFIX = "\n\nThis input is a multi-page PDF. For every layout element, add an " +
  "additional attribute data-page=\"N\" (1-indexed) indicating which page the element appears on. Emit " +
  "elements in reading order within each page, and pages in ascending order. Do not interleave pages."

export const SYSTEM_PROMPT_MULTIPAGE = SYSTEM_PROMPT + MULTIPAGE_SYSTEM_SUFFIX

export const USER_PROMPT_MULTIPAGE = USER_PROMPT +
  " Every <div> must include data-page=\"N\" (1-indexed) identifying its source page."

// ── decoding ──────────────────────────────────────────────────────────────────

const attribute = (openTag: string, name: string) =>
  openTag.match(new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1]

const parseBbox = (raw: string | undefined) => {
  if (!raw) return undefined
  const numbers = raw.replace(/[[\]]/g, "").split(/[,\s]+/).map(Number).filter(Number.isFinite)
  return numbers.length === 4 ? numbers.map((n) => Math.round(n)) : undefined
}

/**
 * One `<div …>…</div>` from the model into a typed element. An unknown label or
 * a malformed box degrades to `Text`: a model slip must not stop a conversion.
 */
export const decodeDiv = Effect.fn("ParseBenchParser.decodeDiv")(function*(html: string) {
  const open = html.match(/^<div\b([^>]*)>/i)
  const inner = (open ? html.slice(open[0].length).replace(/<\/div>\s*$/i, "") : html).trim()
  const attrs = open?.[1] ?? ""
  const bbox = parseBbox(attribute(attrs, "data-bbox"))
  const page = Number(attribute(attrs, "data-page"))
  const candidate = {
    label: CANONICAL_LABEL[(attribute(attrs, "data-label") ?? "").trim().toLowerCase()] ?? "Text",
    ...(bbox ? { bbox } : {}),
    ...(Number.isInteger(page) && page > 0 ? { page } : {}),
    content: inner
  }
  return yield* decodeElement(candidate).pipe(
    Effect.orElseSucceed((): LayoutElement => ({ label: "Text", content: inner }))
  )
})

// ── the transformer: elements to HTML ─────────────────────────────────────────

const escapeText = (text: string) =>
  text.replace(/&(?![a-zA-Z#0-9]+;)/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/** Inline markdown only: bold, italic, code, and safe links. */
const inlineHtml = (markdown: string): string =>
  escapeText(markdown.trim())
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
    .replace(/(^|[\s(])_([^_\s][^_]*)_/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, `<a href="$2">$1</a>`)

const attrsFor = (element: LayoutElement) =>
  `${element.page ? ` data-page="${element.page}"` : ""}${
    element.bbox ? ` data-bbox="${element.bbox.join(",")}"` : ""
  }`

const stripHeadingMarker = (markdown: string) => markdown.replace(/^\s*#{1,6}\s*/, "")
const stripListMarker = (markdown: string) => markdown.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
const looksLikeHtmlBlock = (content: string) => /^<(table|pre|ul|ol|dl|blockquote|figure|img)\b/i.test(content.trim())

const figureCaption = (content: string) => {
  const bracket = content.match(/\[(?:figure|image|chart|picture)\s*:\s*([^\]]+)\]/i)?.[1]
  const alt = content.match(/!\[([^\]]*)\]\([^)]*\)/)?.[1]
  return (bracket ?? alt ?? content.replace(/[[\]]/g, "")).trim() || "Figure"
}

export interface RenderOptions {
  /** Keep running headers and footers. They are dropped by default. */
  readonly keepPageFurniture?: boolean | undefined
}

/** Render one element. An empty string means the reader should not show it. */
export const render = (element: LayoutElement, options: RenderOptions = {}): string => {
  const attrs = attrsFor(element)
  const content = element.content.trim()
  if (!content) return ""
  switch (element.label) {
    case "Title":
      return `<h1${attrs}>${inlineHtml(stripHeadingMarker(content))}</h1>`
    case "Section-header":
      return `<h2${attrs}>${inlineHtml(stripHeadingMarker(content))}</h2>`
    case "Table":
      return looksLikeHtmlBlock(content) ? content : `<p${attrs}>${inlineHtml(content)}</p>`
    case "Picture":
      return `<figure${attrs}><figcaption>${inlineHtml(figureCaption(content))}</figcaption></figure>`
    case "Formula":
      return `<pre${attrs}><code>${escapeText(content.replace(/^\$\$\s*|\s*\$\$$/g, ""))}</code></pre>`
    case "List-item":
      return `<li${attrs}>${inlineHtml(stripListMarker(content))}</li>`
    case "Page-header":
    case "Page-footer":
      return options.keepPageFurniture ? `<p${attrs}>${inlineHtml(content)}</p>` : ""
    default:
      return looksLikeHtmlBlock(content) ? content : `<p${attrs}>${inlineHtml(content)}</p>`
  }
}

/** Elements to HTML text. Consecutive list items become one list. */
export const toHtml = <E, R>(
  elements: Stream.Stream<LayoutElement, E, R>,
  options: RenderOptions = {}
): Stream.Stream<string, E, R> =>
  Stream.suspend(() => {
    let items: Array<string> = []
    const flush = () => {
      if (items.length === 0) return []
      const list = `<ul>${items.join("")}</ul>`
      items = []
      return [list]
    }
    return elements.pipe(
      Stream.map((element) => {
        const rendered = render(element, options)
        if (!rendered) return []
        if (element.label === "List-item") {
          items.push(rendered)
          return []
        }
        return [...flush(), rendered]
      }),
      Stream.concat(Stream.fromEffect(Effect.sync(flush))),
      Stream.flattenIterable
    )
  })

// ── the parser ────────────────────────────────────────────────────────────────

export interface ParseBenchOptions extends RenderOptions {
  /** Used when a conversion brings no `ParserCredential`. */
  readonly apiKey?: Redacted.Redacted<string> | undefined
  readonly model?: string | undefined
  readonly baseUrl?: string | undefined
  readonly maxOutputTokens?: number | undefined
  readonly thinkingBudget?: number | undefined
}

const promptsFor = (part: PartRef | undefined) =>
  part === undefined
    ? { systemInstruction: SYSTEM_PROMPT_MULTIPAGE, prompt: USER_PROMPT_MULTIPAGE }
    : { systemInstruction: SYSTEM_PROMPT, prompt: USER_PROMPT }

/** The typed element stream: this parser's own return type, before any HTML. */
export const elements = (
  source: Source,
  options: ParseBenchOptions & {
    readonly apiKey: Redacted.Redacted<string>
    readonly part?: PartRef | undefined
  }
): Stream.Stream<LayoutElement, ParserError, HttpClient.HttpClient> =>
  Stream.suspend(() => {
    let buffer = ""
    const { prompt, systemInstruction } = promptsFor(options.part)
    return GeminiTransport.stream({
      parser: "parsebench",
      apiKey: options.apiKey,
      model: options.model ?? DEFAULT_MODEL,
      baseUrl: options.baseUrl,
      source,
      systemInstruction,
      prompt,
      generationConfig: {
        temperature: 0,
        maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingBudget: options.thinkingBudget ?? DEFAULT_THINKING_BUDGET }
      }
    }).pipe(
      Stream.map((delta) => {
        const { blocks, rest } = extractBlocks(buffer + delta)
        buffer = rest
        return blocks
      }),
      Stream.concat(Stream.fromEffect(Effect.sync(() => {
        const tail = buffer.trim()
        buffer = ""
        return tail ? [tail] : []
      }))),
      Stream.flattenIterable,
      Stream.mapEffect(decodeDiv)
    )
  })

/** Build the parser. Requires an `HttpClient`. */
export const make = Effect.fn("ParseBenchParser.make")(function*(options: ParseBenchOptions) {
  const client = yield* HttpClient.HttpClient
  const model = options.model ?? DEFAULT_MODEL

  const parse = (request: ParseRequest): Stream.Stream<string, ParserError> =>
    Stream.unwrap(Effect.gen(function*() {
      const supplied = yield* ParserCredential
      const apiKey = Option.getOrUndefined(supplied) ?? options.apiKey
      if (!apiKey) {
        return Stream.fail(
          new ParserError({
            parser: "parsebench",
            message: "No Gemini API key. Bring your own key, or set GEMINI_API_KEY on the server."
          })
        )
      }
      return toHtml(elements(request.source, { ...options, apiKey, part: request.part }), options)
    })).pipe(
      Stream.provideService(HttpClient.HttpClient, client),
      Stream.withSpan("ParseBenchParser.parse", {
        attributes: { model, mediaType: request.source.mediaType, part: request.part?.index }
      })
    )

  return Parser.of({ name: `parsebench:${model}`, parse })
})

export const layer = (options: ParseBenchOptions = {}): Layer.Layer<Parser, never, HttpClient.HttpClient> =>
  Layer.effect(Parser, make(options))

/** Parser layer from the optional `GEMINI_API_KEY` and `GEMINI_MODEL`. */
export const layerConfig: Layer.Layer<Parser, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(
  Parser,
  Effect.gen(function*() {
    const apiKey = yield* Config.option(Config.Redacted("GEMINI_API_KEY"))
    const model = yield* Config.String("GEMINI_MODEL").pipe(Config.withDefault(DEFAULT_MODEL))
    return yield* make({ apiKey: Option.getOrUndefined(apiKey), model })
  })
)

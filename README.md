# parser-stream

Stream a PDF into clean, sanitized, semantic HTML, block by block, while the model is still reading it.

**Live demo: https://parser-stream.steventsao.workers.dev** — bring your own [Gemini API key](https://aistudio.google.com/apikey); it is used for your upload only and never stored. Anyone with a document's link can view it, and the demo deletes documents 7 days after they finish, so do not upload anything sensitive.

```bash
pnpm install && cp .env.example .env    # put GEMINI_API_KEY in .env
pnpm cli convert examples/sample.pdf -o sample.html
```

Or run the app and watch a page fill in: `pnpm cli serve`.

## The parser

One plugin ships ready to use: **Gemini Flash with a layout prompt**. It is the prompt we use for [ParseBench](https://github.com/run-llama/ParseBench) runs, so its output is a known contract: markdown content, HTML tables, and one `<div data-bbox data-label>` per layout element, labelled with the DocLayNet categories.

The plugin owns that whole path, end to end:

```
1. prompt    "wrap each layout element in <div data-bbox="[y_min,x_min,y_max,x_max]" data-label="…">"
                                    │
2. model     <div data-label="Title" data-bbox="[58,98,83,887]" data-page="1">Season Report</div>
                                    │  decode with Schema
3. elements  LayoutElement { label: "Title", bbox: [58,98,83,887], page: 1, content: "Season Report" }
                                    │  render (the only place that picks a tag)
4. HTML      <h1 data-page="1" data-bbox="58,98,83,887">Season Report</h1>
```

- `LayoutLabel`, `LayoutBbox`, and `LayoutElement` are `Schema` types, so the shape is checked. An unknown label or a malformed box degrades to `Text` instead of failing the conversion.
- `render` maps a label to a tag: `Title` → `<h1>`, `Section-header` → `<h2>`, `List-item` → grouped `<ul>`, `Picture` → `<figure>`, `Table` → the model's own table. Running headers and footers are dropped.
- The box survives into the HTML as `data-bbox`, so a viewer can highlight the source region.
- Steps 1 to 3 are the contract (`@parser-stream/parsebench`); step 2's transport is Gemini (`@parser-stream/gemini`). The core sees only step 4.

Want the boxes without any HTML, for crops, search, or evaluation? Take the typed stream:

```ts
import { Effect, Redacted, Stream } from "effect"
import { GeminiFlashParseBenchParser } from "@parser-stream/gemini"

const elements = GeminiFlashParseBenchParser.elements(
  { bytes, mediaType: "application/pdf" },
  { apiKey: Redacted.make(process.env.GEMINI_API_KEY!) }
)

Stream.runForEach(elements, (element) => Effect.log(`${element.label} ${element.bbox?.join(",") ?? ""}`))
```

Multi-page PDFs are split into pages and converted in parallel, so page 3 can finish before page 1 without disturbing reading order. A page that fails after its retries shows an error in place.

`GEMINI_API_KEY` is optional: an upload can carry its own key, which the plugin reads from `Credential` and which no other layer ever sees.

## A small core, and plugins around it

**A plugin knows the core. The core knows no plugin, no transport, and no app.**

```
                    apps/cli · apps/worker          wiring: which plugin, which host
                              │
   @parser-stream/app         │        sessions · HTTP + SSE transport · routes · UI
            ▲                 │                  (one app; write your own instead)
            │  events: append · replace · progress · done
┌───────────┴───────────────────────────────────────────────────────────┐
│  parser-stream                                                        │
│  cut complete blocks · sanitize · number · reduce to a document        │
│  the HtmlStream port · Splitter · Sanitizer · Credential · PDF pages   │
└───────────▲───────────────────────────────────────────────────────────┘
            │  HTML text (chunks can split anywhere, even mid-tag)
   plugins: @parser-stream/gemini · /openai-compatible · /http · yours
            ▲
            │  Source: bytes + media type
```

| Package | Holds |
|---|---|
| `parser-stream` | the core: `HtmlStream`, `Converter`, `Splitter`, `Sanitizer`, `Credential`, the document reducer, the event contract, PDF page splitting |
| `@parser-stream/parsebench` | the ParseBench layout contract, with no provider in it |
| `@parser-stream/gemini` | `GeminiFlashParseBenchParser`, `GeminiHtmlParser`, and the shared transport |
| `@parser-stream/openai-compatible` | any OpenAI-compatible server: vLLM, Ollama, LM Studio |
| `@parser-stream/http` | your own endpoint, in any language |
| `@parser-stream/markdown` | markdown to HTML blocks, for models that answer in markdown |
| `@parser-stream/app` | live sessions plus the HTTP and SSE transport |
| `@parser-stream/node`, `@parser-stream/workers` | host adapters |

The core produces an **event stream**. A transport carries it: the app uses HTTP with Server-Sent Events, and another app can put the same stream on a WebSocket, a queue, or a file without touching the core.

## Write a plugin

A plugin is one function: a `Source` in, a stream of HTML text out. Chunks can split anywhere, even mid-tag; the core buffers them, cuts out complete top-level elements, sanitizes each one, and assigns ids.

```ts
import { Effect, Layer, Stream } from "effect"
import { Converter, Document, HtmlStream } from "parser-stream"
import { NodeSanitizer } from "@parser-stream/node"

const MyPlugin = HtmlStream.fromFunction("my-plugin", ({ part, source }) =>
  Stream.fromIterable([`<h1>${source.mediaType}</h1>`, `<p>part ${part?.index ?? "all"}</p>`])
)

const program = Effect.gen(function*() {
  const converter = yield* Converter
  const document = yield* converter.render({ bytes, mediaType: "application/pdf" })
  return Document.renderHtmlDocument({ title: "Report", blocks: document.blocks })
}).pipe(Effect.provide(Converter.layer.pipe(Layer.provide([MyPlugin, NodeSanitizer.layer]))))
```

`HtmlStreamRequest` has two fields: `source` (`{ bytes, mediaType, name? }`) and `part` (`{ unit, index, total }`, set when the source is one part of a larger document). Read `Credential` for the caller's secret. `examples/plain-text-parser.ts` is a plugin with no model at all, and `packages/gemini` is the full shape: options, `layer`, and `layerConfig`.

`PARSER` picks the plugin a host uses:

| `PARSER` | Plugin | For |
|---|---|---|
| `gemini-parsebench` (default) | Gemini Flash, layout contract, boxes and labels | the path above |
| `gemini-html` | Gemini Flash, asks for HTML directly | cheaper and faster, no boxes on text |
| `openai` | any OpenAI-compatible server | open-weight VLMs; needs image input, see [#1](https://github.com/steventsao/parser-stream/issues/1) |
| `http` | your own endpoint | anything else |

For `http`, the converter sends the source (or one part) and reads HTML back:

```
POST {PARSER_URL}?unit=page&index=3&total=12     (no query for a whole source)
content-type: application/pdf                    (the source media type)
accept: text/html
authorization: Bearer {the upload's key or PARSER_TOKEN}

<source bytes>
```

Respond `200` with HTML block elements, chunked for live output. `pnpm tsx examples/http-parser-stub.ts` is a stub that speaks it.

## Modes

| Mode | What happens |
|---|---|
| `whole` | One request for the whole source. Each complete block is **appended** as it arrives. |
| `split` | One request per part (per page for a PDF), `concurrency` at a time. An empty section per part is appended first, which pins reading order. Each part then **replaces** its own section as it streams. |
| `auto` (default) | `split` when the splitter finds more than one part, else `whole`. |

A streaming part also paints the finished rows of a table that has not closed yet, so a long table does not stall the page.

## Deploy to Cloudflare Workers

```bash
pnpm run deploy
```

The Worker serves the upload page. Each upload gets its own Durable Object, which runs the conversion, fans events out to viewers, and keeps the finished snapshot in its storage so the page still loads later.

Without a server key, every upload must bring its own key, so strangers cannot spend yours. `npx wrangler secret put GEMINI_API_KEY --config apps/worker/wrangler.toml` adds one. Watch a deployment work:

```bash
API_KEY=your-key scripts/smoke.sh https://parser-stream.<you>.workers.dev examples/sample.pdf
```

## The app layer

`@parser-stream/app` is one app over the core: live sessions plus an HTTP and SSE transport.

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Upload page. |
| `POST` | `/s` | Multipart form (`file`, `mode`, `api_key`) → `303` to `/s/:id`. Raw bytes also work: `content-type` is the media type, plus optional `x-filename` and `x-api-key`. Send `accept: application/json` to get `201` with URLs instead. |
| `GET` | `/s/:id` | The document page: the current snapshot, then live updates. Works without JavaScript once finished. |
| `GET` | `/s/:id/events` | Server-Sent Events. Resumes from `Last-Event-ID` or `?after=`. |
| `GET` | `/s/:id/snapshot` | Snapshot JSON: `status`, `phase`, `seq`, `blocks`. |
| `GET` | `/s/:id/document.html` | The finished document as a standalone file. |

### Event contract (`parser-stream.v1`)

Each SSE frame has `id: <seq>`, `event: <type>`, and `data: <json>`.

```jsonc
{ "version": "parser-stream.v1", "seq": 1, "type": "append", "block_id": "page-1", "html": "<section id=\"page-1\">…</section>" }
{ "version": "parser-stream.v1", "seq": 4, "type": "progress", "phase": "Converting 3 pages" }
{ "version": "parser-stream.v1", "seq": 5, "type": "replace", "target": "#page-2", "html": "<section id=\"page-2\">…</section>" }
{ "version": "parser-stream.v1", "seq": 22, "type": "done" }
```

- `seq` starts at 1 and increases by exactly 1.
- `append` and `replace` carry exactly one complete element whose root id is the addressed id.
- A stream ends with exactly one `done` or `error`.

The events come from the core (`Events.LiveEvent`, `Converter.convert`), so another transport can carry them unchanged.

## Security

Model output is derived from an untrusted document, and prompt instructions are not a security boundary.

- Every block crosses an allowlist sanitizer. It removes scripts, event handlers, styles, ids, and `javascript:`/`data:` URLs.
- Pages send a strict Content-Security-Policy (`script-src 'self'`, no inline scripts, no remote images).
- A key sent with an upload lives in memory for that conversion only. It is not stored, logged, or included in snapshots. "Remember the key" is opt-in and stays in that browser's `localStorage`.
- Session URLs are unguessable ids. Anyone with the URL can view the document.
- `serve` binds to `127.0.0.1` and rejects unknown `Host` headers, which blocks DNS rebinding.
- You are responsible for having the rights to the documents you convert.

## Development

```bash
pnpm typecheck
```

```bash
pnpm test
```

Tests never call a live model: they use `HtmlStream.fromFunction` and a fake `HttpClient` from `@parser-stream/testkit`.

The [open issues](https://github.com/steventsao/parser-stream/issues) come from checking the port against the whole ParseBench parser variety: an image splitter for local VLMs, plugin capabilities, timeout and retry rules for plugins that answer only once, a subprocess adapter, typed structured output, and usage reporting.

## License

MIT

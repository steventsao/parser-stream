# parser-stream

Stream a document into clean, sanitized, semantic HTML, block by block, while the parser is still working.

**Live demo: https://parser-stream.steventsao.workers.dev** — bring your own [Gemini API key](https://aistudio.google.com/apikey); it is used for your upload only and never stored. Anyone with a document's link can view it, and the demo deletes documents 7 days after they finish, so do not upload anything sensitive.

- **Redirect, then stream.** Upload a file, land on its page right away, and watch it fill in.
- **Bring your own key.** A key can come with each upload (never stored) or from the server.
- **Bring your own parser.** One port, one function.
- **Not only PDFs.** Input is bytes plus a media type.
- **Runs on Node or Cloudflare Workers.** Built with [Effect](https://effect.website) v4.

## Three layers, one rule

**Nothing above the parser knows how a parser works.**

```
┌─ Runtime ─────────────────────────────────────────────────────────────┐
│  cut complete blocks · sanitize · number · fan out · persist · serve  │
│  Converter · Sessions · routes        knows no tag, prompt, or key    │
└───────────────────────────▲───────────────────────────────────────────┘
        HTML text (chunks can split anywhere, even mid-tag)
┌───────────────────────────┴───────────────────────────────────────────┐
│  Parser: its prompt · the shape it asks for · decoding that shape     │
│  with Schema · the tags it emits · the credential it needs            │
│  ParseBenchParser · GeminiParser · HttpParser · yours                 │
└───────────────────────────▲───────────────────────────────────────────┘
                     Source: bytes + media type
```

Every seam is an Effect service, so each one is a layer you swap:

| Port | Default | Swap it to |
|---|---|---|
| `Parser` | `ParseBenchParser` | any model, OCR engine, or layout parser |
| `Splitter` | `PdfSplitter` (pdf-lib pages) | slides, sheets, image sets; `Splitter.none` to never split |
| `Sanitizer` | `NodeSanitizer` / the Workers `HTMLRewriter` | a tighter or wider allowlist |
| `SessionStore` | nothing kept; Durable Object storage on Workers | Redis, a database |
| `ServerConfig` | `ServerConfig.layer({ … })` | upload limits, media types, key field |
| `ParserCredential` | none | the per-upload secret a parser reads |

The engine passes no credentials. A parser that needs one reads `ParserCredential`, which the server fills from the upload, and raises its own error when it is missing.

## Quick start (Node)

Requires Node 22+ and pnpm.

```bash
pnpm install
```

```bash
cp .env.example .env
```

Put `GEMINI_API_KEY=...` in `.env`, or leave it empty and paste a key in the upload form. Then start the demo on http://127.0.0.1:3000:

```bash
pnpm cli serve
```

Or convert one file on the command line:

```bash
pnpm cli convert examples/sample.pdf -o sample.html
```

`examples/sample.pdf` is a small fictional three-page report (regenerate it with `pnpm tsx scripts/sample-pdf.ts`).

## Deploy to Cloudflare Workers

```bash
pnpm run deploy
```

The Worker serves the upload page. Each upload gets its own Durable Object, which runs the conversion, fans events out to viewers, and keeps the finished snapshot in its storage so the page still loads later.

Without a server key, every upload must bring its own key, so strangers cannot spend yours. To let uploads skip the key field, add one:

```bash
npx wrangler secret put GEMINI_API_KEY
```

Watch a deployment convert a file, event by event:

```bash
API_KEY=your-key scripts/smoke.sh https://parser-stream.<you>.workers.dev examples/sample.pdf
```

## The default parser

`ParseBenchParser` runs the layout prompt we use for [ParseBench](https://github.com/run-llama/ParseBench) runs on Gemini Flash: markdown content, HTML tables, and one `<div data-bbox data-label>` wrapper per layout element, labelled with the DocLayNet categories. The parser then decodes and renders it:

```
Gemini  →  <div data-label="Title" data-bbox="[10,20,30,40]" data-page="1">Season Report</div>
        →  LayoutElement { label: "Title", bbox: [10,20,30,40], page: 1, content: "Season Report" }   (Schema)
        →  <h1 data-page="1" data-bbox="10,20,30,40">Season Report</h1>                               (render)
```

`LayoutLabel`, `LayoutBbox`, and `LayoutElement` are `Schema` types, so the shape is checked, and an unknown label or a malformed box degrades to `Text` instead of failing the conversion. `render` is the only code that picks a tag: `Title` → `<h1>`, `Section-header` → `<h2>`, `List-item` → grouped `<ul>`, `Picture` → `<figure>`, `Table` → the model's own table, and running headers and footers are dropped.

Take the typed elements for your own use (crops, search indexes, evaluation) without any HTML:

```ts
import { Effect, Redacted, Stream } from "effect"
import { ParseBenchParser } from "parser-stream"

const elements = ParseBenchParser.elements(
  { bytes, mediaType: "application/pdf" },
  { apiKey: Redacted.make(process.env.GEMINI_API_KEY!) }
)

Stream.runForEach(elements, (element) => Effect.log(`${element.label} ${element.bbox?.join(",") ?? ""}`))
```

`GeminiParser` is the simpler alternative: it asks for semantic HTML directly, with no boxes on text.

## Bring your own parser

### In TypeScript

A parser is a `Stream` of HTML text. Chunks can split anywhere: the runtime buffers them, cuts out complete top-level elements, sanitizes each one, and assigns ids.

```ts
import { Effect, Layer, Stream } from "effect"
import { Converter, Document, Parser } from "parser-stream"
import { NodeSanitizer } from "parser-stream/node"

const MyParser = Parser.fromFunction("my-parser", ({ part, source }) =>
  Stream.fromIterable([`<h1>${source.mediaType}</h1>`, `<p>part ${part?.index ?? "all"}</p>`])
)

const program = Effect.gen(function*() {
  const converter = yield* Converter
  const document = yield* converter.render({ bytes, mediaType: "application/pdf" })
  return Document.renderHtmlDocument({ title: "Report", blocks: document.blocks })
}).pipe(Effect.provide(Converter.layer.pipe(Layer.provide([MyParser, NodeSanitizer.layer]))))
```

`ParseRequest` has two fields: `source` (`{ bytes, mediaType, name? }`) and `part` (`{ unit, index, total }`, set when the source is one part of a larger document). Read `ParserCredential` for the caller's secret. See `examples/plain-text-parser.ts` for a parser with no model at all.

### Over HTTP, in any language

Set `PARSER=http` and `PARSER_URL`. For each source (or part) the converter sends:

```
POST {PARSER_URL}?unit=page&index=3&total=12     (no query for a whole source)
content-type: application/pdf                    (the source media type)
accept: text/html
authorization: Bearer {the upload's key or PARSER_TOKEN}

<source bytes>
```

Respond `200` with HTML block elements. Use a chunked body for live output, or send it all at once. Any other status is a parser error. Try the contract without a model:

```bash
pnpm tsx examples/http-parser-stub.ts
```

Then, in a second terminal:

```bash
PARSER=http PARSER_URL=http://127.0.0.1:8000/parse pnpm cli convert examples/sample.pdf
```

`PARSER` selects the parser: `parsebench` (default), `gemini-html`, or `http`.

## Modes

| Mode | What happens |
|---|---|
| `whole` | One parser request for the whole source. Each complete block is **appended** as it arrives. |
| `split` | One request per part (per page for a PDF), `concurrency` at a time. An empty section per part is appended first, which pins reading order. Each part then **replaces** its own section as it streams, so parts can finish in any order. A part that fails after its retries shows an error in place. |
| `auto` (default) | `split` when the splitter finds more than one part, else `whole`. |

A streaming part also paints the finished rows of a table that has not closed yet, so a long table does not stall the page.

## HTTP routes

| Method | Path | Notes |
|---|---|---|
| `GET` | `/` | Upload page. |
| `POST` | `/s` | Multipart form (`file`, `mode`, `api_key`) → `303` to `/s/:id`. Raw bytes also work: `content-type` is the media type, plus optional `x-filename` and `x-api-key`. Send `accept: application/json` to get `201` with URLs instead of a redirect. |
| `GET` | `/s/:id` | The document page: the current snapshot, then live updates. Works without JavaScript once finished. |
| `GET` | `/s/:id/events` | Server-Sent Events. Resumes from `Last-Event-ID` or `?after=`. |
| `GET` | `/s/:id/snapshot` | Snapshot JSON: `status`, `phase`, `seq`, `blocks`. |
| `GET` | `/s/:id/document.html` | The finished document as a standalone file. |

```bash
curl -i -F file=@examples/sample.pdf -F api_key=$GEMINI_API_KEY http://127.0.0.1:3000/s
```

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

Schemas for these events are exported as `Events.LiveEvent`.

## Security

Parser output is derived from an untrusted document, and prompt instructions are not a security boundary.

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

Tests never call a live model: they use `Parser.fromFunction` and a fake `HttpClient`.

## License

MIT

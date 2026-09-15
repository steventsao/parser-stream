# parser-stream

Stream a document into clean, sanitized, semantic HTML, block by block, while the parser is still working.

- **Bring your own key.** The default parser is Gemini, which reads PDFs and images natively.
- **Bring your own parser.** Implement one function (`Source` in, HTML text stream out) in TypeScript, or put any parser in any language behind one HTTP endpoint.
- **Not only PDFs.** Input is bytes plus a media type. PDFs get page-level parallelism through an optional splitter; everything else is parsed whole.
- **Built with [Effect](https://effect.website) v4.** Every piece is a layer you can swap: parser, splitter, sanitizer, session store, HTTP server.

```
Source ─► Splitter? ─► Parser ─► block cutter ─► Sanitizer ─► ConvertEvent ─► Sessions ─► SSE / HTTP / file
 bytes     (pages)     text      complete         allowlist    append /        seq log +
 + type                chunks    elements                      replace         fan-out
```

## Quick start

Requires Node 22+ and pnpm.

```bash
pnpm install
cp .env.example .env
```

Put your key in `.env` (`GEMINI_API_KEY=...`, get one at https://aistudio.google.com/apikey). Then convert a file:

```bash
pnpm cli convert report.pdf -o report.html
```

Or start the demo UI and HTTP API on http://127.0.0.1:3000:

```bash
pnpm cli serve
```

## Modes

| Mode | What happens |
|---|---|
| `whole` | One parser request for the whole source. Each complete block is **appended** as it arrives. |
| `split` | One request per part (per page for a PDF), `--concurrency` at a time. An empty section per part is appended first, which pins reading order. Each part then **replaces** its own section as it streams, so parts can finish in any order. A part that fails after its retries shows an error in place. |
| `auto` (default) | `split` when the splitter finds more than one part, else `whole`. |

A streaming part also paints the finished rows of a table that has not closed yet, so a long table does not stall the page.

## Bring your own parser

### In TypeScript

A parser is a `Stream` of HTML text. Chunks can split anywhere, even inside a tag: the converter buffers them, cuts out complete top-level elements, sanitizes each one, and assigns ids.

```ts
import { Effect, Layer, Stream } from "effect"
import { Converter, Document, Parser } from "@steventsao/parser-stream"

const MyParser = Parser.fromFunction("my-parser", ({ source, part }) =>
  Stream.fromIterable([`<h1>${source.mediaType}</h1>`, `<p>part ${part?.index ?? "all"}</p>`])
)

const program = Effect.gen(function*() {
  const converter = yield* Converter
  const document = yield* converter.render({ bytes, mediaType: "application/pdf" })
  return Document.renderHtmlDocument({ title: "Report", blocks: document.blocks })
}).pipe(Effect.provide(Converter.layer.pipe(Layer.provide(MyParser))))
```

`ParseRequest` has three fields:

- `source`: `{ bytes, mediaType, name? }`
- `prompt`: a default instruction for vision-language models (ignore it if you are not one)
- `part`: `{ unit, index, total }` when the source is one part of a larger document

For a full parser with dependencies, use `Layer.effect(Parser, ...)`. See `src/parsers/Gemini.ts`, and see `examples/plain-text-parser.ts` for a parser that has nothing to do with PDFs.

### Over HTTP, in any language

Set `PARSER=http` and `PARSER_URL`. For each source (or part) the converter sends:

```
POST {PARSER_URL}?unit=page&index=3&total=12     (no query for a whole source)
content-type: application/pdf                    (the source media type)
accept: text/html
authorization: Bearer {PARSER_TOKEN}             (only when PARSER_TOKEN is set)

<source bytes>
```

Respond `200` with HTML block elements. Use a chunked body for live output, or send it all at once. Any other status is a parser error. Try the contract without a model:

```bash
pnpm tsx examples/http-parser-stub.ts
```

Then, in a second terminal:

```bash
PARSER=http PARSER_URL=http://127.0.0.1:8000/parse pnpm cli convert report.pdf
```

### Other ports

| Port | Default layer | Replace it to |
|---|---|---|
| `Parser` | `GeminiParser.layerConfig` or `HttpParser.layerConfig` | use another model, OCR engine, or layout parser |
| `Splitter` | `PdfSplitter.layer` (pdf-lib) | split slides, sheets, or scanned image sets; `Splitter.none` disables splitting |
| `Sanitizer` | `Sanitizer.layer` (lol-html allowlist) | tighten or extend the allowlist |
| `Sessions` | `Sessions.layer` (in memory) | keep sessions in Redis, a database, or a Durable Object |

## HTTP API

| Method | Path | Notes |
|---|---|---|
| `POST` | `/api/sessions?mode=auto` | Body: file bytes. `content-type`: the media type. Optional `x-filename`. Returns `201` with URLs. |
| `GET` | `/api/sessions/:id` | Snapshot: `status`, `phase`, `seq`, `blocks`. |
| `GET` | `/api/sessions/:id/events` | Server-Sent Events. Resumes from `Last-Event-ID` or `?after=`. |
| `GET` | `/api/sessions/:id/document.html` | The document as a standalone file. |

```bash
curl -s -X POST 'http://127.0.0.1:3000/api/sessions' \
  -H 'content-type: application/pdf' -H 'x-filename: report.pdf' \
  --data-binary @report.pdf
```

Then stream the session events:

```bash
curl -N http://127.0.0.1:3000/api/sessions/<id>/events
```

### Event contract (`parser-stream.v1`)

Each SSE frame has `id: <seq>`, `event: <type>`, and `data: <json>`.

```jsonc
{ "version": "parser-stream.v1", "seq": 1, "type": "append", "block_id": "page-1", "html": "<section id=\"page-1\">…</section>" }
{ "version": "parser-stream.v1", "seq": 5, "type": "replace", "target": "#page-1", "html": "<section id=\"page-1\">…</section>" }
{ "version": "parser-stream.v1", "seq": 6, "type": "progress", "phase": "Converting 3 pages" }
{ "version": "parser-stream.v1", "seq": 9, "type": "done" }
{ "version": "parser-stream.v1", "seq": 9, "type": "error", "message": "…" }
```

- `seq` starts at 1 and increases by exactly 1.
- `append` and `replace` carry exactly one complete element whose root id is the addressed id.
- A stream ends with exactly one `done` or `error`.

Schemas for these events are exported as `Events.LiveEvent`.

## Security

Parser output is derived from an untrusted document, and prompt instructions are not a security boundary.

- Every block crosses an allowlist sanitizer. It removes scripts, event handlers, styles, ids, and `javascript:`/`data:` URLs.
- The demo UI sends a strict Content-Security-Policy (`script-src 'self'`, no inline scripts, no remote images).
- `serve` binds to `127.0.0.1` and rejects unknown `Host` headers, which blocks DNS rebinding. Bind elsewhere only when you trust the network: anyone who can reach the server can spend your key.
- The Gemini key goes in a request header, never in a URL.
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

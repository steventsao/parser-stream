/**
 * A stub that speaks the HTTP parser contract, so you can try `PARSER=http`
 * without a model. Replace the body of `handle` with a call to your own parser
 * (a layout model, an OCR engine, a Python service, ...).
 *
 *   pnpm tsx examples/http-parser-stub.ts                # listens on 127.0.0.1:8000
 *   PARSER=http PARSER_URL=http://127.0.0.1:8000/parse pnpm cli convert report.pdf
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const handle = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", "http://localhost")
  if (req.method !== "POST" || url.pathname !== "/parse") {
    res.writeHead(404).end()
    return
  }
  let size = 0
  for await (const chunk of req) size += (chunk as Buffer).length

  const unit = url.searchParams.get("unit")
  const label = unit ? `${unit} ${url.searchParams.get("index")} of ${url.searchParams.get("total")}` : "the whole document"
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
  // Chunks may split anywhere, even inside a tag.
  for (const chunk of [`<h2>Stub output for ${label}</h2><p>Received ${size} bytes of `, `${req.headers["content-type"]}.</p>`]) {
    res.write(chunk)
    await sleep(200)
  }
  res.end()
}

createServer((req, res) => {
  handle(req, res).catch(() => res.destroy())
}).listen(8000, "127.0.0.1", () => console.log("HTTP parser stub on http://127.0.0.1:8000/parse"))

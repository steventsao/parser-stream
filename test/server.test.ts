import { NodeHttpServer } from "@effect/platform-node"
import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { request as httpRequest } from "node:http"
import { Routes } from "../src/http/Routes.js"
import { Sessions } from "../src/Sessions.js"
import { chunked, converterWith, makePdf } from "./fixtures.js"

const TestServer = HttpRouter.serve(Routes, { disableLogger: true, disableListenLog: true }).pipe(
  Layer.provide(Sessions.layer.pipe(Layer.provide(converterWith(() => chunked(["<h1>Hello</h1>", "<p>World</p>"]))))),
  Layer.provideMerge(NodeHttpServer.layerTest)
)

/** `fetch` always derives Host from the URL, so a spoofed Host needs a raw request. */
const statusWithHost = (port: number, host: string) =>
  Effect.callback<number>((resume) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/", headers: { host } }, (res) => {
      res.resume()
      resume(Effect.succeed(res.statusCode ?? 0))
    })
    req.on("error", (error) => resume(Effect.die(error)))
    req.end()
  })

layer(TestServer)("HTTP server", (it) => {
  it.effect("serves the demo page with a strict CSP", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.get("/")
      assert.strictEqual(response.status, 200)
      assert.include(response.headers["content-security-policy"] ?? "", "script-src 'self'")
      assert.include(yield* response.text, `<main id="doc" class="doc">`)
    }))

  it.effect("uploads a PDF, streams events, and serves the finished file", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const created = yield* client.execute(
        HttpClientRequest.post("/api/sessions?mode=whole").pipe(
          HttpClientRequest.setHeader("x-filename", "Quarterly%20report.pdf"),
          HttpClientRequest.bodyUint8Array(yield* makePdf(1), "application/pdf")
        )
      )
      assert.strictEqual(created.status, 201)
      const body = (yield* created.json) as { id: string; events_url: string; document_url: string }

      const events = yield* Effect.flatMap(client.get(body.events_url), (response) => response.text)
      assert.include(events, "event: append")
      assert.include(events, "event: done")

      const file = yield* client.get(body.document_url)
      assert.include(file.headers["content-disposition"] ?? "", "Quarterly-report.html")
      const html = yield* file.text
      assert.include(html, `<h1 id="block-1">Hello</h1>`)
      assert.include(html, "<title>Quarterly report</title>")
    }))

  it.effect("rejects unsupported uploads", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      const response = yield* client.execute(
        HttpClientRequest.post("/api/sessions").pipe(HttpClientRequest.bodyText("hello", "text/plain"))
      )
      assert.strictEqual(response.status, 415)
      const fake = yield* client.execute(
        HttpClientRequest.post("/api/sessions").pipe(
          HttpClientRequest.bodyUint8Array(new TextEncoder().encode("not a pdf"), "application/pdf")
        )
      )
      assert.strictEqual(fake.status, 422)
    }))

  it.effect("rejects a foreign Host header", () =>
    Effect.gen(function*() {
      const { address } = yield* HttpServer.HttpServer
      if (address._tag === "UnixPathAddress") return assert.fail("expected a TCP test server")
      assert.strictEqual(yield* statusWithHost(address.port, "evil.test"), 403)
      assert.strictEqual(yield* statusWithHost(address.port, `localhost:${address.port}`), 200)
    }))

  it.effect("returns 404 for an unknown session", () =>
    Effect.gen(function*() {
      const client = yield* HttpClient.HttpClient
      assert.strictEqual((yield* client.get("/api/sessions/nope")).status, 404)
      assert.strictEqual((yield* client.get("/api/sessions/nope/events")).status, 404)
    }))
})

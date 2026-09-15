import { Effect, Layer, Option, Redacted, Stream } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { describe, expect, it } from "vitest"
import { Routes, ServerConfig, type ServerOptions } from "../src/http/Routes.js"
import type { PartRef } from "../src/Parser.js"
import { ParserCredential } from "../src/ParserCredential.js"
import { Sessions } from "../src/Sessions.js"
import { chunked, converterWith, makePdf } from "./fixtures.js"

interface Seen {
  readonly keys: Array<string | undefined>
  readonly parts: Array<PartRef | undefined>
}

/** The same routes the Node server and the Durable Object run, driven through web Requests. */
const webApp = (keyField: ServerOptions["keyField"], seen: Seen = { keys: [], parts: [] }) => {
  const sessions = Sessions.layer.pipe(
    Layer.provide(converterWith((request) =>
      Stream.unwrap(Effect.gen(function*() {
        // The parser reads its own credential; the engine never passes one.
        const credential = yield* ParserCredential
        seen.keys.push(Option.isSome(credential) ? Redacted.value(credential.value) : undefined)
        seen.parts.push(request.part)
        return chunked(["<h1>Hello</h1>", "<p>World</p>"])
      }))
    ))
  )
  const config = ServerConfig.layer({ allowedHosts: "any", keyField })
  return HttpRouter.toWebHandler(Routes.pipe(HttpRouter.provideRequest(Layer.mergeAll(sessions, config))), {
    disableLogger: true
  })
}

const pdfFile = async (name: string) => {
  const bytes = await Effect.runPromise(makePdf(1))
  return new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "application/pdf" })
}

const get = (app: ReturnType<typeof webApp>, path: string) => app.handler(new Request(`http://localhost${path}`))

describe("web flow", () => {
  it("redirects a form upload to a page that streams, and hands the key to the parser", async () => {
    const seen: Seen = { keys: [], parts: [] }
    const app = webApp("required", seen)
    const form = new FormData()
    form.set("file", await pdfFile("Field notes.pdf"))
    form.set("mode", "whole")
    form.set("api_key", "user-key")

    const created = await app.handler(new Request("http://localhost/s", { method: "POST", body: form }))
    expect(created.status).toBe(303)
    const location = created.headers.get("location") ?? ""
    expect(location).toMatch(/^\/s\/[0-9a-f-]{36}$/)

    const events = await (await get(app, `${location}/events`)).text()
    expect(events).toContain("event: append")
    expect(events).toContain("event: done")

    const page = await get(app, location)
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'")
    const html = await page.text()
    expect(html).toContain(`data-status="done"`)
    expect(html).toContain(`<h1 id="block-1">Hello</h1>`)
    expect(html).toContain("<title>Field notes</title>")

    // The key reached the parser inside the background conversion, and is in no snapshot.
    expect(seen.keys).toEqual(["user-key"])
    expect(seen.parts).toEqual([undefined])
    const snapshot = await (await get(app, `${location}/snapshot`)).text()
    expect(snapshot).not.toContain("user-key")
    await app.dispose()
  })

  it("asks for a key before any work when the server has none", async () => {
    const seen: Seen = { keys: [], parts: [] }
    const app = webApp("required", seen)
    const form = new FormData()
    form.set("file", await pdfFile("a.pdf"))
    const response = await app.handler(new Request("http://localhost/s", { method: "POST", body: form }))
    expect(response.status).toBe(400)
    expect(await response.text()).toContain("API key")
    expect(seen.keys).toHaveLength(0)
    await app.dispose()
  })

  it("answers API clients with JSON", async () => {
    const app = webApp("hidden")
    const bytes = await Effect.runPromise(makePdf(1))
    const response = await app.handler(
      new Request("http://localhost/s?mode=whole", {
        method: "POST",
        body: bytes as Uint8Array<ArrayBuffer>,
        headers: { "content-type": "application/pdf", accept: "application/json", "x-filename": "api.pdf" }
      })
    )
    expect(response.status).toBe(201)
    const body = (await response.json()) as { id: string; url: string; events_url: string }
    expect(body.url).toBe(`/s/${body.id}`)
    expect(body.events_url).toBe(`/s/${body.id}/events`)
    await app.dispose()
  })

  it("shows the key field only when it is needed", async () => {
    const required = webApp("required")
    expect(await (await get(required, "/")).text()).toMatch(/name="api_key"[^>]*required/)
    await required.dispose()
    const hidden = webApp("hidden")
    expect(await (await get(hidden, "/")).text()).not.toContain(`name="api_key"`)
    await hidden.dispose()
  })

  it("renders a 404 page for an unknown session", async () => {
    const app = webApp("hidden")
    const response = await get(app, "/s/unknown")
    expect(response.status).toBe(404)
    expect(await response.text()).toContain("<a href=\"/\">")
    await app.dispose()
  })
})

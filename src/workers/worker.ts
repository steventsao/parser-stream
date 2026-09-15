import { DurableObject } from "cloudflare:workers"
import { Layer, Redacted } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { Converter } from "../Converter.js"
import { PageRoutes, ServerConfig, SessionRoutes } from "../http/Routes.js"
import { renderMessagePage } from "../http/Ui.js"
import * as GeminiParser from "../parsers/Gemini.js"
import { NewSessionId, Sessions } from "../Sessions.js"
import * as WorkersSanitizer from "./Sanitizer.js"
import * as DurableSessionStore from "./SessionStore.js"

/**
 * Cloudflare deployment. The Worker serves the upload page and routes every
 * `/s/:id` request to that session's own Durable Object, which runs the
 * conversion and fans its events out. Both run the same Effect routes as the
 * Node server.
 *
 * Without a `GEMINI_API_KEY` secret, every upload must bring its own key.
 */

export interface Env {
  readonly SESSIONS: DurableObjectNamespace<SessionObject>
  readonly GEMINI_API_KEY?: string
  readonly GEMINI_MODEL?: string
}

const serverConfig = (env: Env) =>
  ServerConfig.layer({
    // A public deployment is reached through its own hostname; DNS rebinding protection is for localhost.
    allowedHosts: "any",
    keyField: env.GEMINI_API_KEY ? "optional" : "required"
  })

/** Finished documents are deleted this long after they finish. */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export class SessionObject extends DurableObject<Env> {
  private readonly web: { readonly handler: (request: Request) => Promise<Response> }
  private expired = false

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const parser = GeminiParser.layer({
      apiKey: env.GEMINI_API_KEY ? Redacted.make(env.GEMINI_API_KEY) : undefined,
      model: env.GEMINI_MODEL
    }).pipe(Layer.provide(FetchHttpClient.layer))
    const converter = Converter.layer.pipe(Layer.provide([parser, WorkersSanitizer.layer]))
    const sessions = Sessions.layer.pipe(
      Layer.provide([
        converter,
        Layer.succeed(NewSessionId)(() => ctx.id.toString()),
        DurableSessionStore.layer(ctx.storage, { retentionMs: RETENTION_MS })
      ])
    )
    // `provideRequest` builds the layer once per object, so one session runtime serves every request.
    this.web = HttpRouter.toWebHandler(
      SessionRoutes.pipe(HttpRouter.provideRequest(Layer.mergeAll(sessions, serverConfig(env)))),
      { disableLogger: true }
    )
  }

  override async fetch(request: Request): Promise<Response> {
    if (this.expired) return new Response("Not found", { status: 404 })
    return this.web.handler(request)
  }

  override async alarm(): Promise<void> {
    // The in-memory copy of this session must not outlive its storage.
    this.expired = true
    await this.ctx.storage.deleteAll()
  }
}

type WebHandler = { readonly handler: (request: Request) => Promise<Response> }

let pages: WebHandler | undefined

const pagesFor = (env: Env): WebHandler =>
  (pages ??= HttpRouter.toWebHandler(PageRoutes.pipe(HttpRouter.provideRequest(serverConfig(env))), {
    disableLogger: true
  }))

const SESSION_PATH = /^\/s\/([0-9a-f]{64})(?:\/|$)/

const notFound = () =>
  new Response(renderMessagePage("Not found", "This document does not exist or is no longer kept."), {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'"
    }
  })

/** `idFromString` throws for an id this namespace never issued, such as a tampered link. */
const sessionStub = (env: Env, hex: string) => {
  try {
    return env.SESSIONS.get(env.SESSIONS.idFromString(hex))
  } catch {
    return undefined
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === "/s" && request.method === "POST") {
      return env.SESSIONS.get(env.SESSIONS.newUniqueId()).fetch(request)
    }
    if (url.pathname.startsWith("/s/")) {
      const hex = url.pathname.match(SESSION_PATH)?.[1]
      const stub = hex ? sessionStub(env, hex) : undefined
      return stub ? stub.fetch(request) : notFound()
    }
    return pagesFor(env).handler(request)
  }
} satisfies ExportedHandler<Env>

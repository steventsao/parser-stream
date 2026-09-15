import { DurableObject } from "cloudflare:workers"
import { Layer, Redacted } from "effect"
import { FetchHttpClient, HttpRouter } from "effect/unstable/http"
import { Converter } from "../Converter.js"
import { PageRoutes, ServerConfig, SessionRoutes } from "../http/Routes.js"
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

export class SessionObject extends DurableObject<Env> {
  private readonly web: { readonly handler: (request: Request) => Promise<Response> }

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
        DurableSessionStore.layer(ctx.storage)
      ])
    )
    // `provideRequest` builds the layer once per object, so one session runtime serves every request.
    this.web = HttpRouter.toWebHandler(
      SessionRoutes.pipe(HttpRouter.provideRequest(Layer.mergeAll(sessions, serverConfig(env)))),
      { disableLogger: true }
    )
  }

  override fetch(request: Request): Promise<Response> {
    return this.web.handler(request)
  }
}

type WebHandler = { readonly handler: (request: Request) => Promise<Response> }

let pages: WebHandler | undefined

const pagesFor = (env: Env): WebHandler =>
  (pages ??= HttpRouter.toWebHandler(PageRoutes.pipe(HttpRouter.provideRequest(serverConfig(env))), {
    disableLogger: true
  }))

const SESSION_PATH = /^\/s\/([0-9a-f]{64})(?:\/|$)/

export default {
  fetch(request, env) {
    const url = new URL(request.url)
    if (url.pathname === "/s" && request.method === "POST") {
      return env.SESSIONS.get(env.SESSIONS.newUniqueId()).fetch(request)
    }
    const session = url.pathname.match(SESSION_PATH)
    if (session) return env.SESSIONS.get(env.SESSIONS.idFromString(session[1]!)).fetch(request)
    if (url.pathname.startsWith("/s/")) return new Response("Not found", { status: 404 })
    return pagesFor(env).handler(request)
  }
} satisfies ExportedHandler<Env>

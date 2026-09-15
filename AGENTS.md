# Agent notes

## Learning more about Effect

This repository uses the Effect TypeScript library (v4 release candidate).

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
Several v3 names changed in v4 (for example `Config.String`, `Context.Service`,
`Stream.timeoutOrElse`); trust the installed source over memory.

## The one rule

**A plugin knows the core. The core knows no plugin, no transport, and no app.**

| Package | Directory | Owns | Must never |
|---|---|---|---|
| `parser-stream` | `packages/core` | the `HtmlStream` port, the streaming DOM engine (cut, sanitize, number), the document reducer, the event contract, `Credential`, PDF page splitting | name a tag, a prompt, a model, a credential, a transport, or a route; import any other package here |
| `@parser-stream/parsebench` | `packages/parsebench` | the ParseBench layout contract: prompts, the `Schema`-typed `LayoutElement`, the renderer that picks tags | name a provider or a transport |
| `@parser-stream/gemini` | `packages/gemini` | the Gemini transport, `GeminiFlashParseBenchParser` (contract + Flash), `GeminiHtmlParser` | reach into the core's internals |
| `@parser-stream/openai-compatible`, `/http`, `/markdown` | `packages/*` | the other plugins and the markdown helper | depend on the app |
| `@parser-stream/app` | `packages/app` | live sessions and the HTTP + SSE transport: routes, pages, replay | become the only way to use the core |
| `@parser-stream/node`, `/workers` | `packages/*` | host adapters: sanitizers, HTTP server, Durable Object store | hold engine logic |
| `apps/cli`, `apps/worker` | `apps/*` | wiring: which plugin, which sanitizer, which config | hold anything reusable |

The core produces an event stream. HTTP with Server-Sent Events is one transport, and it lives in `@parser-stream/app`. Another app can carry the same events over a WebSocket, a queue, or a file.

## Writing a plugin

1. Implement the port: `HtmlStream.of({ name, parse })`, where `parse` returns `Stream<string, HtmlStreamError>`.
2. Own your prompt, the shape you ask for, its decoding (use `Schema`), and the tags you emit.
3. Read `Credential` for the caller's secret, and raise your own error when it is missing.
4. Publish `layer(options)` and `layerConfig(options?)`, where `layerConfig` accepts `Config` values and falls back to your own environment variables, so a host can pick you with one line.

## Rules

- A source is bytes plus a media type. Do not add PDF assumptions outside `packages/core/src/splitters/Pdf.ts`.
- Every block a plugin produces crosses `Sanitizer` before it is stored or sent. Server-built wrappers are added after.
- Only `packages/node` and `apps/cli` may import `node:*`, `@effect/platform-node`, or `html-rewriter-wasm`: the Worker bundles the rest.
- A caller's key stays in memory. Never store, log, or return it.
- Send a key in a header, never in a URL. Effect redacts only `authorization`, `cookie`, `set-cookie`, and `x-api-key`, so add any other auth header to `Headers.CurrentRedactedNames`, as `packages/gemini/src/Transport.ts` does with `x-goog-api-key`.
- Route handlers only see services the router tracks: use `Context.Service` (not `Context.Reference`) for anything they read, and `HttpRouter.provideRequest` with `toWebHandler`.
- Tests live in `packages/*/test`, never call a live model, and use `@parser-stream/testkit`.
- A package's `exports` point at `src` for development; its `publishConfig.exports` point at `dist`. Keep both in step when you add a subpath, and give the new project a `references` entry in its `tsconfig.build.json`.
- Run `pnpm typecheck` and `pnpm test` before you commit, and `pnpm build` when you touch a package boundary. Deploy with `pnpm run deploy`.

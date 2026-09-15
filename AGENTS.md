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

Nothing above the parser knows how a parser works, and the core knows nothing about apps.

| Directory | Package entry | Owns | Must never |
|---|---|---|---|
| `src/core/` | `parser-stream` | the block contract (cut, sanitize, number), the document reducer, the event stream, and the ports | name a tag, a prompt, a model, a credential, a transport, or a route; import an adapter |
| `src/parsers/` | `parser-stream/parsers` | each parser's prompt, requested shape, decoding, tags, and credential | reach into the core's internals or the app |
| `src/splitters/` | `parser-stream/splitters` | cutting a source into parts | anything else |
| `src/app/` | `parser-stream/app` | live sessions and the HTTP/SSE transport: routes, pages, replay | become the only way to use the core |
| `src/node/`, `src/workers/` | `parser-stream/node`, `/workers/*` | host wiring: sanitizer, server, Durable Object, env config | hold engine logic |

The core produces an event stream. HTTP with Server-Sent Events is one transport for it, and it lives in `src/app/`. A different app can put the same stream on a WebSocket, a queue, or a file without touching the core.

## Rules

- A parser is any `Source` in, HTML text stream out. Do not add PDF assumptions outside `src/splitters/Pdf.ts`.
- A parser that needs a secret reads `ParserCredential` and raises its own error. The engine passes no keys.
- `Converter.layer` requires all three ports (`Parser`, `Sanitizer`, `Splitter`). The host wiring provides them.
- Every block a parser produces crosses `Sanitizer` before it is stored or sent. Server-built wrappers are added after.
- Nothing outside `src/node/` may import `node:*`, `@effect/platform-node`, or `html-rewriter-wasm`: the Worker bundles the rest.
- A caller's key stays in memory. Never store, log, or return it.
- Route handlers only see services the router tracks: use `Context.Service` (not `Context.Reference`) for anything they read, and `HttpRouter.provideRequest` with `toWebHandler`.
- Tests never call a live model. Use `Parser.fromFunction` or the `fakeGemini` client in `test/fixtures.ts`.
- Run `pnpm typecheck` and `pnpm test` before you commit. Deploy with `pnpm run deploy`.

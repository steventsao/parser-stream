# Agent notes

## Learning more about Effect

This repository uses the Effect TypeScript library (v4 release candidate).

Before writing any Effect code, first read `node_modules/effect/AGENTS.md`
**completely**, and follow the links in the file when required.

If you need to learn more about particular Effect apis and concepts that the
guide doesn't cover, search through the source code in `node_modules/effect/src`.
Several v3 names changed in v4 (for example `Config.String`, `Context.Service`,
`Stream.timeoutOrElse`); trust the installed source over memory.

## Layout

- `src/domain/` is pure: string transforms, the document reducer, the wire contract. No Effect services, no IO.
- `src/Parser.ts`, `src/Splitter.ts`, `src/Sanitizer.ts`, `src/Sessions.ts` define services (ports).
- `src/parsers/`, `src/splitters/` are runtime-neutral adapters.
- `src/Converter.ts` is the engine. It depends on ports only.
- `src/http/` holds the shared web routes and the plain UI (upload → 303 → `/s/:id` streams).
- `src/node/` is Node-only (lol-html sanitizer, env wiring, HTTP server). `src/bin.ts` is the CLI.
- `src/workers/` is Cloudflare-only. `worker.ts` is the deploy entry: the Worker serves pages, one Durable Object per session runs `SessionRoutes`.

## Rules

- A parser is any `Source` in, HTML text stream out. Do not add PDF assumptions outside `src/splitters/Pdf.ts`.
- Every block produced by a parser crosses `Sanitizer` before it is stored or sent. Server-built wrappers are added after.
- Nothing outside `src/node/` may import `node:*`, `@effect/platform-node`, or `html-rewriter-wasm`: the Worker bundles the rest.
- A caller's key (`ConvertOptions.credential`) stays in memory. Never store, log, or return it.
- Route handlers only see services the router tracks: use `Context.Service` (not `Context.Reference`) for anything they read, and `HttpRouter.provideRequest` with `toWebHandler`.
- Tests never call a live model. Use `Parser.fromFunction` or a fake `HttpClient`.
- Run `pnpm typecheck` and `pnpm test` before you commit. Deploy with `pnpm run deploy`.

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
- `src/Parser.ts`, `src/Splitter.ts`, `src/Sanitizer.ts` are ports (`Context.Service`).
- `src/parsers/`, `src/splitters/` are adapters that provide those ports as layers.
- `src/Converter.ts` is the engine. It depends on ports only.
- `src/Sessions.ts` owns live state and fan-out; `src/http/` exposes it; `src/App.ts` wires env config.

## Rules

- A parser is any `Source` in, HTML text stream out. Do not add PDF assumptions outside `src/splitters/Pdf.ts`.
- Every block produced by a parser crosses `Sanitizer` before it is stored or sent. Server-built wrappers are added after.
- Tests never call a live model. Use `Parser.fromFunction` or a fake `HttpClient`.
- Run `pnpm typecheck` and `pnpm test` before you commit.

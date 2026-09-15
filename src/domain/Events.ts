import { Schema } from "effect"

/**
 * Wire contract for a live conversion. Clients receive these as Server-Sent
 * Events: `id` is `seq`, `event` is `type`, `data` is the JSON event.
 *
 * - `seq` starts at 1 and increases by exactly 1.
 * - `append` and `replace` carry exactly one complete, sanitized top-level
 *   element whose root id is `block_id` (or `target` without the `#`).
 * - A stream ends with exactly one `done` or `error` event.
 */
export const CONTRACT_VERSION = "parser-stream.v1" as const

const base = {
  version: Schema.Literal(CONTRACT_VERSION),
  seq: Schema.Int
}

export const ProgressEvent = Schema.Struct({ ...base, type: Schema.Literal("progress"), phase: Schema.String })
export const AppendEvent = Schema.Struct({
  ...base,
  type: Schema.Literal("append"),
  block_id: Schema.String,
  html: Schema.String
})
export const ReplaceEvent = Schema.Struct({
  ...base,
  type: Schema.Literal("replace"),
  target: Schema.String,
  html: Schema.String
})
export const DoneEvent = Schema.Struct({ ...base, type: Schema.Literal("done") })
export const ErrorEvent = Schema.Struct({ ...base, type: Schema.Literal("error"), message: Schema.String })

export const LiveEvent = Schema.Union([ProgressEvent, AppendEvent, ReplaceEvent, DoneEvent, ErrorEvent])
export type LiveEvent = typeof LiveEvent.Type

/** What the converter produces. The session layer adds `version` and `seq`. */
export type ConvertEvent =
  | { readonly type: "progress"; readonly phase: string }
  | { readonly type: "append"; readonly id: string; readonly html: string }
  | { readonly type: "replace"; readonly id: string; readonly html: string }

export type TerminalEvent =
  | { readonly type: "done" }
  | { readonly type: "error"; readonly message: string }

export const isTerminal = (event: LiveEvent): boolean => event.type === "done" || event.type === "error"

/** One SSE frame. */
export const encodeSse = (event: LiveEvent): string =>
  `id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`

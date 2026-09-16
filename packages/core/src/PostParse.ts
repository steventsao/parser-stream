import { Context, Effect, Layer, Schema } from "effect"

/**
 * What runs on a finished block, after the parser and after the sanitizer.
 *
 * The core cuts complete blocks out of a parser's stream, so a hook always
 * sees whole HTML, never a chunk that stops mid-tag or mid-word. Work like
 * redaction belongs here for that reason, and not inside a parser: a parser
 * can emit `123-4` and then `5-6789`.
 *
 * Hooks are a pipeline. Each one receives what the one before it returned, in
 * order. Every block the core emits crosses the sanitizer and then the whole
 * pipeline, so nothing reaches a viewer, a store, or a snapshot unhooked.
 *
 * The sanitizer runs first and cannot be moved: it is the security boundary,
 * and it unwraps unknown tags, so it surfaces text a hook must see.
 *
 * The default is an empty pipeline, so a host that wants no hook pays nothing
 * and needs no wiring.
 */

export class PostParseError extends Schema.TaggedError<PostParseError>()("PostParseError", {
  hook: Schema.String,
  message: Schema.String
}) {}

export interface Hook {
  readonly name: string
  readonly transform: (html: string) => Effect.Effect<string, PostParseError>
}

/**
 * The hooks for this conversion, in order. It is an ambient reference with a
 * default, like `Credential`, so a server can install hooks per request.
 */
export const PostParse = Context.Reference<ReadonlyArray<Hook>>("parser-stream/PostParse", {
  defaultValue: (): ReadonlyArray<Hook> => []
})

/** A hook from a plain function. A throw becomes a `PostParseError`. */
export const sync = (name: string, transform: (html: string) => string): Hook => ({
  name,
  transform: (html) =>
    Effect.try({
      try: () => transform(html),
      catch: (cause) => new PostParseError({ hook: name, message: `The ${name} hook failed: ${String(cause)}` })
    })
})

/** A hook that does its own work in Effect, for example an HTTP call. */
export const make = (name: string, transform: Hook["transform"]): Hook => ({ name, transform })

/** Run the pipeline over one block. */
export const run = (hooks: ReadonlyArray<Hook>, html: string): Effect.Effect<string, PostParseError> =>
  Effect.gen(function*() {
    let out = html
    for (const hook of hooks) out = yield* hook.transform(out)
    return out
  })

/** Run `effect` with these hooks, for one conversion. */
export const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  hooks: ReadonlyArray<Hook>
): Effect.Effect<A, E, R> => Effect.provideService(effect, PostParse, hooks)

/**
 * Install hooks for every conversion in a host.
 *
 * Provide this to the program, not to `Converter.layer`. A hook is read from
 * the running fiber, so a layer nested inside the converter's own build would
 * never be seen.
 */
export const layer = (...hooks: ReadonlyArray<Hook>) => Layer.succeed(PostParse)(hooks)

import { Context, Effect, Option, type Redacted } from "effect"

/**
 * A secret for one conversion, supplied by whoever asked for it (for example
 * the API key a visitor typed into the upload form).
 *
 * It is an ambient reference with a default, like Effect's own request-scoped
 * references. That keeps the engine free of credentials: `Converter` and
 * `Sessions` never see one. A parser that needs a key reads this reference and
 * raises its own error when it is absent, so the requirement is declared where
 * the key is actually used.
 */
export const ParserCredential = Context.Reference<Option.Option<Redacted.Redacted<string>>>(
  "parser-stream/ParserCredential",
  { defaultValue: () => Option.none() }
)

/** Run `effect` with this credential available to parsers. */
export const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  credential: Option.Option<Redacted.Redacted<string>>
): Effect.Effect<A, E, R> => Effect.provideService(effect, ParserCredential, credential)

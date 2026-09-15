import { Config, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Converter } from "./Converter.js"
import type { Parser } from "./Parser.js"
import * as GeminiParser from "./parsers/Gemini.js"
import * as HttpParser from "./parsers/Http.js"
import { Sessions } from "./Sessions.js"

/**
 * Default wiring from environment variables. Each piece is a plain `Layer`, so
 * replace any of them: provide your own `Parser` to `Converter.layer`.
 */

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  message: Schema.String
}) {}

/** `PARSER=gemini` (default, needs `GEMINI_API_KEY`) or `PARSER=http` (needs `PARSER_URL`). */
export const ParserFromEnv: Layer.Layer<Parser, ConfigurationError | Config.ConfigError> = Layer.unwrap(
  Effect.gen(function*() {
    const kind = yield* Config.Literals(["gemini", "http"], "PARSER").pipe(Config.withDefault("gemini"))
    if (kind === "http") {
      if (Option.isNone(yield* Config.option(Config.String("PARSER_URL")))) {
        return yield* new ConfigurationError({ message: "PARSER=http needs PARSER_URL." })
      }
      return HttpParser.layerConfig
    }
    if (Option.isNone(yield* Config.option(Config.String("GEMINI_API_KEY")))) {
      return yield* new ConfigurationError({
        message:
          "Set GEMINI_API_KEY (https://aistudio.google.com/apikey), or set PARSER=http and PARSER_URL to use your own parser."
      })
    }
    return GeminiParser.layerConfig
  })
).pipe(Layer.provide(FetchHttpClient.layer))

export const ConverterLive = Converter.layer.pipe(Layer.provide(ParserFromEnv))

export const SessionsLive = Sessions.layer.pipe(Layer.provide(ConverterLive))

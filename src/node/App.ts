import { Config, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Converter } from "../Converter.js"
import type { Parser } from "../Parser.js"
import * as GeminiParser from "../parsers/Gemini.js"
import * as HttpParser from "../parsers/Http.js"
import { Sessions } from "../Sessions.js"
import * as NodeSanitizer from "./Sanitizer.js"

/**
 * Default Node wiring from environment variables. Each piece is a plain
 * `Layer`: provide your own `Parser` to `Converter.layer` to replace it.
 */

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  message: Schema.String
}) {}

/**
 * `PARSER=gemini` (default; `GEMINI_API_KEY` is optional because callers can
 * bring their own key per request) or `PARSER=http` (needs `PARSER_URL`).
 */
export const ParserFromEnv: Layer.Layer<Parser, ConfigurationError | Config.ConfigError> = Layer.unwrap(
  Effect.gen(function*() {
    const kind = yield* Config.Literals(["gemini", "http"], "PARSER").pipe(Config.withDefault("gemini"))
    if (kind === "gemini") return GeminiParser.layerConfig
    if (Option.isNone(yield* Config.option(Config.String("PARSER_URL")))) {
      return yield* new ConfigurationError({ message: "PARSER=http needs PARSER_URL." })
    }
    return HttpParser.layerConfig
  })
).pipe(Layer.provide(FetchHttpClient.layer))

export const ConverterLive = Converter.layer.pipe(Layer.provide([ParserFromEnv, NodeSanitizer.layer]))

export const SessionsLive = Sessions.layer.pipe(Layer.provide(ConverterLive))

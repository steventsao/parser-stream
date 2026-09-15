import { Config, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Converter } from "../Converter.js"
import type { Parser } from "../Parser.js"
import * as GeminiParser from "../parsers/Gemini.js"
import * as HttpParser from "../parsers/Http.js"
import * as ParseBenchParser from "../parsers/ParseBench.js"
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
 * `PARSER` picks the parser:
 *
 * - `parsebench` (default): the layout prompt with bounding boxes and DocLayNet labels.
 * - `gemini-html`: ask Gemini for semantic HTML directly.
 * - `http`: your own endpoint (needs `PARSER_URL`).
 *
 * `GEMINI_API_KEY` is optional, because callers can bring their own key per request.
 */
export const ParserFromEnv: Layer.Layer<Parser, ConfigurationError | Config.ConfigError> = Layer.unwrap(
  Effect.gen(function*() {
    const kind = yield* Config.Literals(["parsebench", "gemini-html", "http"], "PARSER").pipe(
      Config.withDefault("parsebench")
    )
    if (kind === "parsebench") return ParseBenchParser.layerConfig
    if (kind === "gemini-html") return GeminiParser.layerConfig
    if (Option.isNone(yield* Config.option(Config.String("PARSER_URL")))) {
      return yield* new ConfigurationError({ message: "PARSER=http needs PARSER_URL." })
    }
    return HttpParser.layerConfig
  })
).pipe(Layer.provide(FetchHttpClient.layer))

export const ConverterLive = Converter.layer.pipe(Layer.provide([ParserFromEnv, NodeSanitizer.layer]))

export const SessionsLive = Sessions.layer.pipe(Layer.provide(ConverterLive))

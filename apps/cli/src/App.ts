import { Sessions } from "@parser-stream/app/Sessions"
import { GeminiFlashParseBenchParser, GeminiHtmlParser } from "@parser-stream/gemini"
import * as HttpParser from "@parser-stream/http"
import { NodeSanitizer } from "@parser-stream/node"
import * as OpenAiCompatibleParser from "@parser-stream/openai-compatible"
import { Config, Effect, Layer, Option, Schema } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Converter } from "parser-stream/Converter"
import type { HtmlStream } from "parser-stream/HtmlStream"

/**
 * How this host wires plugins together. Every piece is a plain `Layer`, so
 * another app can pick different plugins without touching the core.
 */

export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()("ConfigurationError", {
  message: Schema.String
}) {}

/**
 * `PARSER` picks the plugin:
 *
 * - `gemini-parsebench` (default): Gemini Flash with the ParseBench layout contract, boxes and labels.
 * - `gemini-html`: ask Gemini for semantic HTML directly.
 * - `openai`: any OpenAI-compatible server (needs `OPENAI_BASE_URL` and `OPENAI_MODEL`).
 * - `http`: your own endpoint (needs `PARSER_URL`).
 *
 * `GEMINI_API_KEY` is optional, because a caller can bring their own key per upload.
 */
export const HtmlStreamFromEnv: Layer.Layer<HtmlStream, ConfigurationError | Config.ConfigError> = Layer.unwrap(
  Effect.gen(function*() {
    const kind = yield* Config.Literals(["gemini-parsebench", "gemini-html", "openai", "http"], "PARSER").pipe(
      Config.withDefault("gemini-parsebench")
    )
    if (kind === "gemini-parsebench") return GeminiFlashParseBenchParser.layerConfig
    if (kind === "gemini-html") return GeminiHtmlParser.layerConfig
    if (kind === "openai") {
      if (Option.isNone(yield* Config.option(Config.String("OPENAI_BASE_URL")))) {
        return yield* new ConfigurationError({ message: "PARSER=openai needs OPENAI_BASE_URL and OPENAI_MODEL." })
      }
      return OpenAiCompatibleParser.layerConfig
    }
    if (Option.isNone(yield* Config.option(Config.String("PARSER_URL")))) {
      return yield* new ConfigurationError({ message: "PARSER=http needs PARSER_URL." })
    }
    return HttpParser.layerConfig
  })
).pipe(Layer.provide(FetchHttpClient.layer))

/** `Converter.layer` already splits PDFs into pages; the plugin and the sanitizer are host choices. */
export const ConverterLive = Converter.layer.pipe(Layer.provide([HtmlStreamFromEnv, NodeSanitizer.layer]))

export const SessionsLive = Sessions.layer.pipe(Layer.provide(ConverterLive))

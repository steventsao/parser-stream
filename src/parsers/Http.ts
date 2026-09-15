import { Config, Effect, Layer, Option, Redacted, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser, ParserError, type ParseRequest } from "../Parser.js"

/**
 * Bring your own parser, in any language, behind one HTTP endpoint.
 *
 *   POST {PARSER_URL}?unit=page&index=N&total=M   (no query for a whole source)
 *   content-type: {the source media type, for example application/pdf}
 *   accept: text/html
 *   authorization: Bearer {PARSER_TOKEN}           (only when PARSER_TOKEN is set)
 *   body: the source bytes
 *
 * Respond 200 with HTML block elements. Stream the body (chunked) for live
 * output, or send it all at once. Any other status is a parser error.
 */

export interface HttpParserOptions {
  readonly url: string
  readonly token?: Redacted.Redacted<string> | undefined
}

const fail = (message: string) => new ParserError({ parser: "http", message })

/** Build an HTTP parser. Requires an `HttpClient`. */
export const make = Effect.fn("HttpParser.make")(function*(options: HttpParserOptions) {
  const client = yield* HttpClient.HttpClient

  const parse = (request: ParseRequest): Stream.Stream<string, ParserError> =>
    Stream.unwrap(Effect.gen(function*() {
      const target = new URL(options.url)
      if (request.part) {
        target.searchParams.set("unit", request.part.unit)
        target.searchParams.set("index", String(request.part.index))
        target.searchParams.set("total", String(request.part.total))
      }
      let httpRequest = HttpClientRequest.post(target.toString()).pipe(
        HttpClientRequest.setHeader("accept", "text/html"),
        HttpClientRequest.bodyUint8Array(request.source.bytes, request.source.mediaType)
      )
      if (options.token) httpRequest = HttpClientRequest.bearerToken(httpRequest, Redacted.value(options.token))
      const response = yield* client.execute(httpRequest).pipe(
        Effect.mapError((error) => fail(`Request to the parser failed: ${error.message}`))
      )
      if (response.status < 200 || response.status >= 300) {
        const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* fail(`Parser returned HTTP ${response.status}: ${detail.slice(0, 300)}`)
      }
      return response.stream.pipe(
        Stream.mapError((error) => fail(`Parser stream failed: ${error.message}`)),
        Stream.decodeText
      )
    })).pipe(
      Stream.withSpan("HttpParser.parse", {
        attributes: { mediaType: request.source.mediaType, part: request.part?.index }
      })
    )

  return Parser.of({ name: `http:${new URL(options.url).host}`, parse })
})

export const layer = (options: HttpParserOptions): Layer.Layer<Parser, never, HttpClient.HttpClient> =>
  Layer.effect(Parser, make(options))

/** HTTP parser layer from `PARSER_URL` and optional `PARSER_TOKEN`. */
export const layerConfig: Layer.Layer<Parser, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(
  Parser,
  Effect.gen(function*() {
    const url = yield* Config.URL("PARSER_URL")
    const token = yield* Config.option(Config.Redacted("PARSER_TOKEN"))
    return yield* make({ url: url.toString(), token: Option.getOrUndefined(token) })
  })
)

import { Config, Effect, Layer, Option, Redacted, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { HtmlStream, HtmlStreamError, type HtmlStreamRequest } from "parser-stream/HtmlStream"
import { Credential } from "parser-stream/Credential"

/**
 * Bring your own parser, in any language, behind one HTTP endpoint.
 *
 *   POST {PARSER_URL}?unit=page&index=N&total=M   (no query for a whole source)
 *   content-type: {the source media type, for example application/pdf}
 *   accept: text/html
 *   authorization: Bearer {the conversion's credential, or PARSER_TOKEN}
 *   body: the source bytes
 *
 * Respond 200 with HTML block elements. Stream the body (chunked) for live
 * output, or send it all at once. Any other status is a parser error. Your
 * endpoint owns its own prompt, model, and output shape.
 */

export interface HttpParserOptions {
  readonly url: string
  /** Used when a conversion brings no `Credential`. */
  readonly token?: Redacted.Redacted<string> | undefined
}

const fail = (message: string) => new HtmlStreamError({ parser: "http", message })

/** Build an HTTP parser. Requires an `HttpClient`. */
export const make = Effect.fn("HttpParser.make")(function*(options: HttpParserOptions) {
  const client = yield* HttpClient.HttpClient

  const parse = (request: HtmlStreamRequest): Stream.Stream<string, HtmlStreamError> =>
    Stream.unwrap(Effect.gen(function*() {
      const supplied = yield* Credential
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
      const token = Option.getOrUndefined(supplied) ?? options.token
      if (token) httpRequest = HttpClientRequest.bearerToken(httpRequest, Redacted.value(token))
      const response = yield* client.execute(httpRequest).pipe(
        Effect.mapError((error) => fail(`Request to the parser failed: ${error.message}`))
      )
      if (response.status < 200 || response.status >= 300) {
        const detail = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
        return yield* fail(`HtmlStream returned HTTP ${response.status}: ${detail.slice(0, 300)}`)
      }
      return response.stream.pipe(
        Stream.mapError((error) => fail(`HtmlStream stream failed: ${error.message}`)),
        Stream.decodeText
      )
    })).pipe(
      Stream.provideService(HttpClient.HttpClient, client),
      Stream.withSpan("HttpParser.parse", {
        attributes: { mediaType: request.source.mediaType, part: request.part?.index }
      })
    )

  return HtmlStream.of({ name: `http:${new URL(options.url).host}`, parse })
})

export const layer = (options: HttpParserOptions): Layer.Layer<HtmlStream, never, HttpClient.HttpClient> =>
  Layer.effect(HtmlStream, make(options))

/** The same parser, with `PARSER_URL` and `PARSER_TOKEN` read from the environment. */
export const layerConfig: Layer.Layer<HtmlStream, Config.ConfigError, HttpClient.HttpClient> = Layer.effect(
  HtmlStream,
  Effect.gen(function*() {
    const url = yield* Config.URL("PARSER_URL")
    const token = yield* Config.option(Config.Redacted("PARSER_TOKEN"))
    return yield* make({ url: url.toString(), token: Option.getOrUndefined(token) })
  })
)

import { Effect, Layer } from "effect"
import { SanitizeError, Sanitizer, sanitizerHandlers } from "../core/Sanitizer.js"

interface NativeHtmlRewriter {
  on(selector: string, handlers: typeof sanitizerHandlers): NativeHtmlRewriter
  transform(response: Response): Response
}

declare const HTMLRewriter: new() => NativeHtmlRewriter

/** The shared allowlist on Cloudflare Workers, through the runtime's native HTMLRewriter. */
export const layer: Layer.Layer<Sanitizer> = Layer.succeed(Sanitizer)(Sanitizer.of({
  sanitize: Effect.fn("Sanitizer.sanitize")(function*(html: string) {
    return yield* Effect.tryPromise({
      try: () => new HTMLRewriter().on("*", sanitizerHandlers).transform(new Response(html)).text(),
      catch: (cause) => new SanitizeError({ cause })
    })
  })
}))

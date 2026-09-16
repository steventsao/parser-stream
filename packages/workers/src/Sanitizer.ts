import { Effect, Layer } from "effect"
import { Current } from "parser-stream/HtmlHandlers"
import type { HtmlHandlerSet } from "parser-stream/HtmlHandlers"
import { SanitizeError, Sanitizer, sanitizerHandlers } from "parser-stream/Sanitizer"

interface NativeHtmlRewriter {
  on(selector: string, handlers: HtmlHandlerSet | typeof sanitizerHandlers): NativeHtmlRewriter
  transform(response: Response): Response
}

declare const HTMLRewriter: new() => NativeHtmlRewriter

/** The shared allowlist on Cloudflare Workers, through the runtime's native HTMLRewriter. */
export const layer: Layer.Layer<Sanitizer> = Layer.succeed(Sanitizer)(Sanitizer.of({
  sanitize: Effect.fn("Sanitizer.sanitize")(function*(html: string) {
    // `open()` runs per block, so a handler's state never crosses blocks or fibers.
    const declared = yield* Current
    return yield* Effect.tryPromise({
      try: () => {
        // The allowlist runs first, then whatever the host declared, in one pass.
        let rewriter = new HTMLRewriter().on("*", sanitizerHandlers)
        for (const handler of declared) rewriter = rewriter.on(handler.selector, handler.open())
        return rewriter.transform(new Response(html)).text()
      },
      catch: (cause) => new SanitizeError({ cause })
    })
  })
}))

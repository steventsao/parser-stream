import { Effect, Layer, Semaphore } from "effect"
import { HTMLRewriter } from "html-rewriter-wasm"
import { SanitizeError, Sanitizer, sanitizerHandlers } from "parser-stream/Sanitizer"

/** The shared allowlist on Node, through lol-html compiled to WebAssembly. */
export const layer: Layer.Layer<Sanitizer> = Layer.effect(
  Sanitizer,
  Effect.gen(function*() {
    // The WebAssembly module runs one rewriter at a time; parallel part fibers share this lock.
    const lock = yield* Semaphore.make(1)
    const encoder = new TextEncoder()

    const run = (html: string) =>
      Effect.suspend(() => {
        const decoder = new TextDecoder()
        let out = ""
        return Effect.acquireUseRelease(
          Effect.sync(() =>
            new HTMLRewriter((chunk) => {
              out += decoder.decode(chunk, { stream: true })
            })
          ),
          (rewriter) =>
            Effect.tryPromise({
              try: async () => {
                rewriter.on("*", sanitizerHandlers)
                await rewriter.write(encoder.encode(html))
                await rewriter.end()
                return out + decoder.decode()
              },
              catch: (cause) => new SanitizeError({ cause })
            }),
          (rewriter) => Effect.sync(() => rewriter.free())
        )
      })

    const sanitize = Effect.fn("Sanitizer.sanitize")(function*(html: string) {
      return yield* Semaphore.withPermit(lock, run(html))
    })

    return Sanitizer.of({ sanitize })
  })
)

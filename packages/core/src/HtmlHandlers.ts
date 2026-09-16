import { Context, Effect, Layer } from "effect"
import type { RewriterComment, RewriterElement, RewriterText } from "./Sanitizer.js"

/**
 * Declared HTML handlers: what to do with an element, a comment, or text while
 * the runtime rewrites a finished block.
 *
 * This is the shape both rewriters already take, so a declared handler runs in
 * the same pass as the allowlist. The input and the output are plain: HTML in,
 * HTML out, one parse. Nothing re-parses the markup, and no handler receives a
 * string of HTML to match against by hand.
 *
 * The allowlist always runs first. It is the security boundary, and it unwraps
 * unknown tags, so it surfaces text a handler must see.
 *
 * The default is no handler, so a host that declares none pays nothing.
 */

export interface HtmlHandlerSet {
  readonly element?: (element: RewriterElement) => void | Promise<void>
  readonly comments?: (comment: RewriterComment) => void | Promise<void>
  readonly text?: (text: RewriterText) => void | Promise<void>
}

export interface HtmlHandler {
  /** A CSS selector, for example `*`, `p`, or `td`. */
  readonly selector: string
  /** Called once per block, so a handler may hold state for that block alone. */
  readonly open: () => HtmlHandlerSet
}

/**
 * The handlers for this conversion. An ambient reference with a default, like
 * `Credential`, so a server can declare handlers per request.
 */
export const Current = Context.Reference<ReadonlyArray<HtmlHandler>>("parser-stream/HtmlHandlers", {
  defaultValue: (): ReadonlyArray<HtmlHandler> => []
})

/**
 * A rewriter can split one text node into chunks, so `123-45-6789` may arrive
 * as `123-4` and then `5-6789`. This joins the chunks, drops all but the last,
 * and replaces the last with the result. The result is text, never markup.
 */
const wholeText = (replace: (text: string) => string) => {
  let buffer = ""
  return (chunk: RewriterText) => {
    buffer += chunk.text
    if (!chunk.lastInTextNode) {
      chunk.remove()
      return
    }
    const whole = buffer
    buffer = ""
    chunk.replace(replace(whole), { html: false })
  }
}

/**
 * Rewrite the text inside matching elements, a whole text node at a time.
 * Text in, text out: the handler never sees or writes markup.
 */
export const text = (selector: string, replace: (text: string) => string): HtmlHandler => ({
  selector,
  open: () => ({ text: wholeText(replace) })
})

/** A handler set of your own. `open` runs once per block and may hold state for it. */
export const make = (selector: string, open: () => HtmlHandlerSet): HtmlHandler => ({ selector, open })

/** Run `effect` with these handlers, for one conversion. */
export const provide = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  handlers: ReadonlyArray<HtmlHandler>
): Effect.Effect<A, E, R> => Effect.provideService(effect, Current, handlers)

/**
 * Declare handlers for every conversion in a host.
 *
 * Provide this to the program. The sanitizer reads the handlers from the
 * running fiber, so a layer nested inside `Converter.layer`'s own build would
 * never be seen.
 */
export const layer = (...handlers: ReadonlyArray<HtmlHandler>) => Layer.succeed(Current)(handlers)

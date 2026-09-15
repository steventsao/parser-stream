/**
 * Anything a parser can read: bytes plus a media type. A PDF is one kind of
 * source, not the only one. Images, text, or office files work the same way
 * as long as the `Parser` you provide understands them.
 */
export interface Source {
  readonly bytes: Uint8Array
  /** IANA media type, for example `application/pdf` or `image/png`. */
  readonly mediaType: string
  /** Display name, for example a file name. */
  readonly name?: string | undefined
}

export const make = (bytes: Uint8Array, mediaType: string, name?: string): Source => ({ bytes, mediaType, name })

const BY_EXTENSION: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  htm: "text/html",
  csv: "text/csv"
}

/** Best-effort media type from a file name. */
export const mediaTypeFromPath = (path: string): string | undefined => {
  const dot = path.lastIndexOf(".")
  return dot === -1 ? undefined : BY_EXTENSION[path.slice(dot + 1).toLowerCase()]
}

/**
 * Anything a parser can read: bytes plus a media type. A PDF is one kind of
 * source, not the only one. Images, text, or office files work the same way
 * as long as the `HtmlStream` you provide understands them.
 */
export interface Source {
  readonly bytes: Uint8Array
  /** IANA media type, for example `application/pdf` or `image/png`. */
  readonly mediaType: string
  /** Display name, for example a file name. */
  readonly name?: string | undefined
}

export const make = (bytes: Uint8Array, mediaType: string, name?: string): Source => ({ bytes, mediaType, name })

/**
 * The media types this repository names. Use a constructor below instead of
 * writing one of these strings at a call site. `make` stays for a media type
 * that arrives as data, such as the `content-type` of an upload.
 */
export const PDF = "application/pdf"
export const PNG = "image/png"
export const JPEG = "image/jpeg"
export const PLAIN_TEXT = "text/plain"

export const pdf = (bytes: Uint8Array, name?: string): Source => make(bytes, PDF, name)
export const png = (bytes: Uint8Array, name?: string): Source => make(bytes, PNG, name)
export const jpeg = (bytes: Uint8Array, name?: string): Source => make(bytes, JPEG, name)

/** Plain text, encoded as UTF-8. */
export const text = (content: string, name?: string): Source =>
  make(new TextEncoder().encode(content), PLAIN_TEXT, name)

export const isPdf = (source: Source): boolean => source.mediaType === PDF

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

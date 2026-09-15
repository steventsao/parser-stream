import { CONTRACT_VERSION, type ConvertEvent, type LiveEvent, type TerminalEvent } from "./Events.js"
import { escapeHtml, isSingleBlock } from "./Html.js"

export interface Block {
  readonly id: string
  readonly html: string
}

export type Status = "running" | "done" | "error"

/** The server-held snapshot of one conversion. */
export interface DocumentState {
  readonly seq: number
  readonly status: Status
  readonly phase: string
  readonly blocks: ReadonlyArray<Block>
}

export const LOADING_ID = "loading"
export const ERROR_ID = "error"

export const initialState: DocumentState = {
  seq: 0,
  status: "running",
  phase: "Starting",
  blocks: [{ id: LOADING_ID, html: `<p id="${LOADING_ID}" class="loading">Reading the document…</p>` }]
}

export type DocumentInput = ConvertEvent | TerminalEvent

/** Check one input against the contract. Returns a violation message, or `undefined` when valid. */
export const validate = (state: DocumentState, input: DocumentInput): string | undefined => {
  if (input.type !== "append" && input.type !== "replace") return undefined
  if (!isSingleBlock(input.html, input.id)) {
    return `${input.type} #${input.id} must be one complete element whose root id is ${input.id}`
  }
  const exists = state.blocks.some((block) => block.id === input.id)
  if (input.type === "append" && exists) return `duplicate block id #${input.id}`
  if (input.type === "replace" && !exists) return `replace target #${input.id} does not exist`
  return undefined
}

export interface Transition {
  readonly state: DocumentState
  readonly event: LiveEvent
}

const withoutIds = (blocks: ReadonlyArray<Block>, ...ids: Array<string>) =>
  blocks.filter((block) => !ids.includes(block.id))

/**
 * Pure state transition for one valid input. Returns `undefined` once the
 * document is terminal, so late producer output is an idempotent no-op.
 */
export const reduce = (state: DocumentState, input: DocumentInput): Transition | undefined => {
  if (state.status !== "running") return undefined
  const seq = state.seq + 1
  const version = CONTRACT_VERSION
  switch (input.type) {
    case "progress":
      return {
        state: { ...state, seq, phase: input.phase },
        event: { version, seq, type: "progress", phase: input.phase }
      }
    case "append":
      return {
        state: { ...state, seq, blocks: [...withoutIds(state.blocks, LOADING_ID), { id: input.id, html: input.html }] },
        event: { version, seq, type: "append", block_id: input.id, html: input.html }
      }
    case "replace":
      return {
        state: {
          ...state,
          seq,
          blocks: state.blocks.map((block) => block.id === input.id ? { id: input.id, html: input.html } : block)
        },
        event: { version, seq, type: "replace", target: `#${input.id}`, html: input.html }
      }
    case "done":
      return {
        state: { ...state, seq, status: "done", phase: "Done", blocks: withoutIds(state.blocks, LOADING_ID) },
        event: { version, seq, type: "done" }
      }
    case "error": {
      const html = `<p id="${ERROR_ID}" class="error" role="alert">${escapeHtml(input.message)}</p>`
      return {
        state: {
          ...state,
          seq,
          status: "error",
          phase: "Failed",
          blocks: [...withoutIds(state.blocks, LOADING_ID, ERROR_ID), { id: ERROR_ID, html }]
        },
        event: { version, seq, type: "error", message: input.message }
      }
    }
  }
}

export const partBlockId = (unit: string, index: number): string => `${unit}-${Math.max(1, Math.trunc(index))}`

export interface PartSection {
  /** For example `page`. */
  readonly unit: string
  readonly index: number
  readonly total: number
  /** Already sanitized. */
  readonly children: ReadonlyArray<string>
  /** Best-effort render of a block that is still streaming. Already sanitized. */
  readonly provisional?: string | undefined
  /** In-place note when this part failed. Other parts are not affected. */
  readonly error?: string | undefined
}

/** One part as exactly one top-level element with `id="{unit}-{index}"`. */
export const renderPartSection = (section: PartSection): string => {
  const index = Math.max(1, Math.trunc(section.index))
  const name = section.unit.charAt(0).toUpperCase() + section.unit.slice(1)
  const label = section.total > 1 ? `${name} ${index} of ${section.total}` : `${name} ${index}`
  const body = [...section.children]
  if (section.provisional) body.push(section.provisional)
  if (section.error) {
    body.push(`<p class="error" role="alert">${escapeHtml(section.error)}</p>`)
  } else if (body.length === 0) {
    body.push(`<p class="loading">Converting ${label.toLowerCase()}…</p>`)
  }
  return `<section id="${partBlockId(section.unit, index)}" class="part" data-part="${index}" aria-label="${label}">${
    body.join("")
  }</section>`
}

/** Minimal reading styles, shared by the web UI and exported files. */
export const DOCUMENT_CSS = `
.doc{max-width:46rem;margin:0 auto;font:16px/1.6 system-ui,sans-serif}
.doc h1,.doc h2,.doc h3{line-height:1.25}
.doc table{border-collapse:collapse;margin:1rem 0}
.doc th,.doc td{border:1px solid #8886;padding:.25rem .5rem;text-align:left;vertical-align:top}
.doc figure{margin:1rem 0;padding:.75rem;border:1px dashed #8888}
.doc figcaption{font-size:.9em;opacity:.8}
.doc .table-scroll{overflow-x:auto}
.doc .part+.part{border-top:1px solid #8884;margin-top:2rem;padding-top:1rem}
.doc .loading{opacity:.6}
.doc .error{color:#c62828}
`.trim()

/** A self-contained HTML file with no scripts. */
export const renderHtmlDocument = (options: {
  readonly title: string
  readonly blocks: ReadonlyArray<Block>
}): string =>
  [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    `<title>${escapeHtml(options.title)}</title>`,
    `<style>:root{color-scheme:light dark}body{margin:0;padding:2rem 1rem}${DOCUMENT_CSS}</style>`,
    "</head>",
    "<body>",
    "<main class=\"doc\">",
    ...options.blocks.map((block) => block.html),
    "</main>",
    "</body>",
    "</html>",
    ""
  ].join("\n")

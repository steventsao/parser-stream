import { describe, expect, it } from "vitest"
import { type DocumentInput, type DocumentState, initialState, reduce, validate } from "../src/core/domain/Document.js"
import { encodeSse } from "../src/core/domain/Events.js"

const run = (inputs: ReadonlyArray<DocumentInput>) => {
  let state: DocumentState = initialState
  const events = []
  for (const input of inputs) {
    expect(validate(state, input)).toBeUndefined()
    const transition = reduce(state, input)
    if (!transition) continue
    state = transition.state
    events.push(transition.event)
  }
  return { state, events }
}

describe("document reducer", () => {
  it("assigns contiguous seq numbers and drops the loading block on first content", () => {
    const { events, state } = run([
      { type: "progress", phase: "Parsing" },
      { type: "append", id: "block-1", html: `<p id="block-1">a</p>` },
      { type: "replace", id: "block-1", html: `<p id="block-1">b</p>` },
      { type: "done" }
    ])
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4])
    expect(events.map((event) => event.type)).toEqual(["progress", "append", "replace", "done"])
    expect(state.status).toBe("done")
    expect(state.blocks).toEqual([{ id: "block-1", html: `<p id="block-1">b</p>` }])
  })

  it("ignores input after a terminal event", () => {
    const { events } = run([{ type: "error", message: "nope" }, { type: "done" }])
    expect(events.map((event) => event.type)).toEqual(["error"])
  })

  it("rejects contract violations", () => {
    expect(validate(initialState, { type: "append", id: "a", html: "<p>no id</p>" })).toMatch(/root id/)
    expect(validate(initialState, { type: "replace", id: "a", html: `<p id="a">x</p>` })).toMatch(/does not exist/)
  })

  it("encodes one SSE frame per event", () => {
    const frame = encodeSse({ version: "parser-stream.v1", seq: 3, type: "progress", phase: "x" })
    expect(frame).toBe(`id: 3\nevent: progress\ndata: {"version":"parser-stream.v1","seq":3,"type":"progress","phase":"x"}\n\n`)
  })
})

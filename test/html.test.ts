import { describe, expect, it } from "vitest"
import {
  extractBlocks,
  isCompleteElement,
  isSingleBlock,
  normalizeBlocks,
  provisionalTail,
  stampFigurePage,
  withRootId,
  wrapTable
} from "../src/core/domain/Html.js"

describe("extractBlocks", () => {
  it("cuts complete top-level blocks and keeps the incomplete tail", () => {
    const { blocks, rest } = extractBlocks("```html\n<h1>Title</h1><p>Hello <b>you</b></p><ul><li>a</li>")
    expect(blocks).toEqual(["<h1>Title</h1>", "<p>Hello <b>you</b></p>"])
    expect(rest).toBe("<ul><li>a</li>")
  })

  it("wraps stray text that is followed by a tag", () => {
    expect(extractBlocks("loose text <p>x</p>").blocks).toEqual(["<p>loose text</p>", "<p>x</p>"])
  })

  it("treats void elements as complete blocks", () => {
    expect(extractBlocks("<hr><p>x</p>").blocks).toEqual(["<hr>", "<p>x</p>"])
  })
})

describe("provisionalTail", () => {
  it("closes the finished rows of an open table", () => {
    const tail = provisionalTail("<table><tr><td>1</td></tr><tr><td>2</td></tr><tr><td>")
    expect(tail).toEqual({ html: "<table><tr><td>1</td></tr><tr><td>2</td></tr></table>", children: 2 })
  })

  it("ignores containers without a finished child and non-containers", () => {
    expect(provisionalTail("<table><tr><td>")).toBeUndefined()
    expect(provisionalTail("<p>partial")).toBeUndefined()
  })
})

describe("block ids", () => {
  it("replaces any id on the root", () => {
    expect(withRootId(`<p id="evil" class="x">a</p>`, "block-1")).toBe(`<p id="block-1" class="x">a</p>`)
    expect(withRootId(wrapTable("<table></table>"), "block-2")).toBe(
      `<div id="block-2" class="table-scroll"><table></table></div>`
    )
  })

  it("accepts exactly one balanced element with the addressed id", () => {
    expect(isSingleBlock(`<p id="a">x</p>`, "a")).toBe(true)
    expect(isSingleBlock(`<p id="a">x</p><p>y</p>`, "a")).toBe(false)
    expect(isSingleBlock(`<p id="a">x</b></p>`, "a")).toBe(false)
    expect(isSingleBlock(`<p data-id="a">x</p>`, "a")).toBe(false)
    expect(isSingleBlock(`<p id="a">x</p>`, "#bad")).toBe(false)
  })
})

describe("normalizeBlocks", () => {
  it("degrades malformed markup and bare text to paragraphs", () => {
    expect(normalizeBlocks("<p>ok</p>")).toEqual(["<p>ok</p>"])
    expect(normalizeBlocks("<p>x</b>")).toEqual(["<p>x</p>"])
    expect(normalizeBlocks("just text")).toEqual(["<p>just text</p>"])
    expect(isCompleteElement(normalizeBlocks("a < b")[0]!)).toBe(true)
  })
})

describe("stampFigurePage", () => {
  it("sets the true page on a figure", () => {
    expect(stampFigurePage(`<figure data-page="1" data-bbox="1,2,3,4"></figure>`, 7)).toBe(
      `<figure data-page="7" data-bbox="1,2,3,4"></figure>`
    )
    expect(stampFigurePage("<figure></figure>", 2)).toBe(`<figure data-page="2"></figure>`)
    expect(stampFigurePage("<p>x</p>", 2)).toBe("<p>x</p>")
  })
})

/**
 * Writes examples/sample.pdf: a small fictional three-page report with
 * headings, lists, and tables, for demos and manual tests.
 *
 *   pnpm tsx scripts/sample-pdf.ts
 */
import { writeFile } from "node:fs/promises"
import { type PDFFont, PDFDocument, rgb, StandardFonts } from "pdf-lib"

const document = await PDFDocument.create()
document.setTitle("Community Garden Program - 2026 Season Report")
const regular = await document.embedFont(StandardFonts.Helvetica)
const bold = await document.embedFont(StandardFonts.HelveticaBold)

interface Line {
  readonly text: string
  readonly size?: number
  readonly font?: PDFFont
  readonly gap?: number
}

const h1 = (text: string): Line => ({ text, size: 20, font: bold, gap: 14 })
const h2 = (text: string): Line => ({ text, size: 14, font: bold, gap: 10 })
const p = (text: string): Line => ({ text, gap: 5 })
const space: Line = { text: "", gap: 6 }

const addPage = (lines: ReadonlyArray<Line>, table?: ReadonlyArray<ReadonlyArray<string>>, footer?: string) => {
  const page = document.addPage([612, 792])
  let y = 730
  for (const line of lines) {
    const size = line.size ?? 11
    if (line.text) page.drawText(line.text, { x: 60, y, size, font: line.font ?? regular })
    y -= size + (line.gap ?? 5)
  }
  if (table) {
    y -= 6
    const widths = [170, 90, 110, 110]
    for (const [row, cells] of table.entries()) {
      let x = 60
      cells.forEach((cell, column) => {
        page.drawText(cell, { x: x + 4, y, size: 10, font: row === 0 ? bold : regular })
        x += widths[column] ?? 90
      })
      page.drawLine({
        start: { x: 60, y: y - 6 },
        end: { x: 540, y: y - 6 },
        thickness: row === 0 ? 1 : 0.4,
        color: rgb(0.55, 0.55, 0.55)
      })
      y -= 22
    }
  }
  if (footer) page.drawText(footer, { x: 60, y: y - 10, size: 9, font: regular, color: rgb(0.35, 0.35, 0.35) })
  page.drawText(`${document.getPageCount()}`, { x: 300, y: 40, size: 9, font: regular })
}

addPage(
  [
    h1("Community Garden Program - 2026 Season Report"),
    p("Prepared by the Parks Volunteer Office"),
    space,
    h2("Summary"),
    p("The program ran four sites from April to October. Volunteer turnout grew at every site, and the"),
    p("combined harvest passed 5,000 kg for the first time. Most of the growth came from the two sites"),
    p("that added raised beds and a shared tool shed in spring."),
    space,
    h2("Harvest by site")
  ],
  [
    ["Site", "Plots", "Volunteers", "Harvest (kg)"],
    ["Riverside", "42", "118", "1,640"],
    ["Hillcrest", "35", "96", "1,410"],
    ["Old Mill", "28", "71", "1,120"],
    ["Northgate", "22", "64", "910"]
  ]
)

addPage([
  h1("Findings"),
  h2("What worked"),
  p("-  Raised beds cut weeding time by about a third at Riverside and Hillcrest."),
  p("-  Weekend workdays brought in more first-time volunteers than weekday evenings."),
  p("-  A shared tool shed reduced lost equipment to almost zero."),
  space,
  h2("What to change"),
  p("-  Water use peaked in July; two sites need drip irrigation before next season."),
  p("-  Northgate had the lowest turnout and needs better signage from the bus stop."),
  space,
  h2("Water use"),
  p("Sites with drip lines used 40 percent less water per plot than sites watered by hand. The office"),
  p("recommends drip irrigation at Old Mill and Northgate, at an estimated cost of 3,800 dollars.")
])

addPage(
  [h1("Appendix A: Monthly volunteer hours"), p("All four sites combined.")],
  [
    ["Month", "Hours", "New volunteers", "Events"],
    ["April", "310", "41", "3"],
    ["May", "485", "37", "4"],
    ["June", "620", "29", "5"],
    ["July", "702", "24", "5"],
    ["August", "655", "18", "4"],
    ["September", "540", "15", "3"],
    ["October", "298", "9", "2"]
  ],
  "Source: volunteer sign-in sheets. Figures are fictional sample data."
)

await writeFile(new URL("../examples/sample.pdf", import.meta.url), await document.save())
console.log("Wrote examples/sample.pdf")

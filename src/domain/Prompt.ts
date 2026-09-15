/**
 * Default prompts for vision-language parsers. A parser is free to ignore them:
 * a non-LLM parser (for example a layout model behind an HTTP endpoint) only
 * needs to return semantic HTML block elements.
 */

export const FIGURE_BBOX_POLICY =
  "Treat data-bbox as the exact visual crop, not a broad evidence region. Include the printed figure title " +
  "or subtitle, the full plot, photo, or diagram, every legend, axis, tick label, data label and mark. " +
  "The bbox MUST stop before prose captions and any line beginning Note or Source; emit that excluded text " +
  "as ordinary semantic HTML in reading order. Also exclude running headers, footers, page numbers, and " +
  "neighboring content. Do not add safety padding."

export const WHOLE_PROMPT =
  "Convert this document into a clean, semantic HTML web page. Output ONLY HTML block elements " +
  "(<h1>,<h2>,<h3>,<p>,<ul>,<ol>,<table> with <thead>/<tbody>/<th scope>, <figure>) in natural reading " +
  "order. No <html>/<head>/<body> wrapper, no markdown code fences, no page headers/footers/page-numbers. " +
  "Faithfully preserve headings, lists, and tables. " +
  "For every chart, graph, diagram, map, photo or other figure, emit a top-level " +
  "<figure data-page=\"P\" data-bbox=\"ymin,xmin,ymax,xmax\"> whose <figcaption> describes the figure in one " +
  "informative sentence usable as alt text. P is the 1-based page number (1 for a single image); " +
  "ymin,xmin,ymax,xmax are four integers 0-1000 normalized to that page or image. " +
  FIGURE_BBOX_POLICY +
  " If a chart has underlying data, ALSO emit the data as a following <table>. " +
  "Do NOT wrap blocks in <div> and do NOT nest figures. Start immediately with the first block."

/** Prompt for one part (for example one page) that was split out of a larger document. */
export const partPrompt = (part: { readonly unit: string; readonly index: number; readonly total: number }): string =>
  `${WHOLE_PROMPT} ` +
  `This is ${part.unit} ${part.index} of ${part.total} of a larger document, provided on its own. ` +
  `Convert ONLY what is in this ${part.unit}: do not invent a document title, a table of contents, or any ` +
  "heading that is not printed here. If it opens mid-sentence, mid-list or mid-table, continue it " +
  "as the same kind of block rather than restating a heading. " +
  (part.index > 1 ? "Do NOT repeat a running header or the document title carried over from earlier parts. " : "") +
  (part.unit === "page" ? `For every <figure>, set data-page="${part.index}".` : "")

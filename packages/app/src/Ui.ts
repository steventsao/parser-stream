import { DOCUMENT_CSS, type DocumentState } from "parser-stream/domain/Document"
import { escapeHtml } from "parser-stream/domain/Html"

/**
 * A deliberately plain demo: pick a file, get redirected to its page, and
 * watch it fill in. Pages work without JavaScript; the scripts only add live
 * updates, drag and drop, and an opt-in "remember my key".
 */

const head = (title: string) =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="/app.css">
</head>`

const keyFields = (options: { readonly keyField: "required" | "optional" | "hidden"; readonly keyLabel: string }) =>
  options.keyField === "hidden"
    ? ""
    : `<label>${escapeHtml(options.keyLabel)}${options.keyField === "optional" ? " (optional)" : ""}
<input id="api-key" name="api_key" type="password" autocomplete="off" spellcheck="false"${
      options.keyField === "required" ? " required" : ""
    }>
<small>Sent with this upload only. The server does not store it.</small>
</label>
<label class="check"><input id="remember" type="checkbox"> Remember the key in this browser</label>`

export const renderLandingPage = (options: {
  readonly keyField: "required" | "optional" | "hidden"
  readonly keyLabel: string
  readonly mediaTypes: ReadonlyArray<string>
}): string =>
  `${head("Document to HTML")}
<body>
<main class="upload">
<h1>Document to HTML</h1>
<p class="hint">Upload a PDF or an image. Its page opens right away and fills in while it converts.</p>
<form id="form" method="post" action="/s" enctype="multipart/form-data">
<label class="drop"><span>Choose a file, or drop one anywhere on this page</span>
<input id="file" name="file" type="file" accept="${escapeHtml(options.mediaTypes.join(","))}" required>
</label>
${keyFields(options)}
<details>
<summary>Options</summary>
<label>Mode
<select name="mode">
<option value="auto">auto: split multi-page files</option>
<option value="split">split: one request per page</option>
<option value="whole">whole: one request</option>
</select>
</label>
</details>
<button id="submit" type="submit">Convert</button>
</form>
</main>
<script type="module" src="/landing.js"></script>
</body>
</html>
`

const statusText = (state: Pick<DocumentState, "status" | "phase">) =>
  state.status === "done" ? "Done" : state.status === "error" ? "Failed" : state.phase

export const renderViewerPage = (
  snapshot: DocumentState & { readonly id: string; readonly title: string }
): string =>
  `${head(snapshot.title)}
<body>
<header class="bar">
<a href="/">New</a>
<span class="title">${escapeHtml(snapshot.title)}</span>
<span id="status" role="status" aria-live="polite">${escapeHtml(statusText(snapshot))}</span>
<a id="download" href="/s/${encodeURIComponent(snapshot.id)}/document.html"${
    snapshot.status === "done" ? "" : " hidden"
  }>Download HTML</a>
</header>
<main id="doc" class="doc" data-id="${escapeHtml(snapshot.id)}" data-seq="${snapshot.seq}" data-status="${snapshot.status}">
${snapshot.blocks.map((block) => block.html).join("\n")}
</main>
<script type="module" src="/viewer.js"></script>
</body>
</html>
`

export const renderMessagePage = (title: string, message: string): string =>
  `${head(title)}
<body>
<main class="upload">
<h1>${escapeHtml(title)}</h1>
<p>${escapeHtml(message)}</p>
<p><a href="/">Back</a></p>
</main>
</body>
</html>
`

export const APP_CSS = `:root{color-scheme:light dark}
body{margin:0;font:15px/1.5 system-ui,sans-serif}
input,select,button{font:inherit}
.upload{max-width:32rem;margin:10vh auto;padding:0 1rem}
.upload h1{font-size:1.5rem;margin:0 0 .25rem}
.hint{opacity:.7;margin:0 0 1.25rem}
form{display:grid;gap:.9rem}
label{display:grid;gap:.3rem}
label small{opacity:.6}
.check{display:flex;gap:.5rem;align-items:center}
.drop{place-items:center;min-height:9rem;border:2px dashed #8886;border-radius:.75rem;padding:1rem;text-align:center;cursor:pointer}
.drop input{max-width:100%}
summary{cursor:pointer}
details label{margin-top:.5rem}
button{padding:.55rem 1rem;cursor:pointer}
.bar{position:sticky;top:0;display:flex;flex-wrap:wrap;gap:.75rem;align-items:center;padding:.6rem 1rem;border-bottom:1px solid #8884;background:Canvas}
.bar .title{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
#status{opacity:.7}
main.doc{padding:1.5rem 1rem 4rem}
${DOCUMENT_CSS}
`

export const LANDING_JS = `const form = document.getElementById("form")
const file = document.getElementById("file")
const key = document.getElementById("api-key")
const remember = document.getElementById("remember")
const submit = document.getElementById("submit")
const STORAGE_KEY = "parser-stream:api-key"

const load = () => { try { return localStorage.getItem(STORAGE_KEY) } catch { return null } }
const save = (value) => {
  try { value ? localStorage.setItem(STORAGE_KEY, value) : localStorage.removeItem(STORAGE_KEY) } catch {}
}

if (key) {
  const saved = load()
  if (saved) { key.value = saved; remember.checked = true }
}

const ready = () => file.files.length > 0 && (!key || !key.required || key.value.trim() !== "")

form.addEventListener("submit", () => {
  if (key && remember) save(remember.checked ? key.value.trim() : null)
  submit.disabled = true
  submit.textContent = "Uploading…"
})

// Coming back to this page from history restores it; re-enable the button.
window.addEventListener("pageshow", () => { submit.disabled = false; submit.textContent = "Convert" })

file.addEventListener("change", () => { if (ready()) form.requestSubmit() })

document.addEventListener("dragover", (event) => event.preventDefault())
document.addEventListener("drop", (event) => {
  event.preventDefault()
  const dropped = event.dataTransfer && event.dataTransfer.files[0]
  if (!dropped) return
  const transfer = new DataTransfer()
  transfer.items.add(dropped)
  file.files = transfer.files
  if (ready()) form.requestSubmit()
  else if (key) key.focus()
})
`

export const VIEWER_JS = `const doc = document.getElementById("doc")
const statusEl = document.getElementById("status")
const download = document.getElementById("download")
const id = doc.dataset.id
let last = Number(doc.dataset.seq) || 0

// Server HTML is already sanitized; a <template> never runs scripts, and the CSP blocks inline ones anyway.
const fragment = (html) => {
  const template = document.createElement("template")
  template.innerHTML = html
  return template.content
}

if (doc.dataset.status === "running") {
  const source = new EventSource("/s/" + encodeURIComponent(id) + "/events?after=" + last)

  const finish = (status, message) => {
    source.close()
    document.getElementById("loading")?.remove()
    if (message) {
      const p = document.createElement("p")
      p.className = "error"
      p.setAttribute("role", "alert")
      p.textContent = message
      doc.append(p)
    }
    statusEl.textContent = status === "done" ? "Done" : "Failed"
    download.hidden = status !== "done"
  }

  const read = (event) => {
    const data = JSON.parse(event.data)
    if (data.seq <= last) return null
    if (data.seq !== last + 1) {
      source.close()
      location.reload()
      return null
    }
    last = data.seq
    return data
  }

  source.addEventListener("progress", (e) => { const ev = read(e); if (ev) statusEl.textContent = ev.phase })
  source.addEventListener("append", (e) => {
    const ev = read(e)
    if (!ev) return
    document.getElementById("loading")?.remove()
    doc.append(fragment(ev.html))
  })
  source.addEventListener("replace", (e) => {
    const ev = read(e)
    if (ev) document.getElementById(ev.target.slice(1))?.replaceWith(fragment(ev.html))
  })
  source.addEventListener("done", (e) => { if (read(e)) finish("done") })
  source.addEventListener("error", (e) => {
    if (!e.data) return // a connection error: EventSource reconnects and resumes from Last-Event-ID
    const ev = read(e)
    if (ev) finish("error", ev.message)
  })
}
`

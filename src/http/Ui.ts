import { DOCUMENT_CSS } from "../domain/Document.js"

/** A deliberately plain demo page: pick a file, watch the HTML stream in. */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Document to HTML</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header>
<form id="form">
<input id="file" type="file" accept="application/pdf,image/png,image/jpeg,image/webp" aria-label="File" required>
<label>Mode
<select id="mode">
<option value="auto">auto</option>
<option value="split">split</option>
<option value="whole">whole</option>
</select>
</label>
<button type="submit">Convert</button>
<span id="status" role="status" aria-live="polite"></span>
<a id="download" hidden download>Download HTML</a>
</form>
</header>
<main id="doc" class="doc"></main>
<script type="module" src="/app.js"></script>
</body>
</html>
`

export const APP_CSS = `:root{color-scheme:light dark}
body{margin:0;font:14px/1.5 system-ui,sans-serif}
header{position:sticky;top:0;padding:.75rem 1rem;border-bottom:1px solid #8884;background:Canvas}
form{display:flex;flex-wrap:wrap;gap:.5rem;align-items:center}
#status{color:GrayText}
main{padding:1.5rem 1rem 4rem}
${DOCUMENT_CSS}
`

export const APP_JS = `const $ = (id) => document.getElementById(id)
const form = $("form"), file = $("file"), mode = $("mode"), statusEl = $("status"), doc = $("doc"), download = $("download")
let source = null

const setStatus = (text) => { statusEl.textContent = text }

// Server HTML is already sanitized; a <template> never runs scripts, and the CSP blocks inline ones anyway.
const fragment = (html) => {
  const template = document.createElement("template")
  template.innerHTML = html
  return template.content
}

async function open(id) {
  if (source) { source.close(); source = null }
  download.hidden = true
  const res = await fetch("/api/sessions/" + encodeURIComponent(id))
  if (!res.ok) {
    doc.replaceChildren()
    return setStatus(res.status === 404 ? "Session not found." : "Error " + res.status)
  }
  const snap = await res.json()
  document.title = snap.title
  doc.replaceChildren(...snap.blocks.map((block) => fragment(block.html)))
  let last = snap.seq

  const finish = (status, message) => {
    if (source) { source.close(); source = null }
    $("loading")?.remove()
    if (message) {
      const p = document.createElement("p")
      p.className = "error"
      p.setAttribute("role", "alert")
      p.textContent = message
      doc.append(p)
    }
    setStatus(status === "done" ? "Done" : "Failed")
    download.href = "/api/sessions/" + encodeURIComponent(id) + "/document.html"
    download.hidden = status !== "done"
  }
  if (snap.status !== "running") return finish(snap.status)

  setStatus(snap.phase)
  source = new EventSource("/api/sessions/" + encodeURIComponent(id) + "/events?after=" + last)
  const read = (event) => {
    const data = JSON.parse(event.data)
    if (data.seq <= last) return null
    if (data.seq !== last + 1) { open(id); return null }
    last = data.seq
    return data
  }
  source.addEventListener("progress", (e) => { const ev = read(e); if (ev) setStatus(ev.phase) })
  source.addEventListener("append", (e) => {
    const ev = read(e)
    if (!ev) return
    $("loading")?.remove()
    doc.append(fragment(ev.html))
  })
  source.addEventListener("replace", (e) => {
    const ev = read(e)
    if (ev) $(ev.target.slice(1))?.replaceWith(fragment(ev.html))
  })
  source.addEventListener("done", (e) => { if (read(e)) finish("done") })
  source.addEventListener("error", (e) => {
    if (!e.data) return // a connection error: EventSource reconnects and resumes from Last-Event-ID
    const ev = read(e)
    if (ev) finish("error", ev.message)
  })
}

form.addEventListener("submit", async (event) => {
  event.preventDefault()
  const picked = file.files && file.files[0]
  if (!picked) return setStatus("Choose a file first.")
  setStatus("Uploading…")
  const res = await fetch("/api/sessions?mode=" + encodeURIComponent(mode.value), {
    method: "POST",
    headers: {
      "content-type": picked.type || "application/octet-stream",
      "x-filename": encodeURIComponent(picked.name)
    },
    body: picked
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return setStatus(body.error || "Upload failed (" + res.status + ")")
  history.pushState(null, "", "/?s=" + encodeURIComponent(body.id))
  open(body.id)
})

document.addEventListener("dragover", (event) => event.preventDefault())
document.addEventListener("drop", (event) => {
  event.preventDefault()
  const dropped = event.dataTransfer && event.dataTransfer.files[0]
  if (!dropped) return
  const transfer = new DataTransfer()
  transfer.items.add(dropped)
  file.files = transfer.files
  form.requestSubmit()
})

const boot = () => {
  const id = new URLSearchParams(location.search).get("s")
  if (id) open(id)
}
window.addEventListener("popstate", boot)
boot()
`

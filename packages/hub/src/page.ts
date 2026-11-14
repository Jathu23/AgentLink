// The read-only status page, shared by every host of the Hub.

// The page writes every value with textContent, so nothing an agent sends is ever parsed as HTML.
export const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentLink</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 720px; padding: 16px; color: #1c1c1c; background: #fafafa; }
  @media (prefers-color-scheme: dark) { body { color: #e8e8e8; background: #161616; } }
  h1 { font-size: 18px; } h2 { font-size: 15px; margin-top: 24px; }
  table { border-collapse: collapse; width: 100%; } td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #8884; }
  .offline { opacity: .55; } .working { font-weight: 600; } #at { opacity: .6; font-size: 13px; }
</style></head><body>
<h1>AgentLink <span id="space"></span></h1><div id="at">loading</div>
<h2>Agents</h2><table><thead><tr><th>Agent</th><th>State</th><th>Task</th><th>Status</th><th>Waiting</th><th>Last seen</th></tr></thead><tbody id="agents"></tbody></table>
<h2>Open questions</h2><table><thead><tr><th>Question</th><th>From</th><th>Blocks</th><th>Area</th><th>Waiting since</th></tr></thead><tbody id="questions"></tbody></table>
<script>
const key = new URLSearchParams(location.search).get('key') || ''
const time = (iso) => iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''
function fill(id, rows, cls) {
  const body = document.getElementById(id); body.replaceChildren()
  rows.forEach((cells, i) => { const tr = body.insertRow(); if (cls) tr.className = cls[i]; cells.forEach((c) => { tr.insertCell().textContent = c ?? '' }) })
}
async function load() {
  const at = document.getElementById('at')
  try {
    const r = await fetch('/api/status?key=' + encodeURIComponent(key))
    if (!r.ok) { at.textContent = r.status === 401 ? 'This link is not valid.' : 'Hub error ' + r.status; return }
    const s = await r.json()
    document.getElementById('space').textContent = '· ' + s.space
    at.textContent = 'Updated ' + time(s.at)
    fill('agents', s.agents.map((a) => [a.id + (a.role === 'lead' ? ' (lead)' : ''), a.presence, a.task, a.statusNote, a.waiting || '', time(a.lastSeen)]), s.agents.map((a) => a.presence))
    fill('questions', s.openQuestions.map((q) => [q.question, q.from, q.task, q.area, time(q.ts)]))
  } catch { at.textContent = 'Hub not reachable. Retrying.' }
}
load(); setInterval(load, 10000)
</script></body></html>`

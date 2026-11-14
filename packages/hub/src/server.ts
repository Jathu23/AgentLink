// Network edge of the Hub: one WebSocket endpoint for Links and a read-only status page.

import http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ClientFrame, type HubFrame } from '@agentlink/protocol'
import type { Agent, Conn, Hub } from './hub.ts'

const HELLO_TIMEOUT_MS = 5_000
const PING_EVERY_MS = 30_000

export type RunningServer = { port: number; close(): Promise<void> }

export function startServer(hub: Hub, port: number, host = '127.0.0.1'): Promise<RunningServer> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://hub')
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(PAGE)
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const space = hub.store.viewerSpace(url.searchParams.get('key') ?? '')
      if (!space) {
        res.writeHead(401)
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      return res.end(JSON.stringify(hub.snapshot(space)))
    }
    res.writeHead(404)
    res.end()
  })

  // A signal is a few hundred bytes; anything bigger is not ours.
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 })
  const alive = new WeakSet<WebSocket>()

  wss.on('connection', (ws) => {
    let agent: Agent | undefined
    const conn: Conn = {
      send: (frame: HubFrame) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(frame)),
      close: () => ws.close(4000, 'replaced by a newer connection'),
    }
    const helloTimer = setTimeout(() => ws.close(4401, 'no hello'), HELLO_TIMEOUT_MS)
    alive.add(ws)
    ws.on('pong', () => alive.add(ws))

    ws.on('message', (data) => {
      let raw: unknown
      try {
        raw = JSON.parse(String(data))
      } catch {
        return ws.close(4400, 'not json')
      }
      if (agent) return hub.onFrame(agent, raw)

      const hello = ClientFrame.safeParse(raw)
      const found = hello.success && hello.data.op === 'hello' ? hub.auth(hello.data.token) : undefined
      if (!found) return ws.close(4401, 'bad token')
      clearTimeout(helloTimer)
      agent = found
      hub.attach(agent, conn)
    })

    ws.on('close', () => {
      clearTimeout(helloTimer)
      if (agent) hub.detach(agent, conn)
    })
    ws.on('error', () => ws.terminate())
  })

  // A laptop that sleeps does not close its socket; a missed ping does it for us.
  const pinger = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) {
        ws.terminate()
        continue
      }
      alive.delete(ws)
      ws.ping()
    }
  }, PING_EVERY_MS)
  pinger.unref()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : port,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(pinger)
            for (const ws of wss.clients) ws.terminate()
            wss.close(() => server.close(() => done()))
          }),
      })
    })
  })
}

// The page writes every value with textContent, so nothing an agent sends is ever parsed as HTML.
const PAGE = `<!doctype html>
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

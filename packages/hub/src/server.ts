// Network edge of the Hub: one WebSocket endpoint for Links and a read-only status page.

import http from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { ClientFrame, type HubFrame } from '@agentlink/protocol'
import type { Agent, Conn, Hub } from './hub.ts'
import { PAGE } from './page.ts'

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
    let sendOnly = false
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
      if (agent) return hub.onFrame(agent, raw, sendOnly ? conn : undefined)

      const hello = ClientFrame.safeParse(raw)
      const found = hello.success && hello.data.op === 'hello' ? hub.auth(hello.data.token) : undefined
      if (!found) return ws.close(4401, 'bad token')
      clearTimeout(helloTimer)
      agent = found
      sendOnly = hello.success && hello.data.op === 'hello' && hello.data.mode === 'send'
      if (sendOnly) hub.welcomeSender(agent, conn)
      else hub.attach(agent, conn)
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

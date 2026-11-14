// The Hub on Cloudflare Workers. One Durable Object holds every space: its SQLite storage
// is the Store, and its hibernating WebSockets are the Links. The rules are the same Hub
// class the Node server uses; this file is only the host.

import { DurableObject } from 'cloudflare:workers'
import { AgentId, ClientFrame, isReservedAgentId, PING_TEXT, PONG_TEXT, ROLES, SpaceId, type Role } from '@agentlink/protocol'
import { Hub, Store, type Agent, type Conn } from '@agentlink/hub'
import { PAGE } from '@agentlink/hub/page'

type Env = { HUB: DurableObjectNamespace<HubObject>; ADMIN_KEY?: string }
/** Kept on each socket so it survives the object going to sleep. */
type Attachment = { agent?: Agent; sendOnly?: boolean; at: number }

// The Link pings every 30 seconds. Cloudflare answers the ping itself and records the time,
// so the object stays asleep, and a socket with no ping for this long is a laptop that went away.
const STALE_MS = 90_000
const MAX_FRAME = 4096
const ADMIN_OK = 'x-agentlink-admin-ok'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export class HubObject extends DurableObject<Env> {
  private hub: Hub
  private conns = new Map<WebSocket, Conn>()

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    const sql = ctx.storage.sql
    const all = (query: string, ...params: (string | number | null)[]) => sql.exec(query, ...params).toArray() as Record<string, unknown>[]
    this.hub = new Hub(new Store({ exec: (query) => void all(query), run: (query, ...params) => void all(query, ...params), all }))
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING_TEXT, PONG_TEXT))
    // After a sleep the sockets are still open but this object is new: tell the Hub who is connected.
    for (const ws of ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment?.agent && !attachment.sendOnly) this.hub.restore(attachment.agent, this.conn(ws))
    }
  }

  private conn(ws: WebSocket): Conn {
    let conn = this.conns.get(ws)
    if (!conn) {
      conn = {
        send: (frame) => {
          try {
            ws.send(JSON.stringify(frame))
          } catch {
            // The socket is gone; the message stays stored and is delivered on reconnect.
          }
        },
        close: () => this.end(ws, 4000, 'replaced by a newer connection'),
      }
      this.conns.set(ws, conn)
    }
    return conn
  }

  private end(ws: WebSocket, code: number, reason: string): void {
    const agent = (ws.deserializeAttachment() as Attachment | null)?.agent
    if (agent) this.hub.detach(agent, this.conn(ws))
    this.conns.delete(ws)
    try {
      ws.close(code, reason)
    } catch {
      // Already closed.
    }
  }

  /** Closes sockets that stopped pinging, and sockets that never said hello. */
  private prune(): void {
    const now = Date.now()
    for (const ws of this.ctx.getWebSockets()) {
      const at = (ws.deserializeAttachment() as Attachment | null)?.at ?? 0
      const last = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? at
      if (now - Math.max(last, at) > STALE_MS) this.end(ws, 4002, 'no ping')
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    this.prune()

    if (url.pathname === '/ws' && request.headers.get('upgrade')?.toLowerCase() === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair()
      this.ctx.acceptWebSocket(server)
      server.serializeAttachment({ at: Date.now() } satisfies Attachment)
      return new Response(null, { status: 101, webSocket: client })
    }
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } })
    }
    if (request.method === 'GET' && url.pathname === '/api/status') {
      const space = this.hub.store.viewerSpace(url.searchParams.get('key') ?? '')
      return space ? json(this.hub.snapshot(space)) : new Response(null, { status: 401 })
    }
    if (url.pathname.startsWith('/admin/')) return this.admin(request, url)
    return new Response(null, { status: 404 })
  }

  /** Registering agents and viewers. The Worker entry has already checked the admin key. */
  private async admin(request: Request, url: URL): Promise<Response> {
    if (request.headers.get(ADMIN_OK) !== '1') return new Response(null, { status: 401 })

    const removed = /^\/admin\/agents\/([a-z0-9-]+)$/.exec(url.pathname)
    if (request.method === 'DELETE' && removed) {
      const id = removed[1]!
      for (const ws of this.ctx.getWebSockets()) {
        if ((ws.deserializeAttachment() as Attachment | null)?.agent?.id === id) this.end(ws, 4401, 'token removed')
      }
      this.hub.store.removeAgent(id)
      return json({ removed: id })
    }
    if (request.method !== 'POST') return new Response(null, { status: 405 })
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const space = SpaceId.safeParse(body.space)
    if (!space.success) return json({ error: 'space is not a usable id' }, 400)

    if (url.pathname === '/admin/agents') {
      const id = AgentId.safeParse(body.id)
      if (!id.success || isReservedAgentId(id.data)) return json({ error: 'id is not a usable agent id' }, 400)
      if (!ROLES.includes(body.role as Role)) return json({ error: `role must be one of: ${ROLES.join(', ')}` }, 400)
      try {
        return json({ id: id.data, space: space.data, role: body.role, token: this.hub.store.addAgent({ id: id.data, space: space.data, role: body.role as Role }) })
      } catch {
        return json({ error: `agent '${id.data}' already exists; remove it first to give it a new token` }, 409)
      }
    }
    if (url.pathname === '/admin/viewers') {
      const name = typeof body.name === 'string' && body.name.length > 0 && body.name.length <= 40 ? body.name : undefined
      if (!name) return json({ error: 'name is required' }, 400)
      return json({ name, space: space.data, key: this.hub.store.addViewer(name, space.data) })
    }
    return new Response(null, { status: 404 })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string' || message.length > MAX_FRAME) return this.end(ws, 4400, 'not a protocol frame')
    let raw: unknown
    try {
      raw = JSON.parse(message)
    } catch {
      return this.end(ws, 4400, 'not json')
    }
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (attachment?.agent) return this.hub.onFrame(attachment.agent, raw, attachment.sendOnly ? this.conn(ws) : undefined)

    const hello = ClientFrame.safeParse(raw)
    const agent = hello.success && hello.data.op === 'hello' ? this.hub.auth(hello.data.token) : undefined
    if (!agent) return this.end(ws, 4401, 'bad token')
    const sendOnly = hello.success && hello.data.op === 'hello' && hello.data.mode === 'send'
    ws.serializeAttachment({ agent, sendOnly, at: Date.now() } satisfies Attachment)
    if (sendOnly) this.hub.welcomeSender(agent, this.conn(ws))
    else this.hub.attach(agent, this.conn(ws))
  }

  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    // 1005 and 1006 mean "no code" and cannot be sent back.
    this.end(ws, code === 1005 || code === 1006 ? 1000 : code, 'closed')
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.end(ws, 1011, 'socket error')
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // The admin key is checked here, in the stateless entry, which always sees the current secret.
    // The object trusts only the marker header, and a caller cannot set that header itself.
    const headers = new Headers(request.headers)
    headers.delete(ADMIN_OK)
    if (new URL(request.url).pathname.startsWith('/admin/')) {
      const key = env.ADMIN_KEY
      // With no secret set, admin is off.
      if (!key || key.length < 20 || headers.get('authorization') !== `Bearer ${key}`) return new Response(null, { status: 401 })
      headers.set(ADMIN_OK, '1')
    }
    return env.HUB.get(env.HUB.idFromName('hub')).fetch(new Request(request, { headers }))
  },
} satisfies ExportedHandler<Env>

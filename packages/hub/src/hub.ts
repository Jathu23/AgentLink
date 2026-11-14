// The Hub's rules, with no network code: who is connected, who may send what to whom,
// what is stored, what is pushed now and what waits for a reconnect.

import {
  checkSend,
  ClientFrame,
  PROTOCOL_VERSION,
  TO_ALL,
  TO_LEAD,
  wakesSession,
  type Envelope,
  type HubFrame,
} from '@agentlink/protocol'
import type { Agent, OpenQuestion, Store } from './store.ts'

export { Store } from './store.ts'
export type { Agent } from './store.ts'

export type Conn = { send(frame: HubFrame): void; close(): void }

export type Snapshot = {
  space: string
  at: string
  agents: {
    id: string
    role: string
    presence: 'offline' | 'idle' | 'working'
    task: string | null
    statusNote: string | null
    lastSeen: string | null
    waiting: number
  }[]
  openQuestions: OpenQuestion[]
}

const SENDS_PER_MINUTE = 30

export class Hub {
  private conns = new Map<string, Conn>()
  private sendTimes = new Map<string, number[]>()
  private seq = 0

  constructor(
    readonly store: Store,
    private now: () => Date = () => new Date(),
  ) {}

  auth(token: string): Agent | undefined {
    return this.store.agentByToken(token)
  }

  /** One connection per agent: a new one replaces the old. Stored messages are delivered straight away. */
  attach(agent: Agent, conn: Conn): void {
    this.conns.get(agent.id)?.close()
    this.conns.set(agent.id, conn)
    this.store.updateAgent(agent.id, { lastSeen: this.now().toISOString(), state: 'idle' })
    const pending = this.store.pending(agent.id)
    conn.send({ op: 'welcome', v: PROTOCOL_VERSION, agent: agent.id, space: agent.space, role: agent.role, pending: pending.length })
    for (const msg of pending) conn.send({ op: 'deliver', msg })
  }

  /** Re-registers a connection that outlived this Hub object (a host that sleeps between messages). Sends nothing. */
  restore(agent: Agent, conn: Conn): void {
    this.conns.set(agent.id, conn)
  }

  detach(agent: Agent, conn: Conn): void {
    if (this.conns.get(agent.id) !== conn) return
    this.conns.delete(agent.id)
    this.store.updateAgent(agent.id, { lastSeen: this.now().toISOString() })
  }

  onFrame(agent: Agent, raw: unknown): void {
    const conn = this.conns.get(agent.id)
    if (!conn) return
    const parsed = ClientFrame.safeParse(raw)
    if (!parsed.success) return conn.send({ op: 'rejected', code: 'invalid', reason: 'unknown or malformed frame' })
    const frame = parsed.data
    if (frame.op === 'ping') return conn.send({ op: 'pong' })
    this.store.updateAgent(agent.id, { lastSeen: this.now().toISOString() })
    switch (frame.op) {
      case 'hello':
        return conn.send({ op: 'rejected', code: 'invalid', reason: 'already connected' })
      case 'ack':
        return this.store.ack(agent.id, frame.id)
      case 'presence':
        return this.store.updateAgent(agent.id, { state: frame.state, task: frame.task ?? null })
      case 'send':
        return conn.send(this.send(agent, frame.ref, frame.msg))
    }
  }

  private send(agent: Agent, ref: string, input: unknown): HubFrame {
    const rejected = (code: string, reason: string): HubFrame => ({ op: 'rejected', ref, code, reason })

    // Stops two agents answering each other in a loop from burning tokens.
    const since = this.now().getTime() - 60_000
    const times = (this.sendTimes.get(agent.id) ?? []).filter((t) => t > since)
    if (times.length >= SENDS_PER_MINUTE) return rejected('rate_limited', `more than ${SENDS_PER_MINUTE} messages in a minute`)
    times.push(this.now().getTime())
    this.sendTimes.set(agent.id, times)

    const check = checkSend(agent.role, input)
    if (!check.ok) return rejected(check.code, check.reason)
    const { msg } = check

    const others = this.store.agents(agent.space).filter((a) => a.id !== agent.id)
    const targets =
      msg.to === TO_LEAD ? others.filter((a) => a.role === 'lead')
      : msg.to === TO_ALL ? others.filter((a) => a.role === 'member')
      : others.filter((a) => a.id === msg.to)
    if (targets.length === 0) return rejected('bad_target', `no agent '${msg.to}' in space '${agent.space}'`)

    const wakes = wakesSession(msg.type)
    const ts = this.now().toISOString()
    const ids: string[] = []
    let online = false
    for (const target of targets) {
      const env: Envelope = {
        v: PROTOCOL_VERSION,
        id: this.nextId(),
        space: agent.space,
        from: agent.id,
        fromRole: agent.role,
        to: target.id,
        type: msg.type,
        refs: msg.refs,
        ...(msg.note ? { note: msg.note } : {}),
        ...(msg.replyTo ? { replyTo: msg.replyTo } : {}),
        ts,
      }
      this.store.insert(env, wakes)
      ids.push(env.id)
      const conn = this.conns.get(target.id)
      if (conn) online = true
      if (conn && wakes) conn.send({ op: 'deliver', msg: env })
    }
    if (msg.type === 'status') this.store.updateAgent(agent.id, { statusNote: msg.note ?? null, task: msg.refs.task ?? null })
    return { op: 'sent', ref, ids, online }
  }

  /** What the status page shows for one space. */
  snapshot(space: string): Snapshot {
    return {
      space,
      at: this.now().toISOString(),
      agents: this.store.agents(space).map((a) => ({
        id: a.id,
        role: a.role,
        presence: this.conns.has(a.id) ? (a.state ?? 'idle') : 'offline',
        task: a.task,
        statusNote: a.statusNote,
        lastSeen: a.lastSeen,
        waiting: this.store.pending(a.id).length,
      })),
      openQuestions: this.store.openQuestions(space),
    }
  }

  private nextId(): string {
    this.seq = (this.seq + 1) % 46656 // 36^3
    return this.now().getTime().toString(36).padStart(9, '0') + this.seq.toString(36).padStart(3, '0')
  }
}

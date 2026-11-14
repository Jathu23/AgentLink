// The Link's connection to the Hub: stays connected, retries with backoff, hands each
// incoming signal to the session exactly once, and confirms it only after the session has it.

import { WebSocket } from 'ws'
import { checkSend, HubFrame, PING_TEXT, PROTOCOL_VERSION, type Envelope, type Role } from '@agentlink/protocol'

export type SendResult =
  /** delivered: receiver online. stored: receiver offline, the Hub keeps it. queued: Hub not reachable, sent on reconnect. */
  { ok: true; state: 'delivered' | 'stored' | 'queued' } | { ok: false; code: string; reason: string }

export type HubClientOptions = {
  url: string
  token: string
  /** Push the signal into the session. If it throws, the signal is not confirmed and the Hub sends it again later. */
  onDeliver: (env: Envelope) => Promise<void>
  log?: (line: string) => void
  retryMs?: number
  maxRetryMs?: number
  replyTimeoutMs?: number
  /** 'send' for a session that cannot show a pushed signal: it sends, and never receives. Default 'full'. */
  mode?: 'full' | 'send'
  /** How often to ping the Hub. A connection with no frame for 2.5 pings is treated as dead and reopened. */
  pingMs?: number
}

const QUEUE_LIMIT = 20
// The Hub closed us on purpose: a wrong token, or a newer session using the same token. Retrying would only fight.
const FINAL_CLOSE_CODES = new Set([4000, 4401])

export class HubClient {
  role: Role | undefined
  agent: string | undefined
  online = false

  private ws: WebSocket | undefined
  private stopped = false
  private retry: number
  private timer: NodeJS.Timeout | undefined
  private seq = 0
  private waiters = new Map<string, (r: SendResult) => void>()
  private inboxWaiters = new Map<string, (msgs: Envelope[]) => void>()
  private queue: unknown[] = []
  private seen = new Set<string>()

  constructor(private opts: HubClientOptions) {
    this.retry = opts.retryMs ?? 1000
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.timer)
    this.ws?.close()
  }

  async send(msg: unknown): Promise<SendResult> {
    // Once the role is known, a message the Hub would refuse never leaves the laptop.
    if (this.role) {
      const check = checkSend(this.role, msg)
      if (!check.ok) return check
    }
    if (!this.online || !this.ws) {
      if (this.queue.length >= QUEUE_LIMIT) return { ok: false, code: 'queue_full', reason: 'the Hub has been unreachable for too many messages' }
      this.queue.push(msg)
      return { ok: true, state: 'queued' }
    }
    return this.transmit(msg)
  }

  /** Everything waiting for this agent at the Hub. For a session that cannot be pushed to. Undefined when the Hub is not reachable. */
  fetchInbox(): Promise<Envelope[] | undefined> {
    if (!this.online || !this.ws) return Promise.resolve(undefined)
    const ref = `i${++this.seq}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.inboxWaiters.delete(ref)
        resolve(undefined)
      }, this.opts.replyTimeoutMs ?? 10_000)
      this.inboxWaiters.set(ref, (msgs) => {
        clearTimeout(timer)
        this.inboxWaiters.delete(ref)
        resolve(msgs)
      })
      this.ws!.send(JSON.stringify({ op: 'fetch', ref }))
    })
  }

  private transmit(msg: unknown): Promise<SendResult> {
    const ref = String(++this.seq)
    return new Promise<SendResult>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(ref)
        resolve({ ok: false, code: 'timeout', reason: 'the Hub did not confirm in time' })
      }, this.opts.replyTimeoutMs ?? 10_000)
      this.waiters.set(ref, (r) => {
        clearTimeout(timer)
        this.waiters.delete(ref)
        resolve(r)
      })
      this.ws!.send(JSON.stringify({ op: 'send', ref, msg }))
    })
  }

  private connect(): void {
    const ws = new WebSocket(this.opts.url)
    this.ws = ws
    ws.on('open', () => ws.send(JSON.stringify({ op: 'hello', v: PROTOCOL_VERSION, token: this.opts.token, mode: this.opts.mode ?? 'full' })))
    const pingMs = this.opts.pingMs ?? 30_000
    let lastFrame = Date.now()
    // A sleeping laptop or a dropped tunnel leaves a socket that looks open; the ping finds out.
    const pinger = setInterval(() => {
      if (Date.now() - lastFrame > pingMs * 2.5) return ws.terminate()
      if (ws.readyState === ws.OPEN) ws.send(PING_TEXT)
    }, pingMs)
    pinger.unref()
    ws.on('message', (data) => {
      lastFrame = Date.now()
      void this.onMessage(ws, String(data))
    })
    ws.on('error', (err) => this.log(`socket error: ${err.message}`))
    ws.on('close', (code) => {
      clearInterval(pinger)
      this.online = false
      for (const waiter of [...this.waiters.values()]) waiter({ ok: false, code: 'disconnected', reason: 'the connection to the Hub dropped' })
      if (this.stopped) return
      if (FINAL_CLOSE_CODES.has(code)) return this.log(`closed by the Hub (${code}), not retrying`)
      this.timer = setTimeout(() => this.connect(), this.retry)
      this.retry = Math.min(this.retry * 2, this.opts.maxRetryMs ?? 30_000)
    })
  }

  private async onMessage(ws: WebSocket, text: string): Promise<void> {
    let frame: HubFrame
    try {
      frame = HubFrame.parse(JSON.parse(text))
    } catch {
      return this.log('ignored a frame that is not in the protocol')
    }
    switch (frame.op) {
      case 'welcome': {
        this.agent = frame.agent
        this.role = frame.role
        this.online = true
        this.retry = this.opts.retryMs ?? 1000
        this.log(`connected as ${frame.agent} (${frame.role}), ${frame.pending} waiting`)
        for (const msg of this.queue.splice(0)) {
          const r = await this.transmit(msg)
          if (!r.ok) this.log(`queued message refused: ${r.code} ${r.reason}`)
        }
        return
      }
      case 'deliver': {
        const { msg } = frame
        if (!this.seen.has(msg.id)) {
          try {
            await this.opts.onDeliver(msg)
          } catch (err) {
            return this.log(`could not hand ${msg.id} to the session, the Hub will resend: ${err}`)
          }
          this.seen.add(msg.id)
        }
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ op: 'ack', id: msg.id }))
        return
      }
      case 'pong':
        return
      case 'inbox':
        return this.inboxWaiters.get(frame.ref)?.(frame.msgs)
      case 'sent':
        return this.waiters.get(frame.ref)?.({ ok: true, state: frame.online ? 'delivered' : 'stored' })
      case 'rejected':
        if (frame.ref) return this.waiters.get(frame.ref)?.({ ok: false, code: frame.code, reason: frame.reason })
        return this.log(`rejected: ${frame.code} ${frame.reason}`)
    }
  }

  private log(line: string): void {
    this.opts.log?.(line)
  }
}

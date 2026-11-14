// SQLite storage for the Hub. Tokens are stored as hashes only.

import { DatabaseSync } from 'node:sqlite'
import { createHash, randomBytes } from 'node:crypto'
import type { Envelope, PresenceState, Role } from '@agentlink/protocol'

export type Agent = { id: string; space: string; role: Role }
export type AgentRow = Agent & {
  lastSeen: string | null
  state: PresenceState | null
  task: string | null
  statusNote: string | null
}
export type OpenQuestion = { from: string; question: string; task?: string; area?: string; ts: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, space TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
  last_seen TEXT, state TEXT, task TEXT, status_note TEXT);
CREATE TABLE IF NOT EXISTS viewers (key_hash TEXT PRIMARY KEY, name TEXT NOT NULL, space TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, space TEXT NOT NULL, from_id TEXT NOT NULL, from_role TEXT NOT NULL, to_id TEXT NOT NULL,
  type TEXT NOT NULL, refs TEXT NOT NULL, note TEXT, reply_to TEXT, ts TEXT NOT NULL, q_ref TEXT,
  acked INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS ix_messages_pending ON messages (to_id, acked);
`

const hash = (secret: string) => createHash('sha256').update(secret).digest('hex')
const newSecret = () => randomBytes(32).toString('base64url')

type Row = Record<string, unknown>
const AGENT_COLUMNS = { lastSeen: 'last_seen', state: 'state', task: 'task', statusNote: 'status_note' } as const

export class Store {
  private db: DatabaseSync

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path)
    this.db.exec(SCHEMA)
  }

  /** Registers an agent and returns its token. The token is shown once and never stored. */
  addAgent(agent: Agent): string {
    const token = newSecret()
    this.db
      .prepare('INSERT INTO agents (id, space, role, token_hash) VALUES (?, ?, ?, ?)')
      .run(agent.id, agent.space, agent.role, hash(token))
    return token
  }

  agentByToken(token: string): Agent | undefined {
    const r = this.db.prepare('SELECT id, space, role FROM agents WHERE token_hash = ?').get(hash(token)) as Row | undefined
    return r && { id: String(r.id), space: String(r.space), role: r.role as Role }
  }

  agents(space: string): AgentRow[] {
    const rows = this.db.prepare('SELECT * FROM agents WHERE space = ? ORDER BY role, id').all(space) as Row[]
    return rows.map((r) => ({
      id: String(r.id),
      space: String(r.space),
      role: r.role as Role,
      lastSeen: (r.last_seen as string | null) ?? null,
      state: (r.state as PresenceState | null) ?? null,
      task: (r.task as string | null) ?? null,
      statusNote: (r.status_note as string | null) ?? null,
    }))
  }

  updateAgent(id: string, patch: Partial<Pick<AgentRow, keyof typeof AGENT_COLUMNS>>): void {
    for (const [key, value] of Object.entries(patch)) {
      const column = AGENT_COLUMNS[key as keyof typeof AGENT_COLUMNS]
      this.db.prepare(`UPDATE agents SET ${column} = ? WHERE id = ?`).run(value ?? null, id)
    }
  }

  /** `deliverable` false means the message is for the status page only and is never pushed. */
  insert(env: Envelope, deliverable: boolean): void {
    this.db
      .prepare(
        `INSERT INTO messages (id, space, from_id, from_role, to_id, type, refs, note, reply_to, ts, q_ref, acked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        env.id, env.space, env.from, env.fromRole, env.to, env.type, JSON.stringify(env.refs),
        env.note ?? null, env.replyTo ?? null, env.ts, env.refs.question ?? null, deliverable ? 0 : 1,
      )
  }

  /** Messages pushed (or waiting to be pushed) that the receiver has not confirmed, oldest first. */
  pending(agentId: string): Envelope[] {
    const rows = this.db.prepare('SELECT * FROM messages WHERE to_id = ? AND acked = 0 ORDER BY rowid').all(agentId) as Row[]
    return rows.map((r) => ({
      v: 1,
      id: String(r.id),
      space: String(r.space),
      from: String(r.from_id),
      fromRole: r.from_role as Role,
      to: String(r.to_id),
      type: r.type as Envelope['type'],
      refs: JSON.parse(String(r.refs)),
      ...(r.note ? { note: String(r.note) } : {}),
      ...(r.reply_to ? { replyTo: String(r.reply_to) } : {}),
      ts: String(r.ts),
    }))
  }

  ack(agentId: string, id: string): void {
    this.db.prepare('UPDATE messages SET acked = 1 WHERE id = ? AND to_id = ?').run(id, agentId)
  }

  /** Questions with no later answer to the same agent for the same question id. */
  openQuestions(space: string): OpenQuestion[] {
    const rows = this.db
      .prepare(
        `SELECT q.from_id, q.q_ref, q.refs, MIN(q.ts) AS ts FROM messages q
         WHERE q.space = ? AND q.type = 'question' AND NOT EXISTS (
           SELECT 1 FROM messages a
           WHERE a.type = 'answer' AND a.to_id = q.from_id AND a.q_ref = q.q_ref AND a.rowid > q.rowid)
         GROUP BY q.from_id, q.q_ref ORDER BY ts`,
      )
      .all(space) as Row[]
    return rows.map((r) => {
      const refs = JSON.parse(String(r.refs)) as { task?: string; area?: string }
      return { from: String(r.from_id), question: String(r.q_ref), task: refs.task, area: refs.area, ts: String(r.ts) }
    })
  }

  /** A read-only key for one person's status page link. */
  addViewer(name: string, space: string): string {
    const key = newSecret()
    this.db.prepare('INSERT INTO viewers (key_hash, name, space) VALUES (?, ?, ?)').run(hash(key), name, space)
    return key
  }

  viewerSpace(key: string): string | undefined {
    const r = this.db.prepare('SELECT space FROM viewers WHERE key_hash = ?').get(hash(key)) as Row | undefined
    return r && String(r.space)
  }
}

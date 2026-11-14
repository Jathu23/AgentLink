// End-to-end check of a running Cloudflare Hub (local `wrangler dev` or deployed):
//   AGENTLINK_URL=http://127.0.0.1:8801 AGENTLINK_ADMIN_KEY=... node --import tsx cloudflare/smoke.mts
// Uses its own space and agents ("smoke"), and removes the agents when it is done.

import assert from 'node:assert/strict'
import type { Envelope } from '@agentlink/protocol'
import { HubClient } from '../packages/link/src/client.ts'

const base = process.env.AGENTLINK_URL!.replace(/\/$/, '')
const headers = { authorization: `Bearer ${process.env.AGENTLINK_ADMIN_KEY}`, 'content-type': 'application/json' }
const admin = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, string> }
}
const until = async (cond: () => boolean, what: string) => {
  const end = Date.now() + 10_000
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 50))
  }
}
const link = (token: string) => {
  const got: Envelope[] = []
  const client = new HubClient({ url: base.replace(/^http/, 'ws') + '/ws', token, retryMs: 200, onDeliver: async (e) => void got.push(e) })
  client.start()
  return { client, got }
}
const step = (name: string) => console.log('ok  ' + name)

assert.equal((await fetch(base + '/admin/agents', { method: 'POST', body: '{}' })).status, 401)
step('admin without the key is refused')

for (const id of ['smoke-desk', 'smoke-member']) await admin('DELETE', `/admin/agents/${id}`)
const desk = await admin('POST', '/admin/agents', { id: 'smoke-desk', space: 'smoke', role: 'lead' })
const member = await admin('POST', '/admin/agents', { id: 'smoke-member', space: 'smoke', role: 'member' })
assert.equal(desk.status, 200, JSON.stringify(desk.body))
assert.equal(member.status, 200, JSON.stringify(member.body))
assert.equal((await admin('POST', '/admin/agents', { id: 'smoke-desk', space: 'smoke', role: 'lead' })).status, 409)
const viewer = await admin('POST', '/admin/viewers', { name: 'smoke', space: 'smoke' })
step('agents and a viewer are registered, a duplicate is refused')

const m = link(member.body.token!)
await until(() => m.client.online, 'member online')
assert.deepEqual(await m.client.send({ to: 'lead', type: 'question', refs: { question: 'Q-1', task: 'T-1' } }), { ok: true, state: 'stored' })
step('a question to an offline lead is stored')

const d = link(desk.body.token!)
await until(() => d.got.length === 1, 'question delivered on connect')
step('the lead gets it on connecting')

assert.deepEqual(await d.client.send({ to: 'smoke-member', type: 'answer', refs: { question: 'Q-1', commit: 'abc1234' } }), { ok: true, state: 'delivered' })
await until(() => m.got.length === 1, 'answer delivered')
step('the answer is pushed to the member')

const r = await m.client.send({ to: 'lead', type: 'assign', refs: { task: 'T-1' } })
assert.equal(!r.ok && r.code, 'role_not_allowed')
step('a member cannot command')

const status = (await (await fetch(`${base}/api/status?key=${viewer.body.key}`)).json()) as { agents: { id: string; presence: string; waiting: number }[]; openQuestions: unknown[] }
await until(() => true, '')
assert.deepEqual(status.agents.map((a) => [a.id, a.presence]), [['smoke-desk', 'idle'], ['smoke-member', 'idle']])
assert.equal(status.openQuestions.length, 0)
assert.equal((await fetch(`${base}/api/status?key=nope`)).status, 401)
step('the status page shows both online and no open question')

const lines: string[] = []
const bad = new HubClient({ url: base.replace(/^http/, 'ws') + '/ws', token: 'x'.repeat(43), retryMs: 200, log: (l) => void lines.push(l), onDeliver: async () => {} })
bad.start()
await until(() => lines.some((l) => l.includes('not retrying')), 'bad token closed')
step('a wrong token is closed')

m.client.stop()
d.client.stop()
bad.stop()
for (const id of ['smoke-desk', 'smoke-member']) await admin('DELETE', `/admin/agents/${id}`)
console.log('PASS')
process.exit(0)

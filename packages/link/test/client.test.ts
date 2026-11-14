import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Envelope } from '@agentlink/protocol'
import { Hub } from '@agentlink/hub'
import { openStore } from '@agentlink/hub/node'
import { startServer, type RunningServer } from '@agentlink/hub/server'
import { HubClient } from '../src/client.ts'

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function world(port = 0) {
  const store = openStore()
  const tokens = {
    desk: store.addAgent({ id: 'desk', space: 'backend', role: 'lead' }),
    laptop2: store.addAgent({ id: 'laptop2', space: 'backend', role: 'member' }),
  }
  const hub = new Hub(store)
  const server = await startServer(hub, port)
  return { store, tokens, hub, server }
}

function link(port: number, token: string, onDeliver?: (env: Envelope) => Promise<void>) {
  const got: Envelope[] = []
  const client = new HubClient({
    url: `ws://127.0.0.1:${port}/ws`,
    token,
    retryMs: 20,
    maxRetryMs: 50,
    onDeliver: onDeliver ?? (async (env) => void got.push(env)),
  })
  client.start()
  return { client, got }
}

const question = { to: 'lead', type: 'question', refs: { question: 'Q-25', task: 'RT-41' } }

test('a question goes from one Link to the other and is confirmed', async () => {
  const w = await world()
  const desk = link(w.server.port, w.tokens.desk)
  const member = link(w.server.port, w.tokens.laptop2)
  try {
    await until(() => desk.client.online && member.client.online, 'both online')
    assert.deepEqual([member.client.agent, member.client.role], ['laptop2', 'member'])

    assert.deepEqual(await member.client.send(question), { ok: true, state: 'delivered' })
    await until(() => desk.got.length === 1, 'delivery')
    assert.equal(desk.got[0]?.refs.question, 'Q-25')
    await until(() => w.store.pending('desk').length === 0, 'ack')

    assert.deepEqual(await desk.client.send({ to: 'laptop2', type: 'answer', refs: { question: 'Q-25', commit: 'abc1234' } }), { ok: true, state: 'delivered' })
    await until(() => member.got.length === 1, 'answer')
  } finally {
    desk.client.stop()
    member.client.stop()
    await w.server.close()
  }
})

test('a message the role may not send never leaves the laptop', async () => {
  const w = await world()
  const member = link(w.server.port, w.tokens.laptop2)
  try {
    await until(() => member.client.online, 'online')
    const r = await member.client.send({ to: 'lead', type: 'assign', refs: { task: 'RT-41' } })
    assert.equal(!r.ok && r.code, 'role_not_allowed')
  } finally {
    member.client.stop()
    await w.server.close()
  }
})

test('the receiver is offline: stored, then delivered when its Link starts', async () => {
  const w = await world()
  const member = link(w.server.port, w.tokens.laptop2)
  let desk: ReturnType<typeof link> | undefined
  try {
    await until(() => member.client.online, 'online')
    assert.deepEqual(await member.client.send(question), { ok: true, state: 'stored' })
    desk = link(w.server.port, w.tokens.desk)
    await until(() => desk!.got.length === 1, 'late delivery')
  } finally {
    member.client.stop()
    desk?.client.stop()
    await w.server.close()
  }
})

test('the Hub is down: the message is queued and goes out when the Hub is back', async () => {
  const first = await world()
  const port = first.server.port
  await first.server.close()

  const member = link(port, 'unused-until-the-hub-is-back'.padEnd(43, 'x'))
  let server: RunningServer | undefined
  try {
    assert.deepEqual(await member.client.send(question), { ok: true, state: 'queued' })
    member.client.stop()

    const w = await world(port)
    server = w.server
    const real = link(port, w.tokens.laptop2)
    assert.deepEqual(await real.client.send(question), { ok: true, state: 'queued' })
    await until(() => w.hub.snapshot('backend').openQuestions.length === 1, 'queued question reaches the Hub')
    real.client.stop()
  } finally {
    member.client.stop()
    await server?.close()
  }
})

test('a signal the session did not take is sent again, and one it took is not repeated', async () => {
  const w = await world()
  const member = link(w.server.port, w.tokens.laptop2)
  let failing: ReturnType<typeof link> | undefined
  let working: ReturnType<typeof link> | undefined
  try {
    await until(() => member.client.online, 'online')
    await member.client.send(question)

    let attempts = 0
    failing = link(w.server.port, w.tokens.desk, async () => {
      attempts++
      throw new Error('session not ready')
    })
    await until(() => attempts === 1, 'first attempt')
    failing.client.stop()
    assert.equal(w.store.pending('desk').length, 1)

    working = link(w.server.port, w.tokens.desk)
    await until(() => working!.got.length === 1, 'redelivery')
    await until(() => w.store.pending('desk').length === 0, 'ack after redelivery')
  } finally {
    member.client.stop()
    failing?.client.stop()
    working?.client.stop()
    await w.server.close()
  }
})

test('a wrong token is not retried', async () => {
  const w = await world()
  const lines: string[] = []
  const client = new HubClient({ url: `ws://127.0.0.1:${w.server.port}/ws`, token: 'w'.repeat(43), retryMs: 10, log: (l) => void lines.push(l), onDeliver: async () => {} })
  client.start()
  try {
    await until(() => lines.some((l) => l.includes('not retrying')), 'final close')
    assert.equal(client.online, false)
  } finally {
    client.stop()
    await w.server.close()
  }
})

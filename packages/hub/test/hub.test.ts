import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WebSocket } from 'ws'
import type { HubFrame } from '@agentlink/protocol'
import { Hub, type Agent, type Conn } from '../src/hub.ts'
import { openStore } from '../src/node-store.ts'
import { startServer } from '../src/server.ts'

const lead: Agent = { id: 'desk', space: 'backend', role: 'lead' }
const laptop2: Agent = { id: 'laptop2', space: 'backend', role: 'member' }
const abinaia: Agent = { id: 'abinaia', space: 'backend', role: 'member' }
const outsider: Agent = { id: 'webdev', space: 'frontend', role: 'member' }

function setup() {
  const store = openStore()
  const tokens = Object.fromEntries([lead, laptop2, abinaia, outsider].map((a) => [a.id, store.addAgent(a)]))
  return { store, tokens, hub: new Hub(store) }
}

function connect(hub: Hub, agent: Agent) {
  const frames: HubFrame[] = []
  const conn: Conn = { send: (f) => void frames.push(f), close: () => void frames.push({ op: 'rejected', code: 'closed', reason: '' }) }
  hub.attach(agent, conn)
  const of = <T extends HubFrame['op']>(op: T) => frames.filter((f): f is Extract<HubFrame, { op: T }> => f.op === op)
  const send = (msg: unknown) => {
    hub.onFrame(agent, { op: 'send', ref: 'r1', msg })
    return frames.at(-1)!
  }
  return { conn, frames, of, send }
}

const question = { to: 'lead', type: 'question', refs: { question: 'Q-25', task: 'RT-41', area: 'stays/rates' } }

test('a token finds its agent and a wrong token finds nothing', () => {
  const { hub, tokens } = setup()
  assert.deepEqual(hub.auth(tokens.laptop2!), laptop2)
  assert.equal(hub.auth('x'.repeat(43)), undefined)
})

test('a question reaches the lead at once when the lead is online', () => {
  const { hub } = setup()
  const desk = connect(hub, lead)
  const member = connect(hub, laptop2)
  const reply = member.send(question)
  assert.equal(reply.op, 'sent')
  assert.equal(reply.op === 'sent' && reply.online, true)
  const [delivered] = desk.of('deliver')
  assert.equal(delivered?.msg.from, 'laptop2')
  assert.equal(delivered?.msg.to, 'desk')
  assert.deepEqual(delivered?.msg.refs, question.refs)
})

test('a message waits while the receiver is off and arrives on reconnect, until acked', () => {
  const { hub } = setup()
  const member = connect(hub, laptop2)
  const reply = member.send(question)
  assert.equal(reply.op === 'sent' && reply.online, false)

  const first = connect(hub, lead)
  assert.equal(first.of('welcome')[0]?.pending, 1)
  const id = first.of('deliver')[0]!.msg.id
  hub.detach(lead, first.conn)

  const second = connect(hub, lead) // not acked, so it comes again
  assert.equal(second.of('deliver')[0]?.msg.id, id)
  hub.onFrame(lead, { op: 'ack', id })
  hub.detach(lead, second.conn)

  assert.equal(connect(hub, lead).of('deliver').length, 0)
})

test('a member cannot command, and cannot reach another space', () => {
  const { hub } = setup()
  connect(hub, abinaia)
  const member = connect(hub, laptop2)
  const reply = member.send({ to: 'abinaia', type: 'assign', refs: { task: 'RT-41' } })
  assert.equal(reply.op === 'rejected' && reply.code, 'role_not_allowed')

  const desk = connect(hub, lead)
  const cross = desk.send({ to: 'webdev', type: 'assign', refs: { task: 'RT-41' } })
  assert.equal(cross.op === 'rejected' && cross.code, 'bad_target')
})

test('an answer closes the open question', () => {
  const { hub } = setup()
  const desk = connect(hub, lead)
  const member = connect(hub, laptop2)
  member.send(question)
  assert.deepEqual(hub.snapshot('backend').openQuestions.map((q) => [q.from, q.question, q.task]), [['laptop2', 'Q-25', 'RT-41']])

  desk.send({ to: 'laptop2', type: 'answer', refs: { question: 'Q-25', commit: 'abc1234' } })
  assert.equal(member.of('deliver')[0]?.msg.type, 'answer')
  assert.equal(hub.snapshot('backend').openQuestions.length, 0)
})

test('status shows on the page and is never pushed', () => {
  const { hub } = setup()
  const desk = connect(hub, lead)
  const member = connect(hub, laptop2)
  hub.onFrame(laptop2, { op: 'presence', state: 'working', task: 'RT-41' })
  member.send({ to: 'lead', type: 'status', refs: { task: 'RT-41' }, note: 'tests running' })
  assert.equal(desk.of('deliver').length, 0)

  const row = hub.snapshot('backend').agents.find((a) => a.id === 'laptop2')
  assert.deepEqual([row?.presence, row?.task, row?.statusNote], ['working', 'RT-41', 'tests running'])
  hub.detach(laptop2, member.conn)
  assert.equal(hub.snapshot('backend').agents.find((a) => a.id === 'laptop2')?.presence, 'offline')
  assert.equal(hub.snapshot('backend').agents.find((a) => a.id === 'desk')?.waiting, 0)
})

test('a lead broadcast goes to every member of the space and nobody else', () => {
  const { hub } = setup()
  const desk = connect(hub, lead)
  const a = connect(hub, laptop2)
  const b = connect(hub, abinaia)
  const c = connect(hub, outsider)
  const reply = desk.send({ to: 'all', type: 'pull' })
  assert.equal(reply.op === 'sent' && reply.ids.length, 2)
  assert.deepEqual([a.of('deliver').length, b.of('deliver').length, c.of('deliver').length], [1, 1, 0])
})

test('a flood from one agent is cut off', () => {
  const { hub } = setup()
  connect(hub, lead)
  const member = connect(hub, laptop2)
  let last = member.send(question)
  for (let i = 0; i < 30; i++) last = member.send(question)
  assert.equal(last.op === 'rejected' && last.code, 'rate_limited')
})

test('over a real socket: hello, question, deliver, and a bad token is closed', async () => {
  const { hub, store, tokens } = setup()
  const server = await startServer(hub, 0)
  const url = `ws://127.0.0.1:${server.port}/ws`

  const open = (token: string) =>
    new Promise<{ ws: WebSocket; next: () => Promise<HubFrame> }>((resolve, reject) => {
      const ws = new WebSocket(url)
      const queue: HubFrame[] = []
      const waiters: ((f: HubFrame) => void)[] = []
      ws.on('message', (d) => {
        const frame = JSON.parse(String(d)) as HubFrame
        const waiter = waiters.shift()
        if (waiter) waiter(frame)
        else queue.push(frame)
      })
      ws.on('error', reject)
      ws.on('open', () => {
        ws.send(JSON.stringify({ op: 'hello', v: 1, token }))
        resolve({ ws, next: () => new Promise((r) => (queue.length ? r(queue.shift()!) : waiters.push(r))) })
      })
    })

  try {
    const desk = await open(tokens.desk!)
    assert.equal((await desk.next()).op, 'welcome')
    const member = await open(tokens.laptop2!)
    assert.equal((await member.next()).op, 'welcome')

    member.ws.send(JSON.stringify({ op: 'send', ref: 'a', msg: question }))
    const sent = await member.next()
    assert.equal(sent.op === 'sent' && sent.online, true)
    const delivered = await desk.next()
    assert.equal(delivered.op === 'deliver' && delivered.msg.refs.question, 'Q-25')

    const bad = new WebSocket(url)
    const code = await new Promise<number>((resolve) => {
      bad.on('open', () => bad.send(JSON.stringify({ op: 'hello', v: 1, token: 'z'.repeat(43) })))
      bad.on('close', (c) => resolve(c))
    })
    assert.equal(code, 4401)

    const key = store.addViewer('jathu', 'backend')
    const ok = await fetch(`http://127.0.0.1:${server.port}/api/status?key=${key}`)
    assert.deepEqual(((await ok.json()) as { agents: { id: string; presence: string }[] }).agents.map((a) => [a.id, a.presence]), [
      ['desk', 'idle'],
      ['abinaia', 'offline'],
      ['laptop2', 'idle'],
    ])
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/status?key=nope`)).status, 401)

    desk.ws.close()
    member.ws.close()
  } finally {
    await server.close()
  }
})

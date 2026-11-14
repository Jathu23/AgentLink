// Runs the real Link process the way Claude Code does (MCP over stdio) against a real Hub.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { Hub } from '@agentlink/hub'
import { openStore } from '@agentlink/hub/node'
import { startServer } from '@agentlink/hub/server'
import { HubClient } from '../src/client.ts'

const here = path.dirname(fileURLToPath(import.meta.url))

const bundle = path.join(here, '../../../plugin/dist/link.mjs')
const entries: [string, string[]][] = [
  ['source', ['--import', 'tsx', path.join(here, '../src/link.ts')]],
  ['plugin bundle', [bundle]],
]

for (const [name, args] of entries) test(`the Link process (${name}): the signal tool sends, and an incoming signal is pushed as a channel event`, { skip: name === 'plugin bundle' && !existsSync(bundle) }, async () => {
  const store = openStore()
  const deskToken = store.addAgent({ id: 'desk', space: 'backend', role: 'lead' })
  const memberToken = store.addAgent({ id: 'laptop2', space: 'backend', role: 'member' })
  const hub = new Hub(store)
  const server = await startServer(hub, 0)
  const url = `ws://127.0.0.1:${server.port}/ws`
  const home = mkdtempSync(path.join(os.tmpdir(), 'agentlink-'))

  const pushed: { method: string; params?: { content?: string; meta?: Record<string, string> } }[] = []
  const session = new Client({ name: 'fake-session', version: '0' }, { capabilities: {} })
  session.fallbackNotificationHandler = async (n) => void pushed.push(n as (typeof pushed)[number])
  const desk = new HubClient({ url, token: deskToken, retryMs: 20, onDeliver: async () => {} })

  try {
    await session.connect(
      new StdioClientTransport({
        command: process.execPath,
        args,
        cwd: path.join(here, '../../..'),
        env: { ...(process.env as Record<string, string>), AGENTLINK_HUB: url, AGENTLINK_TOKEN: memberToken, AGENTLINK_RECEIVE: '1', USERPROFILE: home, HOME: home },
      }),
    )
    assert.deepEqual((await session.listTools()).tools.map((t) => t.name), ['signal', 'inbox'])

    const until = async (cond: () => boolean, what: string) => {
      const end = Date.now() + 5000
      while (!cond()) {
        if (Date.now() > end) assert.fail(`timed out waiting for: ${what}`)
        await new Promise((r) => setTimeout(r, 20))
      }
    }
    await until(() => hub.snapshot('backend').agents.find((a) => a.id === 'laptop2')?.presence === 'idle', 'the Link connects to the Hub')

    const sent = (await session.callTool({ name: 'signal', arguments: { type: 'question', question: 'Q-25', task: 'RT-41', area: 'stays/rates' } })) as {
      content: { text: string }[]
      isError?: boolean
    }
    assert.equal(sent.isError, false)
    assert.match(sent.content[0]!.text, /offline/)
    assert.deepEqual(hub.snapshot('backend').openQuestions.map((q) => q.question), ['Q-25'])

    const refused = (await session.callTool({ name: 'signal', arguments: { type: 'assign', task: 'RT-41' } })) as { content: { text: string }[]; isError?: boolean }
    assert.equal(refused.isError, true)
    assert.match(refused.content[0]!.text, /role_not_allowed/)

    desk.start()
    await until(() => desk.online, 'desk online')
    await desk.send({ to: 'laptop2', type: 'answer', refs: { question: 'Q-25', commit: 'abc1234' } })
    await until(() => pushed.length === 1, 'channel event')
    assert.equal(pushed[0]?.method, 'notifications/claude/channel')
    assert.equal(pushed[0]?.params?.content, 'answer Q-25, commit abc1234')
    assert.equal(pushed[0]?.params?.meta?.sender, 'desk')
    assert.equal(pushed[0]?.params?.meta?.type, 'answer')
    await until(() => store.pending('laptop2').length === 0, 'the Link confirms the signal')
  } finally {
    desk.stop()
    await session.close()
    await server.close()
  }
})

// Hub command line:
//   start                               run the Hub
//   add-agent <id> <space> <lead|member>   register an agent, prints its token once
//   add-viewer <name> <space>           create a read-only status page key, prints it once
//
// Environment: AGENTLINK_DB (default ./.agentlink/hub.sqlite), AGENTLINK_PORT (8790),
// AGENTLINK_HOST (127.0.0.1; set 0.0.0.0 to accept other laptops on the network).

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { AgentId, isReservedAgentId, ROLES, SpaceId, type Role } from '@agentlink/protocol'
import { Hub, Store } from './hub.ts'
import { startServer } from './server.ts'

const dbPath = path.resolve(process.env.AGENTLINK_DB ?? '.agentlink/hub.sqlite')
mkdirSync(path.dirname(dbPath), { recursive: true })
const store = new Store(dbPath)

const fail = (message: string): never => {
  console.error(message)
  process.exit(1)
}

const [command, a, b, c] = process.argv.slice(2)

if (command === 'start') {
  const port = Number(process.env.AGENTLINK_PORT ?? 8790)
  const host = process.env.AGENTLINK_HOST ?? '127.0.0.1'
  const running = await startServer(new Hub(store), port, host)
  console.log(`AgentLink Hub on http://${host}:${running.port} (db ${dbPath})`)
} else if (command === 'add-agent') {
  if (!a || !AgentId.safeParse(a).success || isReservedAgentId(a)) fail(`'${a}' is not a usable agent id`)
  if (!b || !SpaceId.safeParse(b).success) fail(`'${b}' is not a usable space id`)
  if (!ROLES.includes(c as Role)) fail(`role must be one of: ${ROLES.join(', ')}`)
  const token = store.addAgent({ id: a!, space: b!, role: c as Role })
  console.log(`agent ${a} (${c}) in space ${b}\ntoken (shown once): ${token}`)
} else if (command === 'add-viewer') {
  if (!a || !b || !SpaceId.safeParse(b).success) fail('usage: add-viewer <name> <space>')
  console.log(`viewer ${a} for space ${b}\nstatus page: /?key=${store.addViewer(a!, b!)}`)
} else {
  fail('usage: start | add-agent <id> <space> <lead|member> | add-viewer <name> <space>')
}

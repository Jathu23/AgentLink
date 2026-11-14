#!/usr/bin/env node
// Registers agents and status page viewers on a deployed Hub.
//   node cloudflare/admin.mjs add-agent <id> <space> <lead|member>
//   node cloudflare/admin.mjs add-viewer <name> <space>
//   node cloudflare/admin.mjs remove-agent <id>
// Needs AGENTLINK_URL (https://...workers.dev) and AGENTLINK_ADMIN_KEY in the environment.

const base = process.env.AGENTLINK_URL?.replace(/\/$/, '')
const key = process.env.AGENTLINK_ADMIN_KEY
if (!base || !key) {
  console.error('Set AGENTLINK_URL and AGENTLINK_ADMIN_KEY first.')
  process.exit(1)
}
const [command, a, b, c] = process.argv.slice(2)
const call = (method, path, body) =>
  fetch(base + path, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })

const res =
  command === 'add-agent' ? await call('POST', '/admin/agents', { id: a, space: b, role: c })
  : command === 'add-viewer' ? await call('POST', '/admin/viewers', { name: a, space: b })
  : command === 'remove-agent' ? await call('DELETE', `/admin/agents/${a}`)
  : undefined
if (!res) {
  console.error('usage: add-agent <id> <space> <lead|member> | add-viewer <name> <space> | remove-agent <id>')
  process.exit(1)
}
const out = res.headers.get('content-type')?.includes('json') ? await res.json() : {}
if (!res.ok) {
  console.error(`failed (${res.status}): ${out.error ?? 'check AGENTLINK_ADMIN_KEY'}`)
  process.exit(1)
}
if (out.token) console.log(`agent ${out.id} (${out.role}) in space ${out.space}\nhub:   ${base.replace(/^http/, 'ws')}/ws\ntoken (shown once): ${out.token}`)
else if (out.key) console.log(`viewer ${out.name} for space ${out.space}\nstatus page: ${base}/?key=${out.key}`)
else console.log(JSON.stringify(out))

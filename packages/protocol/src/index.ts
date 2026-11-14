// The message contract shared by the Hub and every Link.
//
// A message is a signal. It carries ids (a question, a task, a PR, a commit) and at most
// one short note. The content those ids point to lives in git, never here.

import { z } from 'zod'

export const PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// Roles and message types
// ---------------------------------------------------------------------------

export const ROLES = ['lead', 'member'] as const
export type Role = (typeof ROLES)[number]

export const MESSAGE_TYPES = [
  'question', // member -> lead: a question row is pushed and something is blocked on it
  'answer', // lead -> member: the question is answered in git at this commit
  'assign', // lead -> member: start this task, its brief is in git
  'stop', // lead -> member: stop the current (or named) task
  'pull', // lead -> member: new docs are pushed, pull them
  'recheck', // lead -> member: look at this PR again
  'done', // member -> lead: task finished, PR ready, or review posted
  'status', // anyone -> Hub page: progress line, never wakes a session
] as const
export type MessageType = (typeof MESSAGE_TYPES)[number]

/** Which role may send which type. The Hub enforces this, so a member token cannot command anyone. */
const SENDERS: Record<MessageType, readonly Role[]> = {
  question: ['member'],
  done: ['member'],
  answer: ['lead'],
  assign: ['lead'],
  stop: ['lead'],
  pull: ['lead'],
  recheck: ['lead'],
  status: ['lead', 'member'],
}

/** Types the lead may send to every member at once. */
const BROADCASTABLE: ReadonlySet<MessageType> = new Set(['pull', 'status'])

/** `status` goes to the Hub page only. Every other type is pushed into the receiving session. */
export const wakesSession = (type: MessageType): boolean => type !== 'status'

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/** Target alias: the lead of the sender's space. */
export const TO_LEAD = 'lead'
/** Target alias: every member of the space (lead only). */
export const TO_ALL = 'all'

const NAME = /^[a-z][a-z0-9-]{1,30}$/
export const AgentId = z.string().regex(NAME, 'lowercase letters, digits and hyphens, 2-31 characters')
export const SpaceId = z.string().regex(NAME, 'lowercase letters, digits and hyphens, 2-31 characters')
export const isReservedAgentId = (id: string): boolean => id === TO_LEAD || id === TO_ALL

/** Hub-generated, time-sortable. */
export const MessageId = z.string().regex(/^[a-z0-9]{8,26}$/)

/** A work item id as the boards write it: Q-25, RT-41, BA-F1, PY12. */
const RefId = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,11}(-[A-Za-z0-9]{1,12}){0,2}$/, 'a work item id such as Q-25 or RT-41')

export const Refs = z
  .object({
    question: RefId.optional(),
    task: RefId.optional(),
    pr: z.number().int().positive().max(9_999_999).optional(),
    commit: z.string().regex(/^[0-9a-f]{7,40}$/, 'a git commit hash, 7-40 hex characters').optional(),
    /** Workspace path the ids belong to, such as `stays/rates`. */
    area: z.string().max(60).regex(/^[a-z0-9-]+(\/[a-z0-9-]+){0,3}$/).optional(),
  })
  .strict()
export type Refs = z.infer<typeof Refs>

/**
 * One short line. No control characters, so it stays one line, and no angle brackets,
 * so a note cannot close or forge the tag the receiving session sees it in.
 */
export const Note = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\u0000-\u001f\u007f<>]+$/, 'one line, no control characters, no < or >')

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/** What a Link asks the Hub to send. */
export const SendRequest = z
  .object({
    /** An agent id, or `lead`, or `all`. */
    to: AgentId,
    type: z.enum(MESSAGE_TYPES),
    refs: Refs.default({}),
    note: Note.optional(),
    /** The message this one answers. */
    replyTo: MessageId.optional(),
  })
  .strict()
export type SendRequest = z.infer<typeof SendRequest>

/** What the Hub stores and delivers: the request plus who sent it and when. */
export const Envelope = z
  .object({
    v: z.literal(PROTOCOL_VERSION),
    id: MessageId,
    space: SpaceId,
    from: AgentId,
    fromRole: z.enum(ROLES),
    /** Always a real agent id here; the Hub resolves `lead` and `all`. */
    to: AgentId,
    type: z.enum(MESSAGE_TYPES),
    refs: Refs,
    note: Note.optional(),
    replyTo: MessageId.optional(),
    ts: z.string().datetime(),
  })
  .strict()
export type Envelope = z.infer<typeof Envelope>

export type RejectCode = 'invalid' | 'role_not_allowed' | 'bad_target' | 'missing_ref'
export type SendCheck = { ok: true; msg: SendRequest } | { ok: false; code: RejectCode; reason: string }

const reject = (code: RejectCode, reason: string): SendCheck => ({ ok: false, code, reason })

/**
 * The single gate for an outgoing message: shape, then role, then target, then the ids
 * the type needs. The Link runs it before sending and the Hub runs it again on receipt.
 */
export function checkSend(role: Role, input: unknown): SendCheck {
  const parsed = SendRequest.safeParse(input)
  if (!parsed.success) {
    const reason = parsed.error.issues.map((i) => `${i.path.join('.') || 'message'}: ${i.message}`).join('; ')
    return reject('invalid', reason)
  }
  const msg = parsed.data
  const { type, to, refs } = msg

  if (!SENDERS[type].includes(role)) return reject('role_not_allowed', `a ${role} cannot send '${type}'`)

  if (role === 'member') {
    if (to !== TO_LEAD) return reject('bad_target', `a member sends only to '${TO_LEAD}'`)
  } else {
    if (to === TO_LEAD) return reject('bad_target', 'the lead cannot send to itself')
    if (to === TO_ALL && !BROADCASTABLE.has(type)) return reject('bad_target', `'${type}' cannot go to '${TO_ALL}', name one agent`)
  }

  const missing = missingRef(type, refs, msg.note)
  if (missing) return reject('missing_ref', `'${type}' needs ${missing}`)

  return { ok: true, msg }
}

function missingRef(type: MessageType, refs: Refs, note: string | undefined): string | undefined {
  switch (type) {
    case 'question':
      return refs.question ? undefined : 'refs.question'
    case 'answer':
      // The commit is what lets the receiver check the answer really is in git before acting.
      return refs.question && refs.commit ? undefined : 'refs.question and refs.commit'
    case 'assign':
      return refs.task ? undefined : 'refs.task'
    case 'recheck':
      return refs.pr ? undefined : 'refs.pr'
    case 'done':
      return refs.task || refs.pr ? undefined : 'refs.task or refs.pr'
    case 'status':
      return refs.task || note ? undefined : 'refs.task or a note'
    case 'stop':
    case 'pull':
      return undefined
  }
}

// ---------------------------------------------------------------------------
// What the receiving session sees
// ---------------------------------------------------------------------------

/** The one line pushed into the receiving session, such as `question Q-25, task RT-41, area stays/rates`. */
export function renderSignal(env: Pick<Envelope, 'type' | 'refs' | 'note'>): string {
  const { refs } = env
  const parts: string[] = [refs.question ? `${env.type} ${refs.question}` : env.type]
  if (refs.task) parts.push(`task ${refs.task}`)
  if (refs.pr) parts.push(`PR ${refs.pr}`)
  if (refs.commit) parts.push(`commit ${refs.commit}`)
  if (refs.area) parts.push(`area ${refs.area}`)
  if (env.note) parts.push(`note: ${env.note}`)
  return parts.join(', ')
}

/** Attributes for the channel tag. Claude Code drops any key that is not letters, digits and underscores. */
export function signalMeta(env: Pick<Envelope, 'id' | 'from' | 'type'>): Record<string, string> {
  return { msg_id: env.id, sender: env.from, type: env.type }
}

// ---------------------------------------------------------------------------
// WebSocket frames between a Link and the Hub
// ---------------------------------------------------------------------------

export const PRESENCE_STATES = ['idle', 'working'] as const
export type PresenceState = (typeof PRESENCE_STATES)[number]

/** Link -> Hub */
export const ClientFrame = z.discriminatedUnion('op', [
  // The token travels in the first frame, not in the URL, so it never lands in a host's access log.
  // mode 'send': this session cannot show a pushed signal (the VS Code panel), so the Hub lets it send
  // but never delivers to it and does not count it as online.
  z.object({ op: z.literal('hello'), v: z.literal(PROTOCOL_VERSION), token: z.string().min(20).max(200), mode: z.enum(['full', 'send']).default('full') }).strict(),
  // `ref` is the Link's own correlation id for matching the `sent` / `rejected` reply.
  z.object({ op: z.literal('send'), ref: z.string().min(1).max(40), msg: z.unknown() }).strict(),
  z.object({ op: z.literal('ack'), id: MessageId }).strict(),
  z.object({ op: z.literal('presence'), state: z.enum(PRESENCE_STATES), task: RefId.optional() }).strict(),
  z.object({ op: z.literal('ping') }).strict(),
  // Pull instead of push: hand over everything waiting for this agent, and count it as received.
  z.object({ op: z.literal('fetch'), ref: z.string().min(1).max(40) }).strict(),
])
export type ClientFrame = z.infer<typeof ClientFrame>

/** Hub -> Link */
export const HubFrame = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('welcome'),
      v: z.literal(PROTOCOL_VERSION),
      agent: AgentId,
      space: SpaceId,
      role: z.enum(ROLES),
      /** How many stored messages are about to be delivered. */
      pending: z.number().int().nonnegative(),
    })
    .strict(),
  z.object({ op: z.literal('deliver'), msg: Envelope }).strict(),
  z
    .object({
      op: z.literal('sent'),
      ref: z.string(),
      ids: z.array(MessageId),
      /** False when the receiver is offline and the message is stored for later. */
      online: z.boolean(),
    })
    .strict(),
  z.object({ op: z.literal('rejected'), ref: z.string().optional(), code: z.string(), reason: z.string() }).strict(),
  z.object({ op: z.literal('pong') }).strict(),
  z.object({ op: z.literal('inbox'), ref: z.string(), msgs: z.array(Envelope) }).strict(),
])
export type HubFrame = z.infer<typeof HubFrame>

/**
 * Keepalive. The Link sends exactly PING_TEXT and expects exactly PONG_TEXT, so a host that
 * can answer a fixed string without waking the Hub (Cloudflare) may do so.
 */
export const PING_TEXT = '{"op":"ping"}'
export const PONG_TEXT = '{"op":"pong"}'

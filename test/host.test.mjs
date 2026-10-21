// Regression test for the host half's deriveMessages projection.
//
// Drives the REAL host.v8.js (the live entry declared by package.json "main")
// through its HTTP handlers with a fake session, and asserts the derived model
// history. Guards the class of bug that broke a whole session:
// `message.content.some is not a function` — an assistant edit or retraction
// used to replace `content` (a block array) with a bare string.
//
// Run: node test/host.test.mjs   (no dependencies)

import { apply } from '../host.v8.js'

const routes = new Map()
const events = []

function pushEvent(event) {
  event.seq = events.length
  events.push(event)
  return event
}

pushEvent({ type: 'system/message', data: { message: { role: 'system', content: [{ type: 'text', text: 'sys' }] } } })
pushEvent({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hello' }], id: 'u1' } })
pushEvent({
  type: 'assistant/message',
  data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ORIGINAL REPLY' }], id: 'a1' } },
})
pushEvent({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

const session = {
  id: 'sess-1',
  events,
  seq: events.length,
  surface: { nodes: [0, 1, 2], contentGeneration: 1 },
  snapshotEvents() { return events },
  eventAt(seq) { return events[seq] },
  append(type, data) {
    const rec = { type, data }
    rec.seq = events.length
    events.push(rec)
    this.seq = events.length
    return rec
  },
  deriveEventMessage(event) {
    if (event.type === 'user/message') return event.data
    if (event.type === 'assistant/message') return event.data.message
    return null
  },
  deriveMessages() {
    return this.surface.nodes.map((seq) => this.deriveEventMessage(events[seq])).filter(Boolean)
  },
}

const handlers = new Map()
const followups = []
const fakeAgent = {
  id: 'sess-1',
  session,
  status: 'idle',
  followup(message) { followups.push(message) },
  cancel() {},
}
const ctx = {
  get() { return undefined },
  effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
  on(name, handler) { handlers.set(name, handler) },
  webServer: {
    register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) },
  },
  sessions: { get: (id) => (id === 'sess-1' ? session : undefined) },
  agents: { get: (id) => (id === 'sess-1' ? fakeAgent : undefined) },
}

apply(ctx)

function makeReq(method, url, body) {
  const listeners = {}
  const req = {
    method,
    url,
    on(name, cb) { (listeners[name] ??= []).push(cb); return req },
    destroy() {},
  }
  setImmediate(() => {
    if (body !== undefined) {
      const buf = Buffer.from(JSON.stringify(body), 'utf8')
      for (const cb of listeners.data ?? []) cb(buf)
    }
    for (const cb of listeners.end ?? []) cb()
  })
  return req
}

function call(method, path, body, query = '') {
  return new Promise((resolve) => {
    const res = {
      status: 0,
      payload: undefined,
      writeHead(status) { this.status = status },
      end(text) { this.payload = JSON.parse(text); resolve(this) },
    }
    routes.get(path)(makeReq(method, path + query, body), res)
  })
}

function blockText(content) {
  if (typeof content === 'string') throw new Error('REGRESSION: derived content is a bare string')
  return content.filter((c) => c.type === 'text').map((c) => c.text).join('')
}

let failed = 0
function check(label, ok) {
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}`)
}

console.log('host deriveMessages projection — regression against host.v8.js\n')

// /state must install the projection after a restart, before any edit exists.
const state1 = await call('GET', '/api/time-weaver/state', undefined, '?sessionId=sess-1')
check('/state answers and installs the projection', state1.status === 200 && state1.payload.ok === true)
check('baseline history intact', blockText(session.deriveMessages().at(-1).content) === 'ORIGINAL REPLY')

const editRes = await call('POST', '/api/time-weaver/edit', { sessionId: 'sess-1', seq: 2, content: 'EDITED REPLY' })
check('edit accepted', editRes.status === 200 && editRes.payload.ok === true)

let derived
let error = null
try { derived = session.deriveMessages() } catch (e) { error = e }
check('no crash while deriving after an edit', error === null)
if (derived !== undefined) {
  const last = derived.at(-1)
  check('edited text reaches model history', blockText(last.content) === 'EDITED REPLY')
  check('content stays a block array', Array.isArray(last.content) && typeof last.content[0] === 'object')
}

await call('POST', '/api/time-weaver/edit', { sessionId: 'sess-1', seq: 2, content: 'EDITED AGAIN' })
check('second edit to the same seq invalidates the cache', blockText(session.deriveMessages().at(-1).content) === 'EDITED AGAIN')

const state2 = await call('GET', '/api/time-weaver/state', undefined, '?sessionId=sess-1')
const entry = state2.payload.edits.find((e) => e.seq === 2)
check('/state exposes the pristine originalText', entry?.originalText === 'ORIGINAL REPLY')
check('/state exposes the effective content', entry?.content === 'EDITED AGAIN')

await call('POST', '/api/time-weaver/retract', { sessionId: 'sess-1', seq: 2, placeholder: '[已撤回]' })
check('retraction keeps a block array', blockText(session.deriveMessages().at(-1).content) === '[已撤回]')

const regenRes = await call('POST', '/api/time-weaver/regenerate', { sessionId: 'sess-1', seq: 2 })
check('regenerate drops the reply from context', session.deriveMessages().every((m) => m.role !== 'assistant'))
check('regenerate answers with a started turn', regenRes.payload.ok === true && regenRes.payload.started === true)
check('regenerate wakes the agent exactly once', followups.length === 1)
check('the wake message is a user-role notice', followups[0]?.role === 'user' && followups[0]?.source?.form === 'notice')
check('the wake message carries an id', typeof followups[0]?.id === 'string' && followups[0].id.length > 0)
check('regenerate reports the pristine text', regenRes.payload.originalText === 'ORIGINAL REPLY')
check('regenerate reports the turn', regenRes.payload.turn === 1)

const stateRegen = await call('GET', '/api/time-weaver/state', undefined, '?sessionId=sess-1')
const regenEntry = (stateRegen.payload.regenerates ?? []).find((r) => r && r.seq === 2)
check('/state exposes the regenerate turn anchor', regenEntry?.turn === 1)
check('/state exposes the regenerate pristine text', regenEntry?.originalText === 'ORIGINAL REPLY')

// ---------------------------------------------------------- rewind commit --
// A rewind is marked on the user prompt; the next turn commits a hidden range.
// The range must stop at the tail captured at mark time — the freshly appended
// prompt (and the reply it produces) stay visible.
console.log('\nrewind commit range')
const markRes = await call('POST', '/api/time-weaver/mark', { sessionId: 'sess-1', seq: 1 })
check('re-mark accepted', markRes.status === 200 && markRes.payload.ok === true)
const tailAtIndex = markRes.payload.markSeq - 1
pushEvent({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'fresh prompt' }], id: 'u2' } })
const freshSeq = session.seq - 1
const preStep = handlers.get('agent/pre-step')
check('pre-step handler registered', typeof preStep === 'function')
await preStep({ agent: { id: 'sess-1', session }, messages: [{ role: 'user' }] }, () => ({ kind: 'continue', messages: [] }))
const state3 = await call('GET', '/api/time-weaver/state', undefined, '?sessionId=sess-1')
const range = state3.payload.ranges.at(-1)
check('committed range ends at the mark-time tail', range?.end === tailAtIndex)
check('the fresh prompt is outside the hidden range', freshSeq > (range?.end ?? -1))
check('committed range starts at the rewound prompt', range?.start === 1)

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)

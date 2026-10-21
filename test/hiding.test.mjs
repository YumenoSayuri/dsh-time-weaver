// Regression test for the live row-hiding driver in client.js.
//
// Loads the ACTUAL client.js that the profile serves (package.json
// exports["./client"]), extracts the DOM-native driver region, and exercises it
// against a minimal DOM shim. The historical version of this test pointed at
// lib/client.js 鈥?a dead copy that is never loaded 鈥?so it could pass while the
// shipped driver stayed broken.
//
// Run: node test/hiding.test.mjs   (no dependencies)

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC = join(HERE, '..', 'client.js')
const src = readFileSync(SRC, 'utf8')

const regionStart = src.indexOf('// ------------------------------------------------ DOM Hiding Driver --')
const regionEnd = src.indexOf('function fmtClock(time) {')
if (regionStart < 0 || regionEnd < 0) {
  console.error('FAIL: could not locate the driver region in client.js')
  process.exit(1)
}
const region = src.slice(regionStart, regionEnd)

// ------------------------------------------------------------------- dom ---
function makeEl(attrs) {
  const m = new Map(Object.entries(attrs).map(([k, v]) => [k, String(v)]))
  const el = {
    _text: attrs.__text ?? '',
    children: [],
    nodeType: 1,
    style: {},
    getAttribute: (k) => (m.has(k) ? m.get(k) : null),
    setAttribute: (k, v) => m.set(k, String(v)),
    removeAttribute: (k) => m.delete(k),
    hasAttribute: (k) => m.has(k),
  }
  Object.defineProperty(el, 'textContent', {
    get() {
      if (el.children.length === 0) return el._text
      return el.children.map((c) => c.textContent).join('')
    },
    set(v) {
      el.children.length = 0
      el._text = String(v)
    },
  })
  return el
}

// A rendered reply: the flow row wraps a markdown container holding the text.
function replyRow(attrs, text) {
  const row = makeEl({ 'data-chat-flow-key': attrs.__key ?? 'a', ...attrs })
  const body = makeEl({ __text: text })
  row.children.push(body)
  row._body = body
  return row
}

const USER = (seq, key) => makeEl({ 'data-chat-flow-key': key, 'data-chat-flow-kind': 'user', 'data-xsj-seq': String(seq) })
const ASST = (key) => makeEl({ 'data-chat-flow-key': key, 'data-chat-flow-kind': 'assistant-step' })
// An assistant row carrying the stamped seq (what the shadow view supplies).
const ASST_SEQ = (seq, key) => makeEl({ 'data-chat-flow-key': key, 'data-chat-flow-kind': 'assistant-step', 'data-xsj-seq': String(seq) })
const TOOL = (key) => makeEl({ 'data-chat-flow-key': key, 'data-chat-flow-kind': 'tool-call' })

let flow = []
const doc = {
  querySelectorAll: (sel) => {
    if (sel === '[data-chat-flow-key]') return flow.filter((r) => r.hasAttribute('data-chat-flow-key'))
    if (sel === '[data-xsj-seq]') return flow.filter((r) => r.hasAttribute('data-xsj-seq'))
    if (sel.indexOf('data-chat-flow-kind') !== -1 || sel.indexOf('data-turn-process-answer') !== -1) {
      return flow.filter((r) => ['assistant-step', 'turn-process'].includes(r.getAttribute('data-chat-flow-kind')) || r.hasAttribute('data-turn-process-answer'))
    }
    if (sel.indexOf(',') !== -1) return flow.filter((r) => r.hasAttribute('data-chat-flow-key') || r.hasAttribute('data-xsj-seq'))
    return []
  },
}

const states = new Map()
const shim = { window: { dispatchEvent() {} } }

const factory = new Function('document', 'store', 'window', 'post', `
${region}
return { rwApply, rwRestoreAll, twApplyTexts };
`)
const D = factory(doc, states, shim.window, () => Promise.resolve(null))

// ------------------------------------------------------------------ cases --
// Rows: u0 a1 u2 a3 t3 u4 a5 鈥?only user rows carry a seq stamp.
function scene() {
  flow = [USER(0, 'u0'), ASST('a1'), USER(2, 'u2'), ASST('a3'), TOOL('t3'), USER(4, 'u4'), ASST('a5')]
}
const shown = () => flow.map((r) => (r.style.display === 'none' ? 'H' : '.')).join('')

let failed = 0
function check(label, got, want) {
  const ok = got === want
  if (!ok) failed++
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(52)} ${got.padEnd(9)} (want ${want})`)
}

const setState = (sid, patch) => states.set(sid, { pending: null, ranges: [], edits: new Map(), retractions: new Map(), regenerates: new Set(), sourceTexts: new Map(), ...patch })

console.log('rewind row hiding - regression against client.js\n')

console.log('committed hidden range')
scene(); setState('s', { ranges: [{ start: 2, end: 5 }] })
D.rwApply('s')
check('answer rows follow their prompt', shown(), '..HHHHH')

console.log('\npending rewind (before send)')
scene(); setState('s', { pending: { targetSeq: 2, markSeq: 100 } })
D.rwApply('s')
check('tail hidden while the mark is pending', shown(), '..HHHHH')

console.log('\ncancel / idle')
scene(); setState('s')
D.rwApply('s')
check('everything visible', shown(), '.......')

console.log('\nprevious row state must not leak into the next row')
// Range [2,3] hides u2 and the assistant row after it. u4/a5 come after the
// range and previously inherited the previous row's hidden verdict.
scene(); setState('s', { ranges: [{ start: 2, end: 3 }] })
D.rwApply('s')
check('rows after the range stay visible', shown(), '..HHH..')

console.log('\ndisjoint ranges')
scene(); setState('s', { ranges: [{ start: 0, end: 1 }, { start: 4, end: 5 }] })
D.rwApply('s')
check('two ranges', shown(), 'HH...HH')

console.log('\nregenerate stays an exact-seq match')
scene(); flow = [USER(0, 'u0'), ASST_SEQ(1, 'a1'), USER(2, 'u2')]
setState('s', { regenerates: new Set([1]) })
D.rwApply('s')
check('only the marked reply hides', shown(), '.H.')

console.log('\ncold load before /state answers')
scene(); states.delete('s')
D.rwApply('s')
check('nothing asserted (no flash)', shown(), '.......')

console.log('teardown')
scene(); setState('s', { ranges: [{ start: 2, end: 5 }] })
D.rwApply('s')
D.rwRestoreAll()
check('restore releases hidden rows', shown(), '.......')

console.log('\nedited reply text (short single-character reply)')
flow = [USER(0, 'u0'), replyRow({ 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '1' }, '1')]
setState('s', { edits: new Map([[1, '2']]), sourceTexts: new Map([[1, '1']]) })
D.twApplyTexts('s')
check('"1" is rewritten to "2"', flow[1].textContent, '2')

console.log('\nedited reply text after a reload (no stamp, unique text)')
flow = [USER(0, 'u0'), replyRow({ 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '1' }, 'original answer')]
setState('s', { edits: new Map([[1, 'rewritten answer']]), sourceTexts: new Map([[1, 'original answer']]) })
D.twApplyTexts('s')
check('unique original text is located', flow[1].textContent, 'rewritten answer')

console.log('\nambiguous short text must not be guessed')
flow = [
  USER(0, 'u0'),
  replyRow({ 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '1' }, '1'),
  replyRow({ 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '2' }, '1'),
]
setState('s', { edits: new Map([[9, '2']]), sourceTexts: new Map([[9, '1']]) })
D.twApplyTexts('s')
check('two identical candidates stay untouched', flow[1].textContent + flow[2].textContent, '11')

console.log('\nturn scope disambiguates the same text')
setState('s', { edits: new Map([[9, '2']]), sourceTexts: new Map([[9, '1']]), turnBySeq: new Map([[9, 2]]) })
D.twApplyTexts('s')
check('only the turn-scoped row changes', flow[1].textContent + flow[2].textContent, '12')

console.log('\nreply text folded into a turn-process row')
flow = [USER(0, 'u0'), replyRow({ 'data-chat-flow-kind': 'turn-process', 'data-chat-turn': '3', 'data-turn-process-answer': '' }, 'folded answer')]
setState('s', { edits: new Map([[21, 'rewritten folded answer']]), sourceTexts: new Map([[21, 'folded answer']]), turnBySeq: new Map([[21, 3]]) })
D.twApplyTexts('s')
check('grouped reply is still rewritten', flow[1].textContent, 'rewritten folded answer')

console.log('\nretracted reply leaves the transcript')
flow = [USER(0, 'u0'), replyRow({ 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '1', __key: 'r1' }, 'long reply text')]
setState('s', { retractions: new Map([[1, '.']]), edits: new Map(), sourceTexts: new Map([[1, 'long reply text']]) })
D.rwApply('s')
check('retracted row is hidden, not rewritten', shown(), '.H')
check('the reply text is untouched on screen', flow[1].textContent, 'long reply text')

console.log('\nre-applying is idempotent')
D.rwApply('s')
check('no drift on the second pass', shown(), '.H')

console.log('\nedited multi-line text keeps its line breaks')
flow = [USER(0, 'u0'), replyRow({ 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '2', __key: 'r2' }, 'first paragraph')]
setState('s', { edits: new Map([[2, 'first paragraph\n\nsecond paragraph']]), sourceTexts: new Map([[2, 'first paragraph']]), turnBySeq: new Map([[2, 2]]) })
D.rwApply('s')
check('newlines survive as pre-wrap', flow[1]._body.style.whiteSpace, 'pre-wrap')
check('edited text applied', flow[1].textContent, 'first paragraph\n\nsecond paragraph')

console.log('\nregenerated reply is hidden once located by its text')
flow = [USER(0, 'u0'), replyRow({ 'data-chat-flow-kind': 'assistant-step', 'data-chat-turn': '4', __key: 'r4' }, 'the reply being redone')]
setState('s', { regenerates: new Set([7]), sourceTexts: new Map([[7, 'the reply being redone']]), turnBySeq: new Map([[7, 4]]) })
D.rwApply('s')
check('the regenerated row leaves the transcript', shown(), '.H')
check('the row is anchored to its seq', flow[1].getAttribute('data-tw-seq'), '7')

console.log('\nregenerated reply with no usable text still resolves by turn')
// The stored original text never matches what the row actually renders
// (reasoning/tool chrome included) — the turn anchor must carry it alone.
flow = [USER(0, 'u0'), replyRow({ 'data-chat-flow-kind': 'turn-process', 'data-chat-turn': '5', __key: 'r5' }, 'rendered answer with extras')]
setState('s', { regenerates: new Set([12]), sourceTexts: new Map([[12, 'a completely different stored text']]), turnBySeq: new Map([[12, 5]]) })
D.rwApply('s')
check('turn anchor alone hides the row', shown(), '.H')
check('no text was rewritten', flow[1].textContent, 'rendered answer with extras')

console.log('\nrepeated passes stay stable (no flicker)')
D.rwApply('s'); D.rwApply('s')
check('still hidden on later passes', shown(), '.H')

console.log(failed === 0 ? '\nall checks passed' : `\n${failed} check(s) FAILED`)
process.exit(failed === 0 ? 0 : 1)

// @local/dsh-time-weaver — host half (Time Weaver 1.0.8)
//
// NOTE: this file is the live host entry (package.json "main" + cordis.patch.yml).
//
// 1. User message rewind & draft recovery (with image re-attachment)
// 2. Assistant message in-place edit with durable persistence (hook/invoked)
// 3. Assistant message retraction / delete with customizable placeholder (. / [已撤回] / etc.)
// 4. Tool-preserving Assistant regeneration (spatiotemporal rewind to tool boundary)
// 5. Global & session-level configuration persistence

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'time-weaver'
export const inject = ['webServer', 'sessions', 'agents']

const SOURCE = 'nova.timeweaver'
const LEGACY_SOURCE = 'xsj.rewind'
const API = '/api/time-weaver'
const MAX_BODY_BYTES = 64 * 1024
const MAX_ATTACHMENT_ID = 256
const MAX_IMAGE_BYTES = 64 * 1024 * 1024
const MAX_CACHED_IMAGE_REFS = 64

const CONFIG_PATH = join(homedir(), '.dsh', 'time-weaver.config.json')
const DIAG_PATH = join(homedir(), '.dsh', 'time-weaver-diag.log')
const MAX_DIAG_BYTES = 512 * 1024

function loadGlobalConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
    }
  } catch {}
  return { placeholder: '.' }
}

function saveGlobalConfig(cfg) {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8')
  } catch (e) {
    console.error('[time-weaver] failed to save config:', e)
  }
}

let globalConfig = loadGlobalConfig()

// Append-only diagnostic channel shared by both halves (size-capped).
function diagLine(payload) {
  try {
    let size = 0
    try { size = statSync(DIAG_PATH).size } catch {}
    if (size > MAX_DIAG_BYTES) writeFileSync(DIAG_PATH, '', 'utf8')
    appendFileSync(DIAG_PATH, JSON.stringify({ at: new Date().toISOString(), ...payload }) + '\n', 'utf8')
  } catch {}
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        req.destroy()
        resolve(undefined)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(undefined)
      }
    })
    req.on('error', () => resolve(undefined))
  })
}

function writeJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(data))
}

function eventsOf(session) {
  return typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
}

function eventAt(session, seq) {
  return typeof session.eventAt === 'function' ? session.eventAt(seq) : eventsOf(session)?.[seq]
}

function resolveSeq(session, body) {
  if (typeof body?.seq === 'number' && Number.isSafeInteger(body.seq) && body.seq >= 0) {
    return body.seq
  }
  const mid = body?.messageId
  if (typeof mid === 'string' && mid.length > 0) {
    const events = eventsOf(session) ?? []
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]
      if (ev.data?.id === mid || ev.data?.message?.id === mid || ev.data?.finalNode?.messageId === mid) {
        return ev.seq
      }
    }
  }
  return undefined
}

function turnOfSeq(session, seq) {
  const turn = eventAt(session, seq)?.data?.turn
  return typeof turn === 'number' ? turn : undefined
}

function assistantTextFromEvent(event) {
  const data = event?.data
  if (!data) return ''
  if (typeof data.content === 'string') return data.content
  if (Array.isArray(data.content)) {
    return data.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('')
  }
  if (Array.isArray(data.blocks)) {
    return data.blocks.filter((b) => b && typeof b.text === 'string').map((b) => b.text).join('')
  }
  if (typeof data.message?.content === 'string') return data.message.content
  if (Array.isArray(data.message?.content)) {
    return data.message.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('')
  }
  return ''
}

function imageRefInContent(content, attachmentId) {
  if (!Array.isArray(content)) return undefined
  for (const value of content) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    if (value.type === 'image' && typeof value.attachment === 'object' && value.attachment !== null && String(value.attachment.attachmentId) === attachmentId) {
      return value.attachment
    }
    if (value.type === 'tool-result') {
      const nested = imageRefInContent(value.content, attachmentId)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

function imageRefInEvent(event, attachmentId) {
  const data = event?.data
  if (data === null || typeof data !== 'object') return undefined
  const direct = imageRefInContent(data.content, attachmentId)
  if (direct !== undefined) return direct
  const message = imageRefInContent(data.message?.content, attachmentId)
  if (message !== undefined) return message
  for (const inserted of data.inserted ?? []) {
    const found = imageRefInContent(inserted.content, attachmentId)
    if (found !== undefined) return found
  }
  return undefined
}

const imageRefCache = new WeakMap()

function findReferencedImage(session, attachmentId) {
  let perSession = imageRefCache.get(session)
  if (perSession === undefined) {
    perSession = new Map()
    imageRefCache.set(session, perSession)
  }
  if (perSession.has(attachmentId)) return perSession.get(attachmentId)
  const events = eventsOf(session) ?? []
  let found
  for (const event of events) {
    found = imageRefInEvent(event, attachmentId)
    if (found !== undefined) break
  }
  if (found !== undefined) {
    if (perSession.size >= MAX_CACHED_IMAGE_REFS) perSession.clear()
    perSession.set(attachmentId, found)
  }
  return found
}

export function apply(ctx) {
  const { sessions, agents, webServer } = ctx
  const MAX_TRACKED_SESSIONS = 64
  const states = new Map()

  const attachmentsOf = () => ctx.get('attachments')

  function evictIfNeeded(protectedSid) {
    if (states.size <= MAX_TRACKED_SESSIONS) return
    for (const sid of Array.from(states.keys())) {
      if (states.size <= MAX_TRACKED_SESSIONS) return
      if (sid === protectedSid) continue
      const st = states.get(sid)
      if (st !== undefined && !st.patched) states.delete(sid)
    }
  }

  function stateFor(sid) {
    let st = states.get(sid)
    if (st === undefined) {
      st = {
        pending: null,
        ranges: [],
        edits: new Map(), // seq -> newText
        retractions: new Map(), // seq -> placeholderText
        regenerates: new Set(), // seq to omit from deriveMessages
        patched: false,
        scannedSeq: 0,
        rev: 0
      }
      states.set(sid, st)
      evictIfNeeded(sid)
    }
    return st
  }

  function ensurePatched(session, st) {
    if (st.patched && session.deriveMessages === st.patch) return
    const original = session.deriveMessages
    if (typeof original !== 'function') return
    const ranges = st.ranges
    const edits = st.edits
    const retractions = st.retractions
    const regenerates = st.regenerates
    let cacheSig = ''
    let cacheOut = []

    const wrapper = function deriveMessagesWithTimeWeaver() {
      const nodes = this.surface.nodes
      const generation = this.surface.contentGeneration ?? this.surface.replaceGeneration ?? 0
      const sig = `${nodes.length}:${generation}:${st.rev}`
      if (sig === cacheSig) return cacheOut.slice()

      const events = eventsOf(this)
      const out = []

      for (const seq of nodes) {
        if (ranges.some((r) => seq >= r.start && seq <= r.end)) continue
        const event = events[seq]
        if (!event) continue

        // If marked for regenerate, omit this assistant reply so the context ends at tool results!
        if (regenerates.has(seq)) {
          continue
        }

        const message = this.deriveEventMessage(event)
        if (message != null) {
          if (message.role === 'assistant') {
            if (retractions.has(seq)) {
              const ph = retractions.get(seq) || globalConfig.placeholder || '.'
              out.push({ ...message, content: [{ type: 'text', text: ph }] })
              continue
            }
            if (edits.has(seq)) {
              out.push({ ...message, content: [{ type: 'text', text: edits.get(seq) }] })
              continue
            }
          }
          out.push(message)
        }
      }

      cacheSig = sig
      cacheOut = out
      return out.slice()
    }

    Object.defineProperty(session, 'deriveMessages', {
      configurable: true,
      writable: true,
      value: wrapper,
    })
    st.patch = wrapper
    st.patched = true
  }

  function rebuild(session, st) {
    const events = eventsOf(session) ?? []
    if (events.length !== st.scannedSeq) st.rev += 1
    for (let i = st.scannedSeq; i < events.length; i++) {
      const event = events[i]
      if (event.type !== 'hook/invoked') continue
      const d = event.data
      if (d === null || typeof d !== 'object') continue
      if (d.source !== SOURCE && d.source !== LEGACY_SOURCE) continue

      if (d.phase === 'mark' && typeof d.targetSeq === 'number') {
        // tailSeq is the last event that existed when the rewind was requested.
        // The committed range must stop there: by commit time the new prompt is
        // already in the log, and hiding up to the live tail would swallow it
        // together with the reply it produces.
        st.pending = {
          targetSeq: d.targetSeq,
          markSeq: event.seq,
          tailSeq: typeof d.tailSeq === 'number' ? d.tailSeq : undefined,
        }
      } else if (d.phase === 'cancel') {
        st.pending = null
      } else if (d.phase === 'commit' && typeof d.hiddenFrom === 'number' && typeof d.hiddenTo === 'number') {
        st.ranges.push({ start: d.hiddenFrom, end: d.hiddenTo })
        st.pending = null
      } else if (d.phase === 'edit' && typeof d.seq === 'number' && typeof d.content === 'string') {
        st.edits.set(d.seq, d.content)
      } else if (d.phase === 'retract' && typeof d.seq === 'number') {
        st.retractions.set(d.seq, d.placeholder || globalConfig.placeholder || '.')
      } else if (d.phase === 'regenerate' && typeof d.seq === 'number') {
        st.regenerates.add(d.seq)
      }
    }
    st.scannedSeq = events.length
    if (st.pending !== null) {
      const liveFrom = typeof session.firstLiveSeq === 'number' ? session.firstLiveSeq : events.length
      if (st.pending.markSeq < liveFrom) st.pending = null
    }
  }

  function resolveSession(sid) {
    if (typeof sid !== 'string' || sid.length === 0) return undefined
    return sessions.get(sid)
  }

  // ----------------------------------------------------------- API Handlers --
  async function onMark(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body?.sessionId)
    if (session === undefined) {
      diagLine({ v: 'mark-reject', reason: 'unknown-session', sid: body?.sessionId ?? null, seq: body?.seq ?? null })
      return writeJson(res, 404, { ok: false, error: 'unknown session' })
    }
    const seq = resolveSeq(session, body)
    if (seq === undefined) {
      diagLine({ v: 'mark-reject', reason: 'bad-seq', sid: session.id, seq: body?.seq ?? null, messageId: body?.messageId ?? null })
      return writeJson(res, 400, { ok: false, error: 'bad seq' })
    }
    const target = eventAt(session, seq)
    if (target === undefined || target.type !== 'user/message') {
      diagLine({ v: 'mark-reject', reason: 'not-user-message', sid: session.id, seq, type: target?.type ?? null })
      return writeJson(res, 400, { ok: false, error: 'target is not a user message' })
    }
    const st = stateFor(String(session.id))
    rebuild(session, st)
    if (st.ranges.some((r) => seq >= r.start && seq <= r.end)) {
      diagLine({ v: 'mark-reject', reason: 'inside-hidden-range', sid: session.id, seq, ranges: st.ranges })
      return writeJson(res, 409, { ok: false, error: 'target is inside a committed hidden range' })
    }
    ensurePatched(session, st)
    const preview = typeof body?.preview === 'string' ? body.preview.slice(0, 120) : ''
    const tailSeq = session.seq - 1
    const record = session.append('hook/invoked', { source: SOURCE, phase: 'mark', targetSeq: seq, tailSeq, preview })
    st.pending = { targetSeq: seq, markSeq: record.seq, tailSeq }
    st.scannedSeq = session.seq
    st.rev += 1
    diagLine({ v: 'mark-ok', sid: session.id, seq, tailSeq, markSeq: record.seq })
    try {
      const agent = agents.get(session.id)
      if (agent !== undefined && agent.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
    } catch (error) {
      console.error('[time-weaver] interrupt failed:', error)
    }
    writeJson(res, 200, { ok: true, targetSeq: seq, markSeq: record.seq })
  }

  async function onCancel(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body?.sessionId)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const st = stateFor(String(session.id))
    rebuild(session, st)
    if (st.pending !== null) {
      const targetSeq = st.pending.targetSeq
      st.pending = null
      session.append('hook/invoked', { source: SOURCE, phase: 'cancel', targetSeq })
      st.scannedSeq = session.seq
    st.rev += 1
    }
    writeJson(res, 200, { ok: true })
  }

  async function onEditAssistant(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body?.sessionId)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const seq = resolveSeq(session, body)
    const content = typeof body?.content === 'string' ? body.content : undefined
    if (seq === undefined || content === undefined) {
      return writeJson(res, 400, { ok: false, error: 'bad seq or content' })
    }
    const st = stateFor(String(session.id))
    rebuild(session, st)
    ensurePatched(session, st)
    st.edits.set(seq, content)
    st.retractions.delete(seq)
    session.append('hook/invoked', { source: SOURCE, phase: 'edit', seq, content })
    st.scannedSeq = session.seq
    st.rev += 1
    writeJson(res, 200, { ok: true, seq, content })
  }

  async function onRetract(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body?.sessionId)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const seq = resolveSeq(session, body)
    if (seq === undefined) return writeJson(res, 400, { ok: false, error: 'bad seq' })
    const ph = typeof body?.placeholder === 'string' ? body.placeholder : (globalConfig.placeholder || '.')
    const st = stateFor(String(session.id))
    rebuild(session, st)
    ensurePatched(session, st)
    st.retractions.set(seq, ph)
    session.append('hook/invoked', { source: SOURCE, phase: 'retract', seq, placeholder: ph })
    st.scannedSeq = session.seq
    st.rev += 1
    writeJson(res, 200, {
      ok: true,
      seq,
      placeholder: ph,
      originalText: assistantTextFromEvent(eventAt(session, seq)),
    })
  }

  async function onRegenerate(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    const session = resolveSession(body?.sessionId)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const seq = resolveSeq(session, body)
    if (seq === undefined) return writeJson(res, 400, { ok: false, error: 'bad seq' })
    const st = stateFor(String(session.id))
    rebuild(session, st)
    ensurePatched(session, st)
    st.regenerates.add(seq)
    session.append('hook/invoked', { source: SOURCE, phase: 'regenerate', seq })
    st.scannedSeq = session.seq
    st.rev += 1

    let started = false
    let failure
    try {
      const agent = agents.get(session.id)
      if (agent === undefined) {
        failure = 'agent-unavailable'
      } else {
        if (agent.status === 'running') agent.cancel({ kind: 'user' }, { keepInbox: true })
        // Wake a fresh turn with no user typing. The trigger carries a notice
        // source, so DSH folds it into one collapsed line instead of rendering a
        // user bubble; the omitted reply is already gone from model history.
        agent.followup({
          id: `tw-regen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          role: 'user',
          content: [{ type: 'text', text: '（重新生成上一条回复）' }],
          source: { kind: 'time-weaver', form: 'notice', summary: '重新生成上一条回复' },
        })
        started = true
      }
    } catch (error) {
      failure = String(error?.message || error).slice(0, 120)
      console.error('[time-weaver] regenerate wake failed:', error)
    }

    diagLine({ v: 'regenerate', sid: session.id, seq, started, failure: failure ?? null })
    writeJson(res, started ? 200 : 500, {
      ok: started,
      seq,
      started,
      error: failure,
      originalText: assistantTextFromEvent(eventAt(session, seq)),
      turn: turnOfSeq(session, seq),
    })
  }

  async function onGetMessage(req, res) {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'GET only' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const session = resolveSession(url.searchParams.get('sessionId') ?? undefined)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const mid = url.searchParams.get('messageId')
    const seqStr = url.searchParams.get('seq')
    let targetSeq = seqStr ? parseInt(seqStr, 10) : undefined
    if (targetSeq === undefined && mid) {
      targetSeq = resolveSeq(session, { messageId: mid })
    }
    if (targetSeq === undefined) return writeJson(res, 400, { ok: false, error: 'message not found' })
    const st = stateFor(String(session.id))
    rebuild(session, st)
    const ev = eventAt(session, targetSeq)
    const text = st.edits.get(targetSeq) || assistantTextFromEvent(ev)
    writeJson(res, 200, {
      ok: true,
      seq: targetSeq,
      text,
      isRetracted: st.retractions.has(targetSeq),
      isEdited: st.edits.has(targetSeq),
    })
  }

  function onState(req, res) {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'GET only' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const session = resolveSession(url.searchParams.get('sessionId') ?? undefined)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const st = stateFor(String(session.id))
    rebuild(session, st)
    ensurePatched(session, st)
    writeJson(res, 200, {
      ok: true,
      pending: st.pending === null ? null : { targetSeq: st.pending.targetSeq, markSeq: st.pending.markSeq },
      ranges: st.ranges.map((r) => ({ start: r.start, end: r.end })),
      edits: Array.from(st.edits.entries()).map(([seq, content]) => ({
        seq,
        content,
        originalText: assistantTextFromEvent(eventAt(session, seq)),
        turn: turnOfSeq(session, seq),
      })),
      retractions: Array.from(st.retractions.entries()).map(([seq, placeholder]) => ({
        seq,
        placeholder,
        originalText: assistantTextFromEvent(eventAt(session, seq)),
        turn: turnOfSeq(session, seq),
      })),
      regenerates: Array.from(st.regenerates).map((seq) => ({
        seq,
        turn: turnOfSeq(session, seq),
        originalText: assistantTextFromEvent(eventAt(session, seq)),
      })),
      config: globalConfig,
    })
  }

  // Client-side diagnostics land here so the rendered DOM can be inspected
  // without a devtools session. Append-only, size-capped.
  async function onDiag(req, res) {
    if (req.method !== 'POST') return writeJson(res, 405, { ok: false, error: 'POST only' })
    const body = await readJsonBody(req)
    if (body === undefined) return writeJson(res, 400, { ok: false, error: 'bad body' })
    diagLine(body)
    writeJson(res, 200, { ok: true })
  }

  async function onConfig(req, res) {
    if (req.method === 'GET') {
      return writeJson(res, 200, { ok: true, config: globalConfig })
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req)
      if (body && typeof body === 'object') {
        globalConfig = { ...globalConfig, ...body }
        saveGlobalConfig(globalConfig)
        return writeJson(res, 200, { ok: true, config: globalConfig })
      }
      return writeJson(res, 400, { ok: false, error: 'bad config body' })
    }
    return writeJson(res, 405, { ok: false, error: 'GET or POST only' })
  }

  async function onImage(req, res) {
    if (req.method !== 'GET') return writeJson(res, 405, { ok: false, error: 'GET only' })
    const url = new URL(req.url ?? '/', 'http://localhost')
    const session = resolveSession(url.searchParams.get('sessionId') ?? undefined)
    if (session === undefined) return writeJson(res, 404, { ok: false, error: 'unknown session' })
    const attachmentId = url.searchParams.get('attachmentId')
    if (attachmentId === null || attachmentId.length === 0 || attachmentId.length > MAX_ATTACHMENT_ID) {
      return writeJson(res, 400, { ok: false, error: 'bad attachmentId' })
    }
    const ref = findReferencedImage(session, attachmentId)
    if (ref === undefined) return writeJson(res, 404, { ok: false, error: 'image not referenced' })
    const attachments = attachmentsOf()
    if (attachments === undefined || typeof attachments.readImage !== 'function') {
      return writeJson(res, 501, { ok: false, error: 'provider unavailable' })
    }
    try {
      const { ref: stored, data } = await attachments.readImage(ref)
      if (data.byteLength > MAX_IMAGE_BYTES) return writeJson(res, 413, { ok: false, error: 'too large' })
      return writeJson(res, 200, {
        ok: true,
        mediaType: stored.mediaType,
        name: typeof stored.name === 'string' ? stored.name.slice(0, 200) : undefined,
        data: Buffer.from(data).toString('base64'),
      })
    } catch (error) {
      return writeJson(res, 500, { ok: false, error: 'read failed' })
    }
  }

  const withErrLog = (fn) => async (req, res) => {
    try {
      await fn(req, res)
    } catch (error) {
      console.error('[time-weaver]', error?.stack || String(error))
      try { writeJson(res, 500, { ok: false, error: String(error?.message || error).slice(0, 120) }) } catch {}
    }
  }

  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/mark', handler: withErrLog(onMark) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/cancel', handler: withErrLog(onCancel) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/edit', handler: withErrLog(onEditAssistant) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/retract', handler: withErrLog(onRetract) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/regenerate', handler: withErrLog(onRegenerate) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/message', handler: withErrLog(onGetMessage) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/state', handler: withErrLog(onState) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/config', handler: withErrLog(onConfig) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/diag', handler: withErrLog(onDiag) }))
  ctx.effect(() => webServer.register({ kind: 'exact', path: API + '/image', handler: withErrLog(onImage) }))

  ctx.on('agent/pre-step', (payload, next) => {
    try {
      const agent = payload?.agent
      const st = agent?.id !== undefined ? states.get(String(agent.id)) : undefined
      if (st !== undefined && st.pending !== null && Array.isArray(payload.messages) && payload.messages.length > 0) {
        const session = agent.session
        const start = st.pending.targetSeq
        // Stop at the tail captured at mark time: the new prompt is already
        // appended here, and covering it would hide the user's own message and
        // the reply it is about to produce.
        const end = typeof st.pending.tailSeq === 'number' ? st.pending.tailSeq : session.seq - 1
        if (end >= start) st.ranges.push({ start, end })
        st.pending = null
        ensurePatched(session, st)
        session.append('hook/invoked', {
          source: SOURCE, phase: 'commit', targetSeq: start, hiddenFrom: start, hiddenTo: end,
        })
        st.scannedSeq = session.seq
    st.rev += 1
      }
    } catch (error) {
      console.error('[time-weaver] commit failed:', error)
    }
    return next()
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      const agent = payload?.agent
      if (agent?.id === undefined) return
      const sid = String(agent.id)
      const st = states.get(sid)
      if (st !== undefined && st.patched) {
        const session = sessions.get(sid) ?? agent.session
        if (session !== undefined) {
          try { delete session.deriveMessages } catch {}
        }
      }
      states.delete(sid)
    } catch {}
  })

  ctx.effect(() => () => {
    for (const [sid, st] of states) {
      if (!st.patched) continue
      const session = sessions.get(sid)
      if (session !== undefined) {
        try { delete session.deriveMessages } catch {}
      }
    }
    states.clear()
  })
}

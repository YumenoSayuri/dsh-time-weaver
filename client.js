// @local/dsh-time-weaver — client half (Time Weaver 1.0.8)
//
// NOTE: this file is the live client entry (package.json exports["./client"]).
//
// Complete session flow control:
// 1. User message rewind & draft recovery (with image re-attachment)
// 2. Assistant message in-place edit via modal dialog
// 3. Assistant message retraction / delete with customizable placeholder
// 4. Tool-preserving Assistant regeneration
// 5. Visual settings drawer/modal & full state synchronization

window.__ModuleLoader__.load({
  id: '@local/dsh-time-weaver',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var UiPrimitives = require('@deepseek-ai/dsh-client-ui-primitives')

    var API = '/api/time-weaver'

    function post(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then((r) => r.json()).catch(() => null)
    }
    function get(path) {
      return fetch(API + path).then((r) => r.json()).catch(() => null)
    }

    var L = {
      copy: '复制',
      copied: '已复制',
      rewind: '回退至此 (打断并重填)',
      edit: '编辑此回复',
      retract: '撤回/删除此回复',
      regenerate: '重新生成 (保全工具链)',
      cancel: '取消回溯',
      banner: '时间线已定格：当前尾部已被安全隐去，随时可再次调整或提交新消息。',
      image: '[图片附件]',
      extra: '详细数据',
      truncated: '... (已折叠)',
      save: '保存修改',
      saving: '保存中...',
      close: '关闭',
      settings: '时空编织者设置',
      editTitle: '编辑 AI 回复内容',
      editHint: '修改后将实时更新模型上下文，后续对话将顺着修改后的内容继续推演。',
    }

    // ------------------------------------------------ Pure SVG Icons --
    function svgIcon(paths, viewBox) {
      return React.createElement('svg', {
        viewBox: viewBox || '0 0 24 24',
        width: 14,
        height: 14,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.75,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
      }, paths)
    }

    var REWIND_ICON = svgIcon([
      React.createElement('path', { key: 'arc', d: 'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8' }),
      React.createElement('path', { key: 'head', d: 'M3 3v5h5' }),
    ])
    var CANCEL_ICON = svgIcon([
      React.createElement('path', { key: 'a', d: 'M18 6 6 18' }),
      React.createElement('path', { key: 'b', d: 'M6 6l12 12' }),
    ])
    var COPY_ICON = svgIcon([
      React.createElement('rect', { key: 'r', x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 }),
      React.createElement('path', { key: 'p', d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }),
    ])
    var CHECK_ICON = svgIcon([
      React.createElement('polyline', { key: 'p', points: '20 6 9 17 4 12' }),
    ])
    var EDIT_ICON = svgIcon([
      React.createElement('path', { key: 'p', d: 'M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' }),
    ])
    var RETRACT_ICON = svgIcon([
      React.createElement('polyline', { key: 'p1', points: '3 6 5 6 21 6' }),
      React.createElement('path', { key: 'p2', d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' }),
    ])
    var REGEN_ICON = svgIcon([
      React.createElement('polyline', { key: 'p1', points: '23 4 23 10 17 10' }),
      React.createElement('polyline', { key: 'p2', points: '1 20 1 14 7 14' }),
      React.createElement('path', { key: 'p3', d: 'M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15' }),
    ])
    var SETTINGS_ICON = svgIcon([
      React.createElement('circle', { key: 'c', cx: 12, cy: 12, r: 3 }),
      React.createElement('path', { key: 'p', d: 'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z' }),
    ])

    // Crucial: Use Tooltip which wraps children properly, NOT HoverCard
    function iconButton(tooltip, className, icon, handlers) {
      return React.createElement(UiPrimitives.Tooltip, {
        label: tooltip,
        side: handlers && handlers.side ? handlers.side : 'bottom'
      }, React.createElement('button', {
        type: 'button',
        className: className,
        'aria-label': tooltip,
        onClick: handlers && handlers.onClick,
        disabled: handlers && handlers.disabled,
      }, icon))
    }

    // ---------------------------------------------- Image Re-attachment --
    function b64ToBytes(b64) {
      var bin = atob(b64)
      var bytes = new Uint8Array(bin.length)
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return bytes
    }

    var reattachChain = Promise.resolve()

    function reattachImages(sid, images) {
      var list = Array.isArray(images) ? images : []
      if (list.length === 0) return Promise.resolve(0)
      reattachChain = reattachChain.then(() => reattachBatch(sid, list), () => reattachBatch(sid, list))
      return reattachChain
    }

    function reattachBatch(sid, list) {
      var jobs = list.map((img) => {
        var ref = img && img.attachment ? img.attachment : null
        if (ref === null || ref.attachmentId === undefined) return null
        var q = '/image?sessionId=' + encodeURIComponent(sid) + '&attachmentId=' + encodeURIComponent(String(ref.attachmentId))
        return get(q).then((res) => {
          if (!res || res.ok !== true || typeof res.data !== 'string') throw new Error('image read failed')
          var mediaType = res.mediaType || ref.mediaType || 'image/png'
          var name = res.name || ref.name || 'image.png'
          return new File([b64ToBytes(res.data)], name, { type: mediaType })
        })
      }).filter((job) => job !== null)
      return Promise.all(jobs).then((files) => {
        var real = files.filter((f) => f instanceof File)
        if (real.length === 0) return 0
        var input = composerFileInput()
        if (input === null) return 0
        try {
          input.value = ''
          var dt = new DataTransfer()
          real.forEach((f) => dt.items.add(f))
          input.files = dt.files
          input.dispatchEvent(new Event('change', { bubbles: true }))
          return real.length
        } catch (e) {
          return 0
        }
      })
    }

    function composerFileInput() {
      var roots = document.querySelectorAll('[data-composer], [data-dsh-composer], form')
      for (var i = 0; i < roots.length; i++) {
        var found = roots[i].querySelector('input[type="file"][multiple]')
        if (found !== null) return found
      }
      return document.querySelector('input[type="file"][multiple]')
    }

    // ------------------------------------------------ State Management --
    var store = new Map()
    var listeners = new Set()
    var activeModal = null // { type: 'edit' | 'settings', sessionId, messageId, seq, text }
    var liveSessionId = null
    var slotsRef = null
    var liveInputActions = null

    // The chat.node slot does not receive inputActions, so the rewind prefill
    // borrows the handle the composer-side slots do receive.
    function draftActions(props) {
      if (props && props.inputActions && typeof props.inputActions.setDraft === 'function') return props.inputActions
      return liveInputActions
    }

    function emit() {
      listeners.forEach((fn) => {
        try { fn() } catch {}
      })
    }

    function getState(sid) {
      var st = store.get(sid)
      if (!st) {
        st = {
          pending: null,
          ranges: [],
          edits: new Map(),
          retractions: new Map(),
          regenerates: new Set(),
          sourceTexts: new Map(),
          turnBySeq: new Map(),
          config: { placeholder: '.' },
          version: 0,
          fetchFailed: false,
        }
        store.set(sid, st)
      }
      return st
    }

    function writeState(sid, patch) {
      var st = getState(sid)
      Object.keys(patch).forEach((k) => {
        st[k] = patch[k]
      })
      st.version++
      emit()
    }

    function rwLoadState(sid) {
      if (!sid) return Promise.resolve(false)
      return get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
        if (!res || res.ok !== true) return false
        var editsMap = new Map()
        var sourceMap = new Map()
        var turnMap = new Map()
        if (Array.isArray(res.edits)) {
          res.edits.forEach((e) => {
            if (typeof e.seq === 'number' && typeof e.content === 'string') {
              editsMap.set(e.seq, e.content)
              if (typeof e.originalText === 'string' && e.originalText !== '') sourceMap.set(e.seq, e.originalText)
              if (typeof e.turn === 'number') turnMap.set(e.seq, e.turn)
            }
          })
        }
        var retMap = new Map()
        if (Array.isArray(res.retractions)) {
          res.retractions.forEach((item) => {
            if (typeof item === 'object' && item !== null) {
              retMap.set(item.seq, item.placeholder)
              if (typeof item.originalText === 'string' && item.originalText !== '') sourceMap.set(item.seq, item.originalText)
              if (typeof item.turn === 'number') turnMap.set(item.seq, item.turn)
            } else if (typeof item === 'number') retMap.set(item, '.')
          })
        }
        var regSet = new Set()
        if (Array.isArray(res.regenerates)) {
          res.regenerates.forEach((item) => {
            if (typeof item === 'number') {
              regSet.add(item)
              return
            }
            if (item === null || typeof item !== 'object' || typeof item.seq !== 'number') return
            regSet.add(item.seq)
            if (typeof item.originalText === 'string' && item.originalText !== '') sourceMap.set(item.seq, item.originalText)
            if (typeof item.turn === 'number') turnMap.set(item.seq, item.turn)
          })
        }
        writeState(sid, {
          pending: res.pending || null,
          ranges: Array.isArray(res.ranges) ? res.ranges : [],
          edits: editsMap,
          retractions: retMap,
          regenerates: regSet,
          sourceTexts: sourceMap,
          turnBySeq: turnMap,
          config: res.config || { placeholder: '.' },
          fetchFailed: false,
        })
        return true
      }).catch(() => false)
    }

    // The host commits a pending rewind during the next turn's pre-step. Nothing
    // pushes that to the client, so a stale local `pending` keeps hiding the
    // freshly sent prompt and its reply — and keeps the banner/X on screen.
    // Poll until the host reports the commit, then re-sync once.
    function rwPollState(sid) {
      if (!sid) return
      var st = store.get(sid)
      if (!st || !st.pending) return
      get('/state?sessionId=' + encodeURIComponent(sid)).then((res) => {
        if (!res || res.ok !== true) return
        var current = store.get(sid)
        if (!current || !current.pending) return
        var hostPending = res.pending ?? null
        var rangesChanged = JSON.stringify(current.ranges || []) !== JSON.stringify(res.ranges || [])
        if (hostPending === null) {
          try { post('/diag', { v: 'pending-committed', sid: sid, ranges: (res.ranges || []).slice(-2) }) } catch (e) {}
          rwLoadState(sid)
          return
        }
        if (rangesChanged) rwLoadState(sid)
      }).catch(() => {})
    }

    function useTimeWeaver(sid) {
      var forceUpdate = React.useState(0)[1]
      React.useEffect(() => {
        function onChange() { forceUpdate((v) => v + 1) }
        listeners.add(onChange)
        return () => { listeners.delete(onChange) }
      }, [])
      return sid ? getState(sid) : null
    }

    // ------------------------------------------------ DOM Hiding Driver --
    function rwRestoreAll() {
      var rows = document.querySelectorAll('[data-chat-flow-key], [data-xsj-seq]')
      for (var i = 0; i < rows.length; i++) {
        rows[i].style.display = ''
        rows[i].removeAttribute('data-tw-hidden')
      }
    }

    function twNorm(value) {
      return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim()
    }

    // Deepest element whose own text is the needle (exact match wins). Falls
    // back to a contains match only for long needles, so a reply like "1" can
    // never be confused with an unrelated bubble.
    function twLeafFor(root, needle) {
      var exact = null
      var exactDepth = -1
      var loose = null
      var looseDepth = -1
      var walk = function (el, depth) {
        if (!el || el.nodeType !== 1) return
        var text = twNorm(el.textContent)
        if (text !== '') {
          if (text === needle && depth > exactDepth) { exact = el; exactDepth = depth }
          if (needle.length >= 8 && text.indexOf(needle) !== -1 && depth > looseDepth) { loose = el; looseDepth = depth }
        }
        var kids = el.children || []
        for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1)
      }
      walk(root, 0)
      return exact !== null ? exact : loose
    }

    // A completed turn folds its process into a turn-process disclosure row, so
    // the reply text can live in either that group row or a standalone
    // assistant-step row. Both are considered.
    var TW_ROW_SELECTOR = '[data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="turn-process"], [data-turn-process-answer]'

    function twReplyRows() {
      return document.querySelectorAll(TW_ROW_SELECTOR)
    }

    // The reply a turn's action row acts on is the last reply row of that turn.
    // Turn numbers are stable across re-renders, so this anchor does not drift
    // with text edits — text matching made hiding flaky and made hidden rows
    // flicker back whenever a lookup missed.
    function twReplyRowForTurn(turn) {
      if (turn === undefined || turn === null || turn === '') return null
      var rows = twReplyRows()
      var found = null
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-chat-turn') === String(turn)) found = rows[i]
      }
      return found
    }

    function twRowForSeq(seq, needle, turn) {
      var rows = twReplyRows()
      var i
      // 1. Turn scope: deterministic and text-independent.
      var byTurn = twReplyRowForTurn(turn)
      if (byTurn !== null) return byTurn
      // 2. An earlier pass already anchored this seq.
      for (i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-tw-seq') === String(seq)) return rows[i]
      }
      // 3. Last resort: the pristine text, only when the answer is unique.
      if (needle === '') return null
      var matches = []
      for (i = 0; i < rows.length; i++) {
        if (twLeafFor(rows[i], needle) !== null) matches.push(rows[i])
      }
      return matches.length === 1 ? matches[0] : null
    }

    // Rewrite rendered reply text for edited seqs and stamp the rows of
    // retracted seqs (which are hidden, not rewritten). A row that cannot be
    // identified with certainty is left untouched rather than guessed.
    function twApplyTexts(sid) {
      var st = store.get(sid)
      if (!st) return 0
      var sources = st.sourceTexts || new Map()
      var turns = st.turnBySeq || new Map()
      var rows = twReplyRows()
      if (rows.length === 0) return 0
      var applied = 0

      var applyOne = function (seq, next) {
        if (typeof next !== 'string') return
        var needle = twNorm(sources.get(seq))
        var row = twRowForSeq(seq, needle, turns.get(seq))
        if (row === null) return
        row.setAttribute('data-tw-seq', String(seq))
        var leaf = twLeafFor(row, needle)
        if (leaf === null) return
        if (twNorm(leaf.textContent) === twNorm(next)) return
        leaf.textContent = next
        // The transcript is HTML: without pre-wrap the edited line breaks
        // collapse into one run-on paragraph.
        if (/\n/.test(next)) { try { leaf.style.whiteSpace = 'pre-wrap' } catch (e) {} }
        applied += 1
      }

      // Retractions and regenerations only need the anchor: those rows are
      // hidden below, so the model-facing placeholder never shows on screen.
      var stampHidden = function (seq) {
        var needle = twNorm(sources.get(seq))
        var row = twRowForSeq(seq, needle, turns.get(seq))
        if (row === null) return
        row.setAttribute('data-tw-seq', String(seq))
      }

      if (st.edits) st.edits.forEach((text, seq) => applyOne(seq, text))
      if (st.retractions) st.retractions.forEach((placeholder, seq) => stampHidden(seq))
      if (st.regenerates) st.regenerates.forEach((seq) => stampHidden(seq))
      return applied
    }

    // ------------------------------------------------------------ Diagnostics --
    var diagLastAt = 0
    var diagLastSig = ''

    function twDiag(sid, applied) {
      try {
        var st = store.get(sid)
        if (!st) return
        var rows = twReplyRows()
        var sample = rows.length === 0 ? null : {
          kind: rows[0].getAttribute('data-chat-flow-kind'),
          turn: rows[0].getAttribute('data-chat-turn'),
          text: twNorm(rows[0].textContent).slice(0, 60),
        }
        var edits = st.edits ? st.edits.size : 0
        var retractions = st.retractions ? st.retractions.size : 0
        var regenCount = st.regenerates ? st.regenerates.size : 0
        // Nothing to reconcile means nothing worth logging (avoids a heartbeat
        // line every tick on unrelated sessions).
        if (edits + retractions + regenCount === 0) return
        var sig = [rows.length, edits, retractions, regenCount, applied].join(':')
        if (sig === diagLastSig) return
        diagLastSig = sig
        diagLastAt = Date.now()
        post('/diag', {
          v: 'diag-1',
          sid: sid,
          rows: rows.length,
          stepRows: document.querySelectorAll('[data-chat-flow-kind="assistant-step"]').length,
          processRows: document.querySelectorAll('[data-chat-flow-kind="turn-process"]').length,
          answerMarkers: document.querySelectorAll('[data-turn-process-answer]').length,
          flowRows: document.querySelectorAll('[data-chat-flow-key]').length,
          edits: edits,
          retractions: retractions,
          sources: st.sourceTexts ? st.sourceTexts.size : 0,
          turns: st.turnBySeq ? st.turnBySeq.size : 0,
          applied: applied,
          stamps: document.querySelectorAll('[data-tw-seq]').length,
          userStamps: document.querySelectorAll('[data-xsj-seq]').length,
          sample: sample,
        })
      } catch (e) {}
    }

    function rwApply(sid) {
      var st = store.get(sid)
      if (!st) return
      var ranges = st.ranges || []
      var regens = st.regenerates || new Set()
      var retractions = st.retractions || new Map()
      var pendingFrom = st.pending && typeof st.pending.targetSeq === 'number' ? st.pending.targetSeq : null

      // Stamp first: retracted rows are located by their pristine text, then
      // hidden by the verdict pass below.
      var applied = 0
      try { applied = twApplyTexts(sid) } catch (e) {}

      var rows = document.querySelectorAll('[data-chat-flow-key]')
      if (!rows || rows.length === 0) {
        rows = document.querySelectorAll('[data-xsj-seq]')
      }

      // Only user/steering rows carry a seq stamp. An unstamped row belongs to
      // the region opened by the closest stamped row above it, so it inherits
      // that row's verdict instead of being left on screen.
      var lastSeq = NaN
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i]
        var seqStr = r.getAttribute('data-xsj-seq')
        var seq = seqStr ? parseInt(seqStr, 10) : NaN
        if (!isNaN(seq)) lastSeq = seq

        var anchor = !isNaN(seq) ? seq : lastSeq
        var hidden = false

        if (!isNaN(anchor)) {
          hidden = ranges.some((range) => anchor >= range.start && anchor <= range.end)
          if (pendingFrom !== null && anchor >= pendingFrom) hidden = true
        }
        if (!isNaN(seq) && regens.has(seq)) hidden = true

        // A retracted or regenerated reply leaves the transcript; the model
        // still sees the placeholder / the omission.
        var stamp = r.getAttribute('data-tw-seq')
        if (stamp !== null) {
          var stampSeq = parseInt(stamp, 10)
          if (retractions.has(stampSeq) || regens.has(stampSeq)) hidden = true
        }

        if (hidden) {
          r.style.display = 'none'
          r.setAttribute('data-tw-hidden', '1')
        } else {
          r.style.display = ''
          r.removeAttribute('data-tw-hidden')
        }
      }

      try { twDiag(sid, applied) } catch (e) {}
    }

    function fmtClock(time) {
      try {
        var d = new Date(time)
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch {
        return ''
      }
    }

    // ------------------------------------------------ User Bubble View --
    // DSH 0.2.1 renders user text, reference chips, and attachments through the
    // `conversation.chat.user.content` Factory; `UiPrimitives.projectUserText`
    // and the `renderMessageImages` prop are gone. When the host hands us the
    // Factory seat we delegate the whole content body to it, and otherwise fall
    // back to a literal-text bubble.
    function userFactoryInput(props, data) {
      var content = Array.isArray(data.content) ? data.content : []
      var text = ''
      var attachments = []
      var extraBlocks = []
      content.forEach(function (block) {
        if (!block || typeof block !== 'object') {
          extraBlocks.push(block)
          return
        }
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text
          return
        }
        if (block.type === 'image' && block.attachment !== undefined) {
          attachments.push({ type: 'image', image: { attachment: block.attachment } })
          return
        }
        if (block.type === 'file' && block.attachment !== undefined) {
          attachments.push({ type: 'file', file: block.attachment })
          return
        }
        extraBlocks.push(block)
      })
      var prepared = { text: text, attachments: attachments, extraBlocks: extraBlocks }
      var facts = {}
      if (data.referenceLabels !== undefined) {
        prepared.referenceLabels = data.referenceLabels
        facts.sessionLabels = data.referenceLabels
      }
      if (data.skillNames !== undefined) facts.skillNames = data.skillNames
      return { content: prepared, loadImage: props.loadImage, facts: facts, interactive: true }
    }

    function UserNodeView(props) {
      var node = props.node
      var data = node && node.data ? node.data : { content: [] }
      var parts = contentParts(data.content)
      var sid = props.sessionId || liveSessionId
      var seq = node && typeof node.anchorSeq === 'number' ? node.anchorSeq : undefined
      var copiedState = React.useState(false)
      var copied = copiedState[0]
      var setCopied = copiedState[1]
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]
      var rootRef = React.useRef(null)

      React.useLayoutEffect(() => {
        try {
          var el = rootRef.current
          if (!el || !el.closest || seq === undefined) return
          var row = el.closest('[data-chat-flow-key]') || el.closest('[data-chat-anchor-key]')
          if (row && row.getAttribute('data-xsj-seq') !== String(seq)) {
            row.setAttribute('data-xsj-seq', String(seq))
            window.dispatchEvent(new Event('tw-stamp'))
          }
        } catch {}
      })

      function onCopy() {
        if (copied) return
        UiPrimitives.writeClipboard(parts.text).then((ok) => {
          if (ok) setCopied(true)
        }).catch(() => {})
      }

      // Anchor the clicked row to its seq at click time, so the very first
      // verdict pass already knows what to hide even if the layout effect that
      // normally stamps the row has not run yet.
      function stampOwnRow(event) {
        try {
          var el = event && event.currentTarget
          var row = el && el.closest ? el.closest('[data-chat-flow-key]') : null
          if (row !== null && seq !== undefined) row.setAttribute('data-xsj-seq', String(seq))
        } catch (e) {}
      }

      function onRewind(event) {
        stampOwnRow(event)
        // Log the click even when the guard below bails: without this there is
        // no way to tell "never requested" from "rejected by the host".
        try {
          post('/diag', {
            v: 'rewind-click',
            sid: sid || null,
            seq: seq === undefined ? null : seq,
            anchorSeq: node && node.anchorSeq !== undefined ? node.anchorSeq : null,
            hasLive: liveSessionId !== null,
            busy: !!busy,
          })
        } catch (e) {}
        if (busy || seq === undefined || !sid) return
        setBusy(true)
        post('/mark', { sessionId: sid, seq: seq, preview: parts.text.slice(0, 120) }).then((res) => {
          if (res && res.ok === true) {
            writeState(sid, { pending: { targetSeq: seq, markSeq: res.markSeq || seq } })
            // Hide immediately instead of waiting for the next tick.
            try { rwApply(sid) } catch (e) {}
            try { window.dispatchEvent(new Event('tw-stamp')) } catch (e) {}
            var actions = draftActions(props)
            if (actions !== null) {
              try { actions.setDraft(parts.text) } catch (e) {}
            }
            if (parts.images.length > 0) {
              reattachImages(sid, parts.images).catch(() => {})
            }
          } else {
            try { post('/diag', { v: 'rewind-rejected', sid: sid, seq: seq, res: res }) } catch (e) {}
          }
        }).catch(() => {}).then(() => { setBusy(false) })
      }

      var stackChildren = []
      var factoryContent = null
      if (typeof props.renderFactorySlot === 'function') {
        try {
          factoryContent = props.renderFactorySlot(
            'conversation.chat.user.content', userFactoryInput(props, data))
        } catch (e) {
          factoryContent = null
        }
      }
      if (factoryContent !== null && factoryContent !== undefined) {
        stackChildren.push(React.createElement('div', { key: 'content', className: 'tw-factory' }, factoryContent))
      } else {
        if (parts.images.length > 0) {
          var renderImages = props.renderMessageImages
          if (typeof renderImages === 'function') {
            stackChildren.push(React.createElement('div', { key: 'images', className: 'tw-images' },
              renderImages({ images: parts.images, align: 'end', compact: parts.images.length > 1 })))
          }
        }
        if (parts.text !== '' || parts.rest.length > 0) {
          var bubbleChildren = []
          if (parts.text !== '') {
            // .tw-text declares white-space: pre-wrap, so line breaks survive.
            bubbleChildren.push(React.createElement('div', { key: 'text', className: 'tw-text' }, parts.text))
          }
          stackChildren.push(React.createElement('div', { key: 'bubble', className: 'tw-bubble' }, bubbleChildren))
        }
      }

      var actionsChildren = []
      if (typeof data.time === 'number') {
        actionsChildren.push(React.createElement('span', { key: 'clock', className: 'tw-clock' }, fmtClock(data.time)))
      }
      actionsChildren.push(iconButton(copied ? L.copied : L.copy, 'tw-action',
        copied ? CHECK_ICON : COPY_ICON,
        { onClick: onCopy, side: 'bottom' }))
      actionsChildren.push(iconButton(L.rewind, 'tw-action tw-trigger', REWIND_ICON,
        { onClick: onRewind, disabled: busy, side: 'bottom' }))

      return React.createElement('div', { className: 'tw-row tw-user-row', 'data-time-hover-root': true, ref: rootRef },
        React.createElement('div', { key: 'stack', className: 'tw-stack' }, stackChildren),
        React.createElement('div', { key: 'actions', className: 'tw-actions' }, actionsChildren))
    }

    function contentParts(content) {
      var text = ''
      var images = []
      var rest = []
      if (Array.isArray(content)) {
        content.forEach((item) => {
          if (!item || typeof item !== 'object') return
          if (item.type === 'text' && typeof item.text === 'string') {
            text += item.text
          } else if (item.type === 'image') {
            images.push(item)
          } else {
            rest.push(item)
          }
        })
      } else if (typeof content === 'string') {
        text = content
      }
      return { text: text, images: images, rest: rest }
    }

    // --------------------------------------- Assistant Actions Strip Entry --
    function AssistantMessageActions(props) {
      var messageId = props.messageId
      var sid = props.sessionId || liveSessionId
      var st = useTimeWeaver(sid)
      var busyState = React.useState(false)
      var busy = busyState[0]
      var setBusy = busyState[1]

      function turnOf(event) {
        try {
          var el = event && event.currentTarget
          var row = el && el.closest ? el.closest('[data-chat-flow-key]') : null
          return row === null ? null : row.getAttribute('data-chat-turn')
        } catch (e) {
          return null
        }
      }

      function openEdit(event) {
        if (busy) return
        setBusy(true)
        var turn = turnOf(event)
        get('/message?sessionId=' + encodeURIComponent(sid) + '&messageId=' + encodeURIComponent(messageId))
          .then((res) => {
            if (res && res.ok === true) {
              activeModal = {
                type: 'edit',
                sessionId: sid,
                messageId: messageId,
                seq: res.seq,
                text: res.text || '',
                turn: turn,
              }
              emit()
            }
          })
          .catch(() => {})
          .then(() => setBusy(false))
      }

      function onRetract(event) {
        if (busy) return
        setBusy(true)
        var turn = turnOf(event)
        var ph = (st && st.config && st.config.placeholder) || '.'
        post('/retract', { sessionId: sid, messageId: messageId, placeholder: ph })
          .then((res) => {
            if (res && res.ok === true) {
              var rets = new Map(st.retractions)
              rets.set(res.seq, ph)
              var sources = new Map(st.sourceTexts || new Map())
              if (typeof res.originalText === 'string' && res.originalText !== '') sources.set(res.seq, res.originalText)
              var turns = new Map(st.turnBySeq || new Map())
              if (turn !== null && turn !== undefined && turn !== '') turns.set(res.seq, Number(turn))
              writeState(sid, { retractions: rets, sourceTexts: sources, turnBySeq: turns })
            }
          })
          .catch(() => {})
          .then(() => setBusy(false))
      }

      function onRegenerate(event) {
        if (busy) return
        setBusy(true)
        var turn = turnOf(event)
        post('/regenerate', { sessionId: sid, messageId: messageId })
          .then((res) => {
            if (res && res.ok === true) {
              var regs = new Set(st.regenerates)
              regs.add(res.seq)
              var sources = new Map(st.sourceTexts || new Map())
              if (typeof res.originalText === 'string' && res.originalText !== '') sources.set(res.seq, res.originalText)
              var turns = new Map(st.turnBySeq || new Map())
              var resolvedTurn = typeof res.turn === 'number' ? res.turn : turn
              if (resolvedTurn !== null && resolvedTurn !== undefined && resolvedTurn !== '') turns.set(res.seq, Number(resolvedTurn))
              writeState(sid, { regenerates: regs, sourceTexts: sources, turnBySeq: turns })
              window.dispatchEvent(new Event('tw-stamp'))
            } else {
              try { post('/diag', { v: 'regenerate-rejected', sid: sid, res: res }) } catch (e) {}
            }
          })
          .catch(() => {})
          .then(() => setBusy(false))
      }

      return React.createElement('div', { className: 'tw-assistant-actions-group' },
        iconButton(L.edit, 'tw-action', EDIT_ICON, { onClick: openEdit, disabled: busy, side: 'bottom' }),
        iconButton(L.retract, 'tw-action', RETRACT_ICON, { onClick: onRetract, disabled: busy, side: 'bottom' }),
        iconButton(L.regenerate, 'tw-action', REGEN_ICON, { onClick: onRegenerate, disabled: busy, side: 'bottom' })
      )
    }

    // ---------------------------------------- Dialogs (Overlay Injection) --
    function TimeWeaverOverlay(props) {
      var sid = props.sessionId
      var forceUpdate = React.useState(0)[1]
      React.useEffect(() => {
        function onChange() { forceUpdate((v) => v + 1) }
        listeners.add(onChange)
        return () => { listeners.delete(onChange) }
      }, [])

      if (!activeModal || activeModal.sessionId !== sid) return null

      if (activeModal.type === 'edit') {
        return React.createElement(EditDialog, {
          sessionId: sid,
          messageId: activeModal.messageId,
          seq: activeModal.seq,
          initialText: activeModal.text,
          turn: activeModal.turn,
          onClose: () => { activeModal = null; emit() },
        })
      }

      if (activeModal.type === 'settings') {
        return React.createElement(SettingsDialog, {
          sessionId: sid,
          onClose: () => { activeModal = null; emit() },
        })
      }

      return null
    }

    function EditDialog(props) {
      var sid = props.sessionId
      var seq = props.seq
      var textState = React.useState(props.initialText)
      var text = textState[0]
      var setText = textState[1]
      var subState = React.useState(false)
      var submitting = subState[0]
      var setSubmitting = subState[1]

      function onSave() {
        setSubmitting(true)
        post('/edit', { sessionId: sid, seq: seq, content: text }).then((res) => {
          if (res && res.ok === true) {
            var st = getState(sid)
            var edits = new Map(st.edits)
            edits.set(seq, text)
            var rets = new Map(st.retractions)
            rets.delete(seq)
            var sources = new Map(st.sourceTexts || new Map())
            if (!sources.has(seq) && typeof props.initialText === 'string' && props.initialText !== '') {
              sources.set(seq, props.initialText)
            }
            var turns = new Map(st.turnBySeq || new Map())
            if (props.turn !== null && props.turn !== undefined && props.turn !== '') turns.set(seq, Number(props.turn))
            writeState(sid, { edits: edits, retractions: rets, sourceTexts: sources, turnBySeq: turns })
            props.onClose()
          }
        }).catch(() => {}).then(() => setSubmitting(false))
      }

      return React.createElement('div', { className: 'tw-modal-overlay', onClick: props.onClose },
        React.createElement('div', { className: 'tw-modal tw-edit-modal', onClick: (e) => e.stopPropagation() },
          React.createElement('h3', { className: 'tw-modal-title' }, L.editTitle),
          React.createElement('p', { className: 'tw-hint' }, L.editHint),
          React.createElement('textarea', {
            className: 'tw-textarea',
            value: text,
            onChange: (e) => setText(e.target.value),
            rows: 8,
          }),
          React.createElement('div', { className: 'tw-modal-footer' },
            React.createElement('button', { className: 'tw-btn', onClick: props.onClose, type: 'button' }, '取消'),
            React.createElement('button', { className: 'tw-btn tw-btn-primary', onClick: onSave, disabled: submitting, type: 'button' }, submitting ? L.saving : L.save)
          )
        )
      )
    }

    function SettingsDialog(props) {
      var sid = props.sessionId
      var st = useTimeWeaver(sid)
      var currentPh = (st && st.config && st.config.placeholder) || '.'
      var phState = React.useState(currentPh)
      var ph = phState[0]
      var setPh = phState[1]

      function save(newPh) {
        setPh(newPh)
        post('/config', { placeholder: newPh }).then((res) => {
          if (res && res.ok && res.config) {
            writeState(sid, { config: res.config })
          }
        }).catch(() => {})
      }

      return React.createElement('div', { className: 'tw-modal-overlay', onClick: props.onClose },
        React.createElement('div', { className: 'tw-modal', onClick: (e) => e.stopPropagation() },
          React.createElement('h3', { className: 'tw-modal-title' }, L.settings),
          React.createElement('div', { className: 'tw-modal-body' },
            React.createElement('label', { className: 'tw-label' }, 'AI 回复撤回/删除时的占位符内容：'),
            React.createElement('div', { className: 'tw-preset-row' },
              ['.', ' ', '[已撤回此条输出]', '(已删除)'].map((preset) =>
                React.createElement('button', {
                  key: preset,
                  type: 'button',
                  className: 'tw-preset-btn ' + (ph === preset ? 'active' : ''),
                  onClick: () => save(preset),
                }, preset === ' ' ? '空格 (" ")' : preset)
              )
            ),
            React.createElement('input', {
              type: 'text',
              className: 'tw-input',
              value: ph,
              onChange: (e) => save(e.target.value),
              placeholder: '输入自定义占位文本...',
            }),
            React.createElement('p', { className: 'tw-hint' }, '提示：点击 AI 消息的删除/撤回时，正文将替换为上方设定的占位符，既阻断旧内容，又完美保全前置工具调用历史。')
          ),
          React.createElement('div', { className: 'tw-modal-footer' },
            React.createElement('button', { className: 'tw-btn tw-btn-primary', onClick: props.onClose, type: 'button' }, L.close)
          )
        )
      )
    }

    // ------------------------------------------------ Composer Controls --
    function SettingsButton(props) {
      var sid = props.sessionId
      if (props.inputActions && typeof props.inputActions.setDraft === 'function') liveInputActions = props.inputActions
      function onClick() {
        activeModal = { type: 'settings', sessionId: sid }
        emit()
      }
      return iconButton(L.settings, 'tw-cancel', SETTINGS_ICON, { onClick: onClick, side: 'top' })
    }

    function CancelButton(props) {
      var sid = props.sessionId
      if (sid) liveSessionId = sid
      if (props.inputActions && typeof props.inputActions.setDraft === 'function') liveInputActions = props.inputActions
      var st = useTimeWeaver(sid)
      var pending = st && st.pending ? st.pending : null

      React.useEffect(() => {
        var live = true
        rwLoadState(sid).then((ok) => {
          if (live && !ok) writeState(sid, { fetchFailed: true })
        })
        return () => { live = false }
      }, [sid])

      React.useEffect(() => {
        var t = 0
        function schedule() {
          clearTimeout(t)
          t = setTimeout(() => { try { rwApply(sid) } catch {} }, 150)
        }
        schedule()
        // characterData matters: a re-render can restore an edited leaf by
        // mutating its text node, which emits no childList record.
        var obs = new MutationObserver(schedule)
        obs.observe(document.body, { childList: true, subtree: true, characterData: true })
        window.addEventListener('tw-stamp', schedule)
        // Belt and braces: re-assert edited text on a slow tick, and learn about
        // a host-side rewind commit while a mark is still pending locally.
        var tick = setInterval(() => {
          try { rwApply(sid) } catch (e) {}
          try { rwPollState(sid) } catch (e) {}
        }, 1200)
        return () => {
          clearTimeout(t)
          clearInterval(tick)
          obs.disconnect()
          window.removeEventListener('tw-stamp', schedule)
          // No rwRestoreAll() here: this effect re-runs on every state change,
          // and un-hiding there made every hidden row flash back for a frame
          // before the next verdict pass hid it again.
        }
      }, [sid, st ? st.version : 0])

      function onCancel() {
        post('/cancel', { sessionId: sid }).then((res) => {
          if (res && res.ok === true) {
            // The rewind pre-filled the composer with the recalled prompt; a
            // cancelled rewind must not leave that text behind.
            if (props.inputActions && typeof props.inputActions.setDraft === 'function') {
              try { props.inputActions.setDraft('') } catch (e) {}
            }
            writeState(sid, { pending: null })
          }
        }).catch(() => {})
      }

      if (pending === null) return null
      return iconButton(L.cancel, 'tw-cancel', CANCEL_ICON, { onClick: onCancel, side: 'top' })
    }

    function Banner(props) {
      var st = useTimeWeaver(props.sessionId)
      var pending = st && st.pending ? st.pending : null
      if (pending === null) return null
      return React.createElement('div', { className: 'tw-banner' },
        React.createElement('span', { className: 'tw-banner-icon', 'aria-hidden': true }, '↺'),
        React.createElement('span', null, L.banner))
    }

    var TW_CSS = [
      '.tw-row{display:flex;flex-direction:column;align-items:flex-end;gap:6px;min-width:0}',
      '.tw-stack{display:flex;flex-direction:column;align-items:flex-end;gap:8px;min-width:0;max-width:min(525px,82%)}',
      '.tw-bubble{background:var(--dsw-specific-bubble,rgba(127,127,127,.14));color:var(--dsw-alias-label-primary,inherit);border-radius:22px;padding:10px 16px;font-size:16px;line-height:24px;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere}',
      '.tw-images{display:flex;justify-content:flex-end;max-width:100%}',
      '.tw-text{white-space:pre-wrap;word-break:break-word}',
      '.tw-factory{display:block;min-width:0;max-width:100%}',
      '.tw-actions{display:flex;align-items:center;gap:2px;height:28px}',
      '.tw-clock{color:var(--dsw-alias-label-tertiary,#98a2b3);white-space:nowrap;padding-right:10px;font-size:14px;line-height:24px;font-variant-numeric:tabular-nums}',
      '.tw-action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary,#98a2b3);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.tw-action:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16));color:var(--dsw-alias-label-secondary,inherit)}',
      '@media(hover:hover){[data-time-hover-root] .tw-clock,[data-time-hover-root] .tw-action{opacity:0;transition:opacity 80ms}[data-time-hover-root]:hover .tw-clock,[data-time-hover-root]:hover .tw-action,[data-time-hover-root]:focus-within .tw-clock,[data-time-hover-root]:focus-within .tw-action{opacity:1}}',
      '@media(hover:hover){[data-time-hover-root] .tw-trigger{opacity:.55}[data-time-hover-root]:hover .tw-trigger{opacity:1}}',
      '.tw-cancel{width:28px;height:28px;color:var(--dsw-alias-label-secondary,inherit);cursor:pointer;background:transparent;border:none;border-radius:14px;display:inline-flex;align-items:center;justify-content:center;padding:6px}',
      '.tw-cancel:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}',
      '.tw-banner{width:100%;max-width:min(var(--dsh-composer-card-max-width,780px),100%);box-sizing:border-box;display:flex;align-items:center;gap:8px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-secondary,inherit);border-radius:10px;padding:6px 12px;font-size:13px;line-height:20px;margin:0 auto 6px}',
      '.tw-banner-icon{flex:none;font-size:14px}',
      '.tw-assistant-actions-group{display:inline-flex;align-items:center;gap:2px}',
      '.tw-modal-overlay{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:99999}',
      '.tw-modal{background:var(--dsw-alias-bg-surface,#1e1e2e);color:var(--dsw-alias-label-primary,#f8f9fa);width:440px;max-width:90vw;border-radius:14px;padding:20px;box-shadow:0 12px 36px rgba(0,0,0,0.35);display:flex;flex-direction:column;gap:14px;border:1px solid var(--dsw-alias-border-l1,rgba(255,255,255,0.1))}',
      '.tw-edit-modal{width:600px !important}',
      '.tw-modal-title{margin:0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary,#f8f9fa)}',
      '.tw-modal-body{display:flex;flex-direction:column;gap:10px;font-size:14px;color:var(--dsw-alias-label-primary,#f8f9fa)}',
      '.tw-label{font-weight:500;font-size:13px;color:var(--dsw-alias-label-primary,#f8f9fa)}',
      '.tw-preset-row{display:flex;gap:6px;flex-wrap:wrap}',
      '.tw-preset-btn{padding:5px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.3));background:var(--dsw-alias-interactive-bg,rgba(127,127,127,0.08));cursor:pointer;font-size:12px;color:var(--dsw-alias-label-primary,#f8f9fa)}',
      '.tw-preset-btn.active{background:var(--dsw-alias-primary,#4561EE);color:#fff;border-color:transparent}',
      '.tw-input{padding:8px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.3));background:var(--dsw-alias-bg-input,rgba(0,0,0,0.15));color:var(--dsw-alias-label-primary,#f8f9fa);font-size:13px}',
      '.tw-textarea{width:100%;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.3));background:var(--dsw-alias-bg-input,rgba(0,0,0,0.15));color:var(--dsw-alias-label-primary,#f8f9fa);font-family:inherit;font-size:14px;line-height:20px;resize:vertical}',
      '.tw-hint{font-size:12px;color:var(--dsw-alias-label-secondary,#a0aec0);margin:0}',
      '.tw-modal-footer{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}',
      '.tw-btn{padding:6px 14px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,0.3));background:transparent;cursor:pointer;font-size:13px;color:var(--dsw-alias-label-primary,#f8f9fa)}',
      '.tw-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,0.16))}',
      '.tw-btn-primary{background:var(--dsw-alias-primary,#4561EE);color:#fff;border:none}',
    ].join('\n')

    function apply(ctx) {
      var slots = ctx && (ctx.get ? ctx.get('slots') : ctx.slots)

      var baseTag = document.createElement('style')
      baseTag.setAttribute('data-time-weaver', 'base')
      baseTag.textContent = TW_CSS
      document.head.append(baseTag)

      // Boot marker: distinguishes "client half never loaded" from "loaded but
      // the DOM driver found nothing" without a devtools session.
      try {
        post('/diag', {
          v: 'boot',
          ver: '1.0.8',
          hasSlots: !!(slots && typeof slots.inject === 'function' && typeof slots.register === 'function'),
        })
      } catch (e) {}

      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return

      function tryRegister(label, options, component) {
        try {
          return slots.register(options, component)
        } catch (e) {
          console.warn('[time-weaver] register failed for', label, e)
          return function () {}
        }
      }

      ctx.effect(() => {
        var disposers = [
          // 1. User message bubble with Rewind button
          slots.inject('conversation.chat.node', () => [
            tryRegister('chat.node:user', { name: 'conversation.chat.node', key: 'user', priority: -1 }, (p) => React.createElement(UserNodeView, p)),
            tryRegister('chat.node:steering', { name: 'conversation.chat.node', key: 'steering', priority: -1 }, (p) => React.createElement(UserNodeView, p)),
          ]),
          // 2. Assistant message action bar (Edit, Retract, Regenerate)
          slots.inject('conversation.chat.assistant-actions', () => [
            tryRegister('chat.assistant:time-weaver', {
              name: 'conversation.chat.assistant-actions',
              id: 'time-weaver-actions',
              order: 25,
              inject: (sessionId) => ({ sessionId })
            }, (p) => React.createElement(AssistantMessageActions, p)),
          ]),
          // 3. Input right controls (Cancel rewind, Settings modal trigger)
          slots.inject('conversation.input.right', () => [
            tryRegister('input.right:cancel', { name: 'conversation.input.right', id: 'tw-cancel', order: 90, label: L.cancel }, (p) => React.createElement(CancelButton, p)),
            tryRegister('input.right:settings', { name: 'conversation.input.right', id: 'tw-settings', order: 95, label: L.settings }, (p) => React.createElement(SettingsButton, p)),
          ]),
          // 4. Input dock banner
          slots.inject('conversation.input.dock', () => {
            return tryRegister('input.dock:banner', { name: 'conversation.input.dock', id: 'tw-banner', order: 90, label: 'banner' }, (p) => React.createElement(Banner, p))
          }),
          // 5. Input overlay dialogs (Edit & Settings Modals)
          slots.inject('conversation.input.overlay', () => [
            tryRegister('input.overlay:time-weaver', {
              name: 'conversation.input.overlay',
              id: 'tw-dialogs',
              order: 10,
              inject: (sessionId) => ({ sessionId })
            }, (p) => React.createElement(TimeWeaverOverlay, p)),
          ]),
        ]
        return () => {
          disposers.forEach((d) => { try { d() } catch {} })
        }
      })
      ctx.effect(() => () => baseTag.remove())
    }

    exports.name = 'time-weaver'
    exports.inject = ['slots']
    exports.apply = apply
    return module.exports
  },
})

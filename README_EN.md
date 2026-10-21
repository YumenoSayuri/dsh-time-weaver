# @local/dsh-time-weaver

English | [简体中文](./README.md)

Conversation-flow control for DSH (DeepSeek Harness): **rewind a user message**, **edit an assistant reply in place**, **retract a reply semantically**, and **regenerate** — all while keeping the underlying append-only journal untouched.

Every capability is recorded as a `hook/invoked` retention event, so all state survives a client shutdown, a machine restart, a session switch, and applies to conversations created before the plugin was installed.

---

## Features

| Feature | Entry point | Behaviour |
| --- | --- | --- |
| **Rewind** | «↺» on a user message row | Interrupts the running turn; hides that message and the tail after it; restores text and images into the composer |
| **Cancel rewind** | «✕» left of the send button | Restores every hidden row and clears the restored draft |
| **Edit** | «✏️» on an assistant reply | Edits the body in a dialog; model context **and** rendered bubble both update, keeping paragraph breaks |
| **Retract** | «🗑️» on an assistant reply | The reply leaves the transcript; the model reads a configurable placeholder (default `.`) |
| **Regenerate** | «🔄» on an assistant reply | Drops the old reply from context and wakes a fresh turn; the trigger is rendered as a collapsed notice, not a user bubble |
| **Settings** | «⚙» in the input area | Choose or customise the retraction placeholder |

Assistant-side actions preserve the preceding tool calls and tool results, so no orphan tool result is ever produced.

## Requirements

- DSH Next (uses the host `webServer` / `sessions` / `agents` services and the client `slots` service)
- Since DSH 0.2.1-rc.2 the user bubble body is rendered by the `conversation.chat.user.content` Factory; the plugin prefers it and falls back to literal text when it is absent
- Node.js >= 20
- No runtime dependencies

## Install

```jsonc
// package.json (excerpt)
"main": "host.v8.js",
"exports": { ".": "./host.v8.js", "./client": "./client.js" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-client-ui-slots"] }
}
```

Add the package to your DSH profile and its `dsh.profile.bundles`, then **restart DSH** (the host half loads with the process). The client half reloads with the page.

## How it works

Two halves, no overlap:

- **Host** (`host.v8.js`) — appends and replays `hook/invoked` events, wraps `session.deriveMessages()` so model history matches the woven state, serves the HTTP API, and wakes the agent.
- **Client** (`client.js`) — injects the action buttons and dialogs through `slots`, then hides or rewrites the rows that are already rendered.

Key decisions:

1. **Model context** is decided by `session.deriveMessages()`. Edited replies are replaced, retracted ones become the placeholder, rewound ranges and regenerated replies are dropped. Content is always a block array.
2. **Screen state** is applied on top of DSH's own render: rows are located by a three-level anchor — `data-chat-turn` (stable, text-independent) → this round's `data-tw-seq` stamp → unique full-text match. Hiding is `display:none`; editing replaces the text node and adds `white-space: pre-wrap` when the new text has line breaks.
3. **A rewind commits** during the next turn's `agent/pre-step`, using the tail captured at mark time so the freshly sent prompt is never swallowed. The client polls `/state` while a mark is pending and re-syncs as soon as the host commits.
4. **Regenerate** calls the agent's own `followup()` to open a new turn with no user input; the trigger message carries `source.form = "notice"` and renders as a collapsed line.

## HTTP API

All under `/api/time-weaver`:

| Method | Path | Purpose |
| --- | --- | --- |
| POST | `/mark` | Mark a rewind start point |
| POST | `/cancel` | Cancel a pending rewind |
| POST | `/edit` | Edit the reply at a given seq |
| POST | `/retract` | Retract the reply at a given seq |
| POST | `/regenerate` | Drop and regenerate the reply at a given seq |
| GET | `/message` | Read one message's text and state |
| GET | `/state` | Full state: `pending` / `ranges` / `edits` / `retractions` / `regenerates` |
| GET·POST | `/config` | Read or write the placeholder |
| GET | `/image` | Fetch an image referenced by a rewound message |
| POST | `/diag` | Client diagnostics report |

## Diagnostics

Both halves append JSON lines to `~/.dsh/time-weaver-diag.log` (capped at 512 KiB): `boot`, `diag-1`, `rewind-click`, `rewind-rejected`, `mark-ok`, `mark-reject`, `pending-committed`, `regenerate`, `regenerate-rejected`.

## Known limitations

- The screen layer is an overlay on DSH's rendering, not a replacement renderer. It depends on the current chat DOM attributes (`data-chat-flow-key`, `data-chat-turn`, `data-chat-flow-kind`); a major DSH DOM change requires updating `TW_ROW_SELECTOR` and the locator.
- A turn may contain several assistant steps (reasoning, tool cards); edit / retract / regenerate act on that turn's **final answer**.
- Regenerate leaves one extra notice-shaped context message — it is the input that opens the new turn, and it is not rendered as a user bubble.
- A committed rewind range is persisted; it cannot be undone from the UI (only by editing the journal).

## Develop and test

```bash
node test/host.test.mjs     # host projection: edit / retract / regenerate / rewind range
node test/hiding.test.mjs   # client locating and hiding: turn anchor, ambiguity, idempotence
```

Both suites load the real entry files; nothing is duplicated or mocked away.

## License

[MIT](./LICENSE). Inspired by [`@xsj/dsh-rewind`](https://github.com/XSJUSTC); behaviour and implementation rewritten against the current DSH API.

Full changelog: see [简体中文 README](./README.md#版本历史).

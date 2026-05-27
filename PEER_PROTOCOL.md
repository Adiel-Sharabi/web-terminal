# Peer Protocol — Claude <-> Codex

Two AI coding agents are running side-by-side on this host, each inside its own terminal session served by `web-terminal`. This file is the contract between them.

If you are **Claude Code** or **Codex CLI** and the user told you to read `PEER_PROTOCOL.md`, you are one of those agents. Read this entire file before sending or receiving anything.

---

## Why this exists

Sometimes you want a second opinion. The other agent is right here, on this same machine, with the same files in front of them. You can ask them a focused question and get a focused answer back — without the user playing telephone.

This is **not** a chat room. It is a way to ask one question and get one answer, occasionally.

## How to identify yourself

Pick the agent name that matches what you are:
- `claude` — you are Claude Code
- `codex` — you are Codex CLI

The user may also instruct you to use a different name (e.g. `claude-a`, `codex-review`). Whatever name they give you, **stick with it for the whole session**.

## The endpoints

All endpoints are local only (`http://127.0.0.1:7681`). They require no authentication from inside this box; they reject anything that is not loopback. Use `curl`.

### Send a message

```bash
curl -sS -X POST http://127.0.0.1:7681/api/relay/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"claude","to":"codex","message":"<your question or reply>"}'
```

To **continue an existing exchange**, add `"conv_id":"<id from prior response>"`. Without `conv_id` you start a fresh conversation.

To **batch several messages and have the peer only reply at the end**, add `"more":true` on every message except the last. While `more=true`, the server buffers the message and the peer's `recv` will **not** see it (their long-poll keeps waiting). When you finally send a message with `more:false` (or simply omit `more`), all buffered messages on that `conv_id` are delivered at once and the peer can answer. This is how you say "I have a few things to dump, hold on, … okay, now answer."

Response:
```json
{
  "ok": true,
  "conv_id": "9f1c...",
  "turn": 1,
  "remaining_turns": 5,
  "daily_remaining": 49
}
```

### Receive messages (long-poll)

```bash
curl -sS "http://127.0.0.1:7681/api/relay/recv?agent=codex&wait=30"
```

- `wait` is in **seconds**, capped at 30. Omit or set `0` to return immediately.
- Add `&conv_id=<id>` to pick up only one conversation.
- Returns `{"messages":[...], "daily_remaining":N}`. `messages` may be empty if the long-poll timed out.

### Check status / remaining budget

```bash
curl -sS http://127.0.0.1:7681/api/relay/status
```

Shows current limits, daily counter, queue depths, and live conversations.

## The two roles

In any given exchange, one agent is the **asker** and one is the **answerer**. Pick exactly one role per exchange.

### Asker (you want a second opinion)

1. Send your question. **Be specific** — paste the diff, the error, the snippet. The other agent cannot see your screen, your tools, or your conversation. They only see what you write in `message`.
2. Capture the `conv_id` from the response.
3. If you have more context to add before the peer should think, send additional messages with `"more":true` on the same `conv_id`. The peer will not see anything until you close the batch with a final message where `more` is `false` (or omitted).
4. Long-poll `recv` with that `conv_id` until a message arrives or you time out. Reasonable pattern: try `wait=30` two or three times, then give up and tell the user the peer didn't respond.
5. When you get a reply, **use it as input to your own judgement**. Do not blindly do what the other agent says. They saw less context than you.
6. If you genuinely need one clarifying follow-up, send it on the same `conv_id`. Otherwise the exchange ends.

**Each message — including the buffered ones in a batch — counts as one turn against the conversation cap and one against the daily cap.** So a 3-message batch + 1 closing message + 1 reply is already 5 of 6 turns. Consolidate.

### Answerer (you are being asked)

You only know you've been asked if either (a) the user tells you to check the relay, or (b) you have been told at the start of the session to poll. If the user has not told you to listen, **do nothing here** — the asker will get a timeout and move on, which is correct.

When you do answer:

1. Receive with your own agent name (`agent=claude` if you are Claude, etc.).
2. Read the question. Form an actual opinion based on the files and the question. If the answer is "I don't know" or "I don't have enough context," say that — do not invent.
3. Reply with `from=<you>`, `to=<asker>`, and the **same `conv_id`** from the incoming message.
4. Keep it short. One paragraph or a small code block. This is a second opinion, not a refactor.

## The hard rate limits (read this)

The server enforces three caps. You cannot exceed them; the API will return `429` or `413`. They exist so the two of you do not burn the user's token budget overnight in a politeness loop.

| Limit | Default | Env override |
|---|---|---|
| Messages per conversation (across both sides) | 6 | `WT_RELAY_MAX_TURNS_PER_CONV` |
| Messages per day (across all conversations) | 50 | `WT_RELAY_DAILY_MAX` |
| Bytes per message | 16384 | `WT_RELAY_MAX_MSG_BYTES` |

If you get `429 daily-cap` or `429 conv-cap`, **stop trying**. Tell the user. Do not start a new `conv_id` to dodge the conv cap — the daily cap will still bite and you are wasting their money.

## Soft rules — the etiquette

These are not enforced by code. They are enforced by you reading them.

1. **Ask at most once per task.** If you have already gotten a second opinion on this problem, do not ask again unless something materially changed.
2. **No greetings, no sign-offs, no "thanks for the help".** Every message is one paid turn. Use it for content.
3. **Do not start a conversation to chat.** If you have nothing concrete to ask, do not send anything.
4. **Do not poll on a loop "just in case".** If you are the answerer and the user hasn't told you to listen, you are not listening.
5. **Trust your own work first.** Reach for the peer when you are genuinely stuck on a judgement call, not for routine reassurance.
6. **The user is the source of truth.** If the peer's advice contradicts the user's stated intent, the user wins.
7. **Memory resets on server reload.** If `server.js` is restarted, all conversation IDs and the daily counter reset. Do not rely on the peer remembering anything across that boundary — re-establish context in your first message after a reload.

## Batched example

Claude has three things to stream before Codex should weigh in:

```bash
# Message 1 — open the batch
curl -sS -X POST http://127.0.0.1:7681/api/relay/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"claude","to":"codex","more":true,
       "message":"Context: refactoring lib/ipc.js. Going to send the current handshake, then the heartbeat path, then my proposed diff. Wait for my final message before replying."}'
# -> {"ok":true,"conv_id":"b2...","turn":1,"more":true,"buffered":1,...}

# Message 2 — keep the batch open
curl -sS -X POST http://127.0.0.1:7681/api/relay/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"claude","to":"codex","conv_id":"b2...","more":true,
       "message":"Current heartbeat: <paste>"}'

# Message 3 — close the batch, peer is now allowed to answer
curl -sS -X POST http://127.0.0.1:7681/api/relay/send \
  -H 'Content-Type: application/json' \
  -d '{"from":"claude","to":"codex","conv_id":"b2...",
       "message":"Proposed diff: <paste>. Question: am I breaking the Windows pipe reconnect path?"}'
# -> {"ok":true,"conv_id":"b2...","turn":3,"more":false,...}
```

Codex's `recv` returns all three messages together. Codex reads them as one prompt and replies once.

## Minimal example

Claude is mid-task, hits a design choice, wants Codex's read:

```bash
# Claude sends:
curl -sS -X POST http://127.0.0.1:7681/api/relay/send \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "claude",
    "to": "codex",
    "message": "About to refactor lib/ipc.js to drop the 5s heartbeat and rely on TCP keepalive. The handshake still authenticates. Any reason heartbeats are load-bearing here that I am missing? File is ~400 lines, key bits at lines 80-140 (handshake) and 220-260 (heartbeat sender)."
  }'
# -> {"ok":true,"conv_id":"a7...","turn":1,"remaining_turns":5,"daily_remaining":49}

# Codex (when prompted by the user to check) reads, looks at lib/ipc.js, replies:
curl -sS "http://127.0.0.1:7681/api/relay/recv?agent=codex&wait=30"
# -> {"messages":[{"conv_id":"a7...","from":"claude",...}], ...}

curl -sS -X POST http://127.0.0.1:7681/api/relay/send \
  -H 'Content-Type: application/json' \
  -d '{
    "from": "codex",
    "to": "claude",
    "conv_id": "a7...",
    "message": "Heartbeats also wake the named-pipe write side; on Windows pipes the OS does not surface a half-open peer for ~minutes without traffic. Dropping them will delay reconnect on a wedged server.js. Keep them, or shorten to 30s."
  }'

# Claude polls for the reply, factors it into the decision, moves on.
```

That is the whole protocol. One question. One answer. Back to work.

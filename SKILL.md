---
name: committee-conversation
description: Run a conversation between a human and several independent LLM speakers (Claude CLI, Codex, Cursor Agent, or any provider through OpenCode) inside pi. Speakers see each other's intentions and decide for themselves when to speak. Use when someone wants a room of models to discuss a question, or wants to change, resume, or debug such a room.
---

# Committee conversation

A pi extension hosts the room. The host only moves messages, keeps the ledger and logs usage. Nobody schedules turns, nobody picks who speaks, there is no facilitator.

## Run it

```
cd <room folder>
pi --no-tools --no-mcp --no-skills --no-session --no-extensions --no-context-files --no-prompt-templates \
   -e ~/.agents/skills/committee-conversation/committee.ts
```

The room folder is the unit of state. Inside it:

- `committee.json`: the seats, former seats and etiquette. Created by onboarding, edited by `/seats`. This is the file to share: it carries no sessions or transcript. On a machine that lacks a seat's CLI, startup offers to remap that seat or start without it.
- `committee/events.jsonl`: the public log, append-only. Replayed on start so the conversation continues where it stopped.
- `committee/sessions.json`: each seat's native session id, how much transcript it has seen, which rules version it has seen. A restart resumes sessions instead of re-sending history.
- `committee/diag.jsonl`: raw provider output for failed calls.
- `committee/codex-home/`: a private `CODEX_HOME` for codex seats (auth only, no plugins).

Commands inside pi: `/committee on|off|reset` (off = pi behaves normally, speakers stay alive; reset = delete committee.json and committee/ in this folder, so the next `/committee on` onboards again), `/seats` (add, change model or thinking, remove), `/usage` (per-seat token table).

With no `committee.json` in the folder, committee mode starts off and `/committee on` runs onboarding: detected CLIs, then per seat a CLI, a model from the live list, a thinking level, a name (a random adverb-adjective is offered) and an optional persona. The persona is free text or a path to a file (relative to the room folder, or `~`), read when the seat's first packet is built. It is set only at creation; to change it, remove the seat and add it again.

A removed seat (via `/seats`, or dropped at startup) becomes a ghost: a pale dot in the status row, its lines kept in the transcript, listed to the others as former so nobody addresses it.

## Protocol: two phases per cycle

A cycle starts after a human message or after someone spoke.

1. **Intention**, all seats in parallel. Each returns `schemas/intention.schema.json`: preference (speak, wait, yield, silent), intent, a one-sentence topic.
2. **Respond**, only seats that said `speak`, in parallel. Each sees everyone's intentions and returns `schemas/response.schema.json`: `speak` with the text, `repeat` with the event id of an earlier reply of its own, or `wait` / `silent`.

If exactly one seat wants to speak it is asked directly, without the intentions broadcast. Replies render as they arrive. A `repeat` re-shows the earlier line under the speaker's name, marked already answered, and does not start another cycle. When nobody speaks the room idles until the human types.

Rules every seat gets (see `rules` in committee.ts): one speaker per cycle normally, defer to who has spoken less, the last floor holder may finish a thought, ties mean everyone who claimed speaks briefly, contributions under 120 words unless the intention said long, tool output kept short if a seat ever has tools, a human message never goes unanswered (the last answerer repeats), never cite an intention as if spoken. Rules are versioned; a session that saw an older version gets the new text once.

## Sessions and cost

One native session per seat, kept open for the whole conversation. A session gets the preamble (identity, rules, roster) and the full transcript once, then only the events since its last packet. The CLI's own context and the provider's prompt cache hold the rest. Every call reads its whole session, so input tokens per call equal the session size; what matters is the fresh part.

Measured on 2026-10-21, fresh tokens per call after the first:

| cli | how | fresh per call | notes |
| --- | --- | --- | --- |
| claude | `claude -p` stream-json, `--system-prompt`, `--setting-sources ""`, `--tools ""`, resumed with `--resume` | ~150-300 | without the two prompt flags it carries 10k of Claude Code prompt per call |
| opencode | one `opencode serve` per host, one session per seat over HTTP, tool-less `speaker` agent via `OPENCODE_CONFIG_CONTENT` | ~60-150 | any provider opencode is logged into. OpenRouter and DeepSeek direct cache-hit; Fireworks did not |
| codex | `codex app-server` JSON-RPC, private `CODEX_HOME` | ~200 after turn 2 | fixed ~27k context of its own prompt and tools, cached, no flag removes it |
| cursor | one `cursor-agent -p --trust` process per message, `--resume` | ~100 | fixed ~11k of its own prompt, cached, no flag removes it |

Onboarding marks codex and cursor as not supported for that reason. The adapters work; the cost does not.

Thinking levels are per seat. claude: `--effort` low to max. codex: per-turn `effort`. opencode: the model variant, accepted names differ per model (measured: glm-5.3 low/high/max, gpt-sol low to max, deepseek-v4-pro none/low/high/max). cursor: a suffix in the model id.

## Usage is logged, never estimated

Every call appends a `usage` event: phase, fresh, cached, out, cost when the provider reports it, and whether the session was resumed. `/usage` sums them per seat. When asked where tokens go, read events.jsonl; the per-CLI normalisation is in speaker.ts (claude `input_tokens` excludes cache reads, codex `inputTokens` includes them, cursor excludes them, opencode reports `tokens.cache.read`).

## Files

- `committee.ts`: the extension. Config, replay, packets, cycle, rendering, `/seats`, `/committee`, `/usage`, onboarding.
- `speaker.ts`: `Speaker` class, one per seat. `send(text, schema)` returns `{ok, payload, usage, session_id, resumed}`. Schema goes in the prompt and the reply is parsed and checked locally, so one session serves both phases.
- `schemas/`: intention and response JSON schemas.
- `example.json`: a reference cast. Not loaded; onboarding writes the real one.
- `smoke.ts`: `bun smoke.ts` from a room folder runs every seat in example.json for two turns, then kills and resumes each session.

## Changing things

- A new rule or etiquette line: edit `rules` or the etiquette in committee.json. Versioning delivers it to live sessions on their next packet.
- A new CLI or provider: add a case in speaker.ts with the same three jobs as the others: start or resume a session, send one message and parse the reply, report fresh/cached/out. Measure its fixed per-call context before recommending it.
- Changing a seat's model or thinking gives it a fresh session; its past lines stay in the transcript and the ledger. Removing a seat keeps its lines too. Adding a seat is not announced to the others; they see its lines appear.
- Seats have no tools today (claude `--tools ""`, opencode `permission deny`). If native tools are turned on per seat, the host should publish each tool call and result as a ledger event so the room sees it once; the intention phase then also declares planned tool use so overlaps resolve like speaking does. Not built.
- Not built, by choice: nomination rounds, a soft deadline for slow seats, a facilitator, a cap on LLM-to-LLM cycles.

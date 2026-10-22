<h1><img src="logo.svg" alt="" height="36" valign="middle"> pi-committee</h1>

You have a question and more than one model you trust. This puts four or five of them in one room, where each decides for itself whether to answer.

It runs inside [pi](https://github.com/earendil-works/pi-coding-agent), which needs Node 22.19 or newer:

```
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install https://github.com/sushruth/pi-committee
```

Then, in any folder, start `pi` and type `/committee on`. Setup asks which CLI runs each seat, its model, thinking level, tools, a name, and an optional persona. Your next message goes to all of them.

<p align="center">
  <img src="docs/room.webp" width="640" alt="A pi-committee room: four seats on different models answer the same question, each with its tool work counted, with the room's context and cost in the footer">
  <br>
  <sub>Four seats (deepseek, opus, qwen, glm) asked to pick a first refactor in an empty folder. Three measure it and say so; the footer shows what the room has used.</sub>
</p>

## What a message sets off

Every seat is asked, in parallel, whether it has something to add and what. Everyone's answers are shown to everyone. Then the seats that wanted to speak decide again, now knowing what the others intend, and reply or hold. A reply starts the cycle over, so a thread moves between seats until nobody has anything new, and the room goes quiet. The rules every seat gets say: defer to whoever has spoken less, stay under 120 words, answer the human before anything else, and when nothing new remains, whoever answered last shows that answer again rather than leaving a question hanging.

There is no facilitator and no turn order. The host moves messages, keeps the log, and counts tokens.

## Seats

A seat is one CLI, one model, one native session that stays open for the whole conversation. Each call carries only what is new since the seat's last call; the CLI's own session and the provider's prompt cache hold the rest. Measured per call after the first, on 2026-10-22:

| CLI | fresh tokens per call | how |
| --- | --- | --- |
| claude | ~150–300 | `claude -p` with its system prompt replaced and settings, MCP and memory files kept out |
| opencode | ~60–150 | one `opencode serve` per room, a private empty config dir, any provider you are logged into |
| codex | ~200 | `codex app-server` with a private `CODEX_HOME` that turns off its skills list, instructions and feature tools |
| pi | ~1.6k | one `pi -p` process per message, its own prompt replaced; no cache reads seen on OpenRouter |
| cursor | ~1k, on ~13.5k of fixed prompt | listed as unsupported: no flag removes its server-side prompt |

Providers whose cache does not hit cost the whole context on every call. OpenRouter's `~latest` aliases and qwen3.8-flash showed no cache reads; Fireworks never hit.

A seat can have tools: none, read-only (read, grep, glob, a shell), or everything its CLI has. Tool calls and output stay in that seat's own session. The room sees the reply, with a small marker saying how many calls it took, and the rules tell seats to put the numbers and paths they found into the reply. The intention round runs with tools off, so no seat starts working before the room has seen every intention.

## Commands

- `/committee on|off`: off hands the input back to pi; the seats stay alive.
- `/committee pause` and `/committee resume`: calls in flight finish, nothing new starts, your messages wait. `alt+p` also pauses.
- `/committee brief <text or file path>`: what every seat should know about this folder, sent once and again if it changes. `/committee brief -` clears it.
- `/committee reset`: asks, then deletes this folder's `committee.json` and `committee/`.
- `/seats`: add a seat, change its model, thinking or tools, or remove it. A removed seat stays in the status row as a pale dot; its lines stay in the transcript.
- `/usage`: per seat, calls, tokens billed, live context against the model's window, cost.

The status row shows each seat's state, a clock while it works, and the tool it is running. Click a seat for its last intention and reply; click the `(⚒)` for the room; click the footer for cost by seat.

## Files in the room folder

- `committee.json`: seats, former seats, etiquette, brief. This is the file to share; it holds no sessions and no transcript. On a machine without one of its CLIs, startup offers to remap that seat or go on without it.
- `committee/events.jsonl`: the log, replayed on start so a conversation continues across restarts.
- `committee/sessions.json`: each seat's native session id and how much of the log it has seen.
- `committee/codex-home`, `committee/opencode-config`, `committee/pi-sessions`: the private homes those CLIs run from.

A room reads one thing from the machine per CLI: its login. Settings, memory files, skills, plugins and MCP servers of your own CLIs do not reach a seat.

## Not built

A soft deadline for a slow seat, a cap on how many cycles a thread may run, accepting a prose reply in place of the JSON the host asks for, and seats loading your skills.

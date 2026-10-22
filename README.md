<h1><img src="logo.svg" alt="" height="36" valign="middle"> pi-committee</h1>

pi-committee is an extension for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent. It turns a pi session into a chat room where you talk to several language models at once. Each model runs in its own CLI (Claude Code, Codex, OpenCode or pi) and decides for itself when to answer. The extension passes messages between the models, keeps the log, and counts tokens.

## Install

pi runs on Node 22.19 or newer. Install pi, then install pi-committee into pi:

```
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi install https://github.com/sushruth/pi-committee
```

## Start a room

1. Open a terminal in any folder. That folder becomes the room.
2. Run `pi`.
3. Type `/committee on`.
4. Setup asks you, for each seat: which CLI runs it, which model, which thinking level, which tools (none, read-only, or all), a name, and an optional persona. Setup suggests a random name such as `quietly-excellent`.
5. Type a message. The extension sends your message to every seat.

<p align="center">
  <img src="docs/room.webp" width="640" alt="A pi-committee room with four seats answering one question">
  <br>
  <sub>Four seats (deepseek, opus, qwen, glm) were asked to pick a first refactor in an empty folder. Three of them measured the folder and reported that it has no code. The footer shows cost and context for the room.</sub>
</p>

## What happens after you send a message

1. The extension asks every seat, in parallel: do you have something to add, and what is it? Each seat answers in one line.
2. The extension shows all of those answers to every seat that said yes.
3. Each of those seats decides again, now knowing what the others intend. It replies, or it holds.
4. Every reply appears in the chat and starts the cycle over at step 1.
5. The cycle stops when no seat has anything new. The room is then silent until you type again.

Every seat receives the same rules. The rules say: speak only when you add something the others' intentions do not cover; defer to seats that have spoken less; keep a reply under 120 words; when the human asks a question that was already answered and nobody has anything new, the seat that answered last shows its earlier answer again.

No seat schedules turns, and the extension does not pick who speaks.

## Seats and cost

One seat is one CLI, one model, and one native session in that CLI. The session stays open for the whole conversation and is resumed after a restart. Each call sends the seat only the messages that arrived since its last call. The CLI's session and the provider's prompt cache hold everything older.

The table shows what one call costs after the seat's first call. I measured these on 2026-10-22 with short test messages.

| CLI | fresh tokens per call | what the extension does to get there |
| --- | --- | --- |
| claude | 150 to 300 | runs `claude -p` with a replaced system prompt; keeps settings, MCP servers and CLAUDE.md files out |
| opencode | 60 to 150 | runs one `opencode serve` per room from a private empty config directory; the seat uses any provider you are logged into |
| codex | about 200 | runs `codex app-server` from a private `CODEX_HOME` whose config turns off the skills list, the built-in instructions and the feature tools |
| pi | about 1,600 | runs one `pi -p` process per message with a replaced system prompt; OpenRouter returned no cache hits for pi |
| cursor | about 1,000, plus 13,500 of fixed prompt | unsupported: cursor-agent has no flag that removes its server-side prompt |

Cache behaviour depends on the provider. OpenRouter's `~latest` model aliases and `qwen3.8-flash` returned no cache hits in my tests, so every call to them costs the whole context. Fireworks returned no cache hits either.

## Tools

Each seat has one of three tool levels:

- **none**: the seat reads and writes nothing.
- **read-only**: the seat can read files, grep, glob, and run a shell. The rules tell it to change nothing. Claude Code enforces this with its tool list; the other CLIs rely on the rule.
- **all**: the seat has every tool its CLI has, including editing files. The rules tell it to change things only when you asked for a change.

Tool calls and their output stay inside the seat's own session. The other seats and you see only the reply. The reply line shows how many tool calls the seat made. The rules tell a seat to put the numbers, paths and results it found into the reply.

The first round of each cycle (step 1 above) runs with tools off for every seat. A seat can use tools only in step 3, when it replies.

## Commands

- `/committee on` and `/committee off`. Off hands your input back to pi's own agent. The seats stay alive.
- `/committee pause` and `/committee resume`. Pause lets calls in flight finish and starts nothing new. Messages you type while paused wait for resume. `alt+p` also pauses.
- `/committee brief <text>` or `/committee brief <file path>`. The brief is what every seat should know about this folder. The extension sends it to each seat once, and again when it changes. `/committee brief -` removes it.
- `/committee reset`. Asks for confirmation, then deletes `committee.json` and the `committee/` folder in the room.
- `/seats`. Adds a seat, changes a seat's model, thinking level or tools, or removes a seat. A removed seat stays in the status row as a pale dot, and its past lines stay in the transcript.
- `/usage`. Shows a table with one row per seat: calls, tokens billed, live context against the model's window, and cost.

## The screen

- The status row above the input box shows one cell per seat: a colored dot, the seat's initials, and its state. While a seat works, the state shows a clock, and when the seat runs a tool, the tool's name.
- Click a seat's cell to open a panel with its last intention and last reply. Click again to close it.
- Click `(⚒)` at the left of the status row to open a panel about the room.
- The footer shows the number of seats, the cycle number, the number of calls, the cost, a bar split by each seat's share of the cost, and the room's live context against the sum of the models' context windows. Click the footer to open a panel with cost per seat.

## Files in the room folder

- `committee.json` holds the seats, the removed seats, the etiquette line and the brief. Share this file to share a room setup. It holds no session ids and no transcript. When another machine lacks one of the CLIs in the file, startup offers to remap that seat to another CLI or to drop it.
- `committee/events.jsonl` is the log of everything said. The extension replays it on start, so a conversation continues after a restart.
- `committee/sessions.json` holds each seat's native session id and how much of the log that seat has already seen.
- `committee/codex-home`, `committee/opencode-config` and `committee/pi-sessions` are the private directories those CLIs run from.

A seat reads exactly one thing from your machine: the login for its CLI. Your own CLI settings, CLAUDE.md and AGENTS.md files, skills, plugins and MCP servers do not reach a seat. I verified this for codex, opencode and pi by running seats under a HOME directory that held only the login files, and for claude by placing a 4,000-word CLAUDE.md in the room folder and checking that the context size did not change.

## Not built

- A deadline for a seat that takes too long. A seat with tools gets 600 seconds per call; a seat without tools gets 120 seconds.
- A cap on how many cycles one message may start.
- Accepting a reply written as prose in place of the JSON the extension asks for. A prose reply gets one request to resend as JSON, then counts as an error.
- Loading your skills into the seats.

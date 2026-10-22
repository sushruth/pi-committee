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

- `committee.json`: the seats, former seats, etiquette and the room brief: what every seat should know about this folder (which tools to measure with, which docs to read first), as text or a file path. It travels in the versioned rules block, so a change reaches live sessions once. Onboarding asks for it; `/committee brief <text|path>` changes it, `/committee brief -` clears it. Created by onboarding, edited by `/seats`. This is the file to share: it carries no sessions or transcript. On a machine that lacks a seat's CLI, startup offers to remap that seat or start without it.
- `committee/events.jsonl`: the public log, append-only. Replayed on start so the conversation continues where it stopped.
- `committee/sessions.json`: each seat's native session id, how much transcript it has seen, which rules version it has seen. A restart resumes sessions instead of re-sending history.
- `committee/diag.jsonl`: raw provider output for failed calls.
- `committee/codex-home/`: a private `CODEX_HOME` for codex seats: the auth file and a `config.toml` rewritten on every start that turns off skills, plugins, apps, web search, the shell and the optional prompt sections.

Commands inside pi: `/committee on|off|pause|resume|reset` (off = pi behaves normally, speakers stay alive; pause = calls in flight finish, nothing new starts, your messages are held until resume; alt+p does the same; reset = delete committee.json and committee/ in this folder, so the next `/committee on` onboards again), `/seats` (add, change model or thinking, remove), `/usage` (per-seat token table).

With no `committee.json` in the folder, committee mode starts off and `/committee on` runs onboarding: detected CLIs, then per seat a CLI, a model from the live list, a thinking level, a name (a random adverb-adjective is offered) and an optional persona. The persona is free text or a path to a file (relative to the room folder, or `~`), read when the seat's first packet is built. It is set only at creation; to change it, remove the seat and add it again.

A removed seat (via `/seats`, or dropped at startup) becomes a ghost: a pale dot in the status row, its lines kept in the transcript, listed to the others as former so nobody addresses it.

## Protocol: two phases per cycle

A cycle starts after a human message or after someone spoke.

1. **Intention**, all seats in parallel. Each returns `schemas/intention.schema.json`: preference (speak, wait, yield, silent), intent, a one-sentence topic.
2. **Respond**, only seats that said `speak`, in parallel. Each sees everyone's intentions and returns `schemas/response.schema.json`: `speak` with the text, `repeat` with the event id of an earlier reply of its own, or `wait` / `silent`.

If exactly one seat wants to speak it is asked directly, without the intentions broadcast. Replies render as they arrive. A `repeat` re-shows the earlier line under the speaker's name, marked already answered, and does not start another cycle. When nobody speaks the room idles until the human types.

Rules every seat gets (see `rules` in committee.ts): one speaker per cycle normally, defer to who has spoken less, the last floor holder may finish a thought, ties mean everyone who claimed speaks briefly, contributions under 120 words unless the intention said long, tool output kept short if a seat ever has tools, a human message never goes unanswered (the last answerer repeats), never cite an intention as if spoken. Rules are versioned; a session that saw an older version gets the new text once.

## Tools, per seat

A seat's `tools` is `"read"` or `"all"` (onboarding asks; `/seats` changes it, which gives a fresh session). Read-only: claude with `--tools Read,Grep,Glob,Bash` and Edit/Write disallowed, opencode with a `speaker-tools` agent allowing read, grep, glob, list and bash. codex with its shell turned back on (`-c features.shell_tool=true -c features.unified_exec=true -c features.code_mode_host=true` on that seat's app-server) and `sandbox: read-only`, which its sandbox enforces. cursor with `--mode ask`, its read-only mode. All: claude with `--permission-mode bypassPermissions` and its full tool set, opencode with a `speaker-all` agent allowing everything, codex with the same shell and `sandbox: workspace-write`, cursor with `--force`. No tools: cursor-agent has no flag that turns its tools off, so a cursor seat without tools fails every call with that error instead of quietly getting read tools. The room folder is their working directory. With "all" the only guard is the rule: plan and report unless the human asked for changes.

Tool work is private to the seat: its calls and their output stay in its own session, the room sees only the reply, and the reply line carries a dim marker (⚙ N tool calls, M chars, kept in its session) for the human. While a seat works its cell in the status row carries a clock (`working 7s`) and, when a tool runs, the tool name (`⚙ bash 12s`); the click panel shows the full command in a `now` row. The row never changes height. claude, pi, codex (`item/started`) and cursor (`--output-format stream-json`) stream tool starts; opencode is polled every 1.5 s. The rules therefore tell seats to put what they found or did into the reply with numbers, paths and results, and to divide work through the intention's `tool` line (one line on the work they would do; a seat that has spoken less and named the same work gets it). Intention calls run with tools off (pi `--no-tools`, opencode the tool-less `speaker` agent, claude, codex and cursor a line in the prompt, since none of them can change tools per call without a new session) and the plain 120 second budget, so no seat can start working before the room has seen every intention. Seats with tools get a longer per-call budget: `toolTimeoutSeconds` in committee.json, default 600, against 120 for the rest.

Cost: a tool round is an extra model step in that seat's session only (measured: a glob plus answer on glm was ~90 fresh tokens after the first call; claude's first tool call carried ~8k fresh because the tool schemas joined its prompt). On opencode, "all" also exposes the user's MCP servers through its code-mode tool, and one seat spent ~96k fresh tokens reading that catalogue; keep opencode seats on read-only unless they need to write.

## Sessions and cost

One native session per seat, kept open for the whole conversation. A session gets the preamble (identity, rules, roster) and the full transcript once, then only the events since its last packet. The CLI's own context and the provider's prompt cache hold the rest. Every call reads its whole session, so input tokens per call equal the session size; what matters is the fresh part.

Measured on 2026-10-21 (codex and cursor on 2026-10-22), fresh tokens per call after the first:

| cli | how | fresh per call | notes |
| --- | --- | --- | --- |
| claude | `claude -p` stream-json, `--system-prompt`, `--setting-sources ""`, `--tools ""` (or the read-only four) , resumed with `--resume` | ~150-300 | without the two prompt flags it carries 10k of Claude Code prompt per call |
| opencode | one `opencode serve` per host, one session per seat over HTTP, tool-less `speaker` agent via `OPENCODE_CONFIG_CONTENT` | ~60-150 | any provider opencode is logged into. OpenRouter and DeepSeek direct cache-hit; Fireworks did not |
| codex | `codex app-server` JSON-RPC, private `CODEX_HOME` whose config.toml sets `include_permissions_instructions`, `include_apps_instructions`, `include_collaboration_mode_instructions`, `include_environment_context` and `skills.include_instructions` to false, `skills.bundled.enabled = false`, `web_search = "disabled"` and turns off the apps, plugins, multi_agent, shell_tool, unified_exec, code_mode_host, image_generation, view_image and similar features; `baseInstructions` replaces its prompt | ~170-260 | gpt-5.6-luna: whole call ~2.4k tokens without tools, ~3.1k with the shell on, 2176/2944 of it cached on the second call. Before: ~12.6k per call (a 22k-char skills list from `~/.agents/skills` was most of it) and the second call had 6.6k fresh |
| cursor | one `cursor-agent -p --trust --output-format stream-json` process per message, `--resume` | ~900 | gpt-5.3-codex-low: whole call ~13.7k tokens, 12.8k cached on the second call. Its prompt is server side; `CURSOR_CONFIG_DIR` changed nothing, and a private `HOME` loses the login. No per-step usage, so no live context figure |
| pi | one `pi -p --mode json` process per message, `--session-id` under `committee/pi-sessions`, `--system-prompt` replaces its own | ~1.6k (glm-flash via openrouter, no cache hits reported) | any provider pi is logged into; tools via `--no-tools`, `--tools read,grep,find,ls,bash`, or pi's default set |

Onboarding marks cursor as not supported for that reason; claude, opencode, pi and codex are offered. The cursor adapter works; the cost does not.

Thinking levels are per seat. claude: `--effort` low to max. pi: `--thinking` off to max. codex: per-turn `effort`, the list from that model's `supported_reasoning_levels` in `~/.codex/models_cache.json`. opencode: the model variant; the picker reads the live list from opencode's /api/model, since names differ per model (glm-5.3 and glm-5.3-flash low/high/max, qwen3.8-flash none/high/max, deepseek-flash and -v4-pro none/low/high/max). A seat whose variant the model lacks fails every call with provider.no-route. cursor: a suffix in the model id.

## Usage is logged, never estimated

Every call appends a `usage` event: phase, fresh, cached, out, cost when the provider reports it, and whether the session was resumed. `/usage` shows one spend number per seat (every token billed: in, cached, out, across every tool step) and the last call's context size where the CLI reports a per-step figure (not claude, whose result sums all steps). The footer shows cost and the room's live context: the sum of each seat's current context (input of its last model step, which every CLI reports per step) over the sum of their model windows (opencode `/api/model` limit, pi `--list-models`, codex `context_window` in `~/.codex/models_cache.json`, claude 200k or 1M for `[1m]` models; cursor reports none), drawn as one bar whose filled part is split by seat color. Beside the cost sits a second bar, always full, split by each seat's share of the cost; clicking the footer opens a per-seat cost table above the seat row. When asked where tokens go, read events.jsonl; the per-CLI normalisation is in speaker.ts (claude `input_tokens` excludes cache reads, codex `inputTokens` includes them and a turn's spend is the growth of its running `total`, cursor excludes them, opencode reports `tokens.cache.read`).

## Files

- `committee.ts`: the extension. Config, replay, packets, cycle, rendering, `/seats`, `/committee`, `/usage`, onboarding.
- `speaker.ts`: `Speaker` class, one per seat. `send(text, schema)` returns `{ok, payload, usage, session_id, resumed}`. The prompt ends with the schema's first `examples` entry, a filled-in object, because small models copy an example and echo a schema; the schema itself is only the host's check, so one session serves both phases. A prose reply gets one nudge to resend as JSON, since models that just used tools often forget.
- `schemas/`: intention and response JSON schemas. Only `preference` and `topic` (intention) and `action` (response) are required; everything else is optional and extra keys are ignored, since small models drop fields. A reply in the other phase's shape is mapped (`action` to `preference` and back, `text` to `topic`) before the check, since models mix the two up.
- `example.json`: a reference cast. Not loaded; onboarding writes the real one.
- `smoke.ts`: `bun smoke.ts` from a room folder runs every seat in example.json for two turns, then kills and resumes each session.

## Changing things

- A new rule or etiquette line: edit `rules` or the etiquette in committee.json. Versioning delivers it to live sessions on their next packet.
- A new CLI or provider: add a case in speaker.ts with the same three jobs as the others: start or resume a session, send one message and parse the reply, report fresh/cached/out. Measure its fixed per-call context before recommending it.
- Changing a seat's model or thinking gives it a fresh session; its past lines stay in the transcript and the ledger. Removing a seat keeps its lines too. Adding a seat is not announced to the others; they see its lines appear.
- Not built, by choice: nomination rounds, a soft deadline for slow seats, a facilitator, a cap on LLM-to-LLM cycles.

## Why not escape to pause

pi reserves escape for its own interrupt and for cancelling pickers, and skips any extension shortcut on a reserved key even when the interrupt is rebound. alt+p is the pause key instead.

## Portable: a room depends on logins, not on the machine

Tested on 2026-10-22 by running seats under a HOME that held only each CLI's auth file: codex, opencode and pi behaved identically (same context size, same cache hits). What each seat reads from the machine, and nothing else:

- claude: the login (Keychain on macOS). `--setting-sources ""` and `--strict-mcp-config` with an empty MCP config keep settings and MCP out; a 4,000-word CLAUDE.md in the room folder did not change the context size (964 tokens either way).
- codex: `~/.codex/auth.json`, copied once into the room's private `committee/codex-home`, whose `config.toml` is rewritten on every start. The model list is read from that private home (codex writes `models_cache.json` there on first run), with `~/.codex` only as a fallback.
- opencode: `~/.local/share/opencode/auth.json`. The server runs with `XDG_CONFIG_HOME` pointed at an empty `committee/opencode-config`, so `~/.config/opencode` (AGENTS.md, skills, plugins, MCP servers) never reaches a seat; on a machine with those present that cut ~3.4k tokens per seat.
- pi: `~/.pi/agent/auth.json`; the flags disable extensions, skills, MCP, prompt templates and context files.

A shared `committee.json` therefore works anywhere the same CLIs are installed and logged in; `/committee on` offers to remap a seat whose CLI is missing.

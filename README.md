# ⚒ pi-committee

A [pi](https://github.com/earendil-works/pi-coding-agent) extension that hosts a conversation between a human and several independent LLM speakers, each on its own CLI and model (Claude CLI, or any provider through OpenCode). Nobody schedules turns: every seat states an intention, sees everyone else's, and decides for itself whether to speak.

```
cd <room folder>
pi --no-tools --no-mcp --no-session --no-extensions --no-context-files --no-prompt-templates \
   --skill <this folder> -e <this folder>/committee.ts
```

Then `/committee on`. With no `committee.json` in the folder, onboarding asks for each seat's CLI, model, thinking level, name and optional persona.

- `committee.json` is the shareable part: seats, former seats, etiquette.
- `committee/` holds the room's state: event log, native session ids, diagnostics.
- One native session per seat, kept open and fed only new events, so each call costs roughly the new text.
- Every call's token usage is measured and logged; `/usage` shows the table.

[SKILL.md](SKILL.md) is the full description of the protocol, files and costs.

# Native pi / committee lifecycle contract

Native session identity owns its room binding. Store a custom `committee-room` entry
containing `{ roomId }`, using `appendEntry`, and read the latest valid binding from
`ctx.sessionManager.getEntries()`. Do not use a global `committee/current` pointer to
choose a resumed pi session's room. Validate the referenced directory exists; missing
rooms are an explicit error/off state, never a silent substitution.

- Fresh startup (`--committee`, no binding): create a new room and new seat sessions.
- Startup with an already resumed pi binding: restore that room, even with the flag.
- `session_start: new`: fresh room if committee was active/explicitly enabled.
- `resume`: restore target session binding; an unbound session is ordinary pi.
- `reload`: preserve binding, do not create a fresh room because the flag persists.
- `fork`: snapshot into an isolated room; do not share mutable logs or native seat
  sessions. If native seat sessions cannot branch, new sessions receive the transcript.

On switching, increment a room generation before stopping old seats. All result,
usage, activity, notification and scheduling callbacks must reject old generations.
Cancel or quiesce work via `session_before_switch`; switching must not wait forever.
Persist/flush old room state before replacing closures. Never close over a mutable
room path and allow an old callback to write through it.

Native /resume displays session.name. Prefix an unnamed committee session with `⚒`;
keep user-provided names. No picker API change is required. `--no-session` cannot
create persistent native resume entries. Restore binding in session_start, after pi
has selected the target; before_switch is for validation and quiescing.

Installed pi has /new and /compact, but no built-in /clear. Proposed /clear aliases
new-session semantics, preserving the previous resumable room; don't redefine it as
merely clearing pixels. This user-visible choice must be documented.

Native /compact compacts pi/Tulip only. Never claim it shrinks external seat CLI
contexts. Committee-wide compaction needs an explicit summary/checkpoint followed
by new seat sessions, retaining original transcripts and summary provenance. Do not
reset cursors before a successful summary, and preserve old sessions on failure.

Tests in lifecycle.test.ts validate only the decision helpers and generation guard.
Integration tests still required: real event ordering, directory persistence,
missing-room error, no late usage/results after switching, native picker display,
reload idempotence, and external-seat compaction behavior.

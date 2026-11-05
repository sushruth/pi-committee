import { titleFrom, roomLabel } from "./title.ts";
import { focusFromText, focusFromQueue } from "./routing.ts";
import { reportedCost } from "./accounting.ts";
import { recapBox, speakerBand } from "./presentation.ts";
import { DiscussionBudget, compactTopic } from "./conversation.ts";
// pi extension: the host for a committee conversation.
//   pi --no-tools --no-mcp --no-skills --no-session --no-extensions --no-context-files --no-prompt-templates \
//      -e ~/.agents/skills/committee-conversation/committee.ts
// Your input never reaches pi's model; it is broadcast to the speakers in
// committee.json (cwd, falls back to example.json) and their replies render as
// messages. State in cwd/committee/: events.jsonl (public log, replayed on start),
// sessions.json (each speaker's native session id + how much transcript it has
// seen, so a restart resumes instead of re-sending), diag.jsonl (failures).
//
// One native session per speaker. It gets the preamble + transcript once, then
// only new events; the CLI's own context/cache holds the rest. Every call's
// token usage is logged as a `usage` event; /usage shows the table.

import { SessionManager, getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, SelectList, Text, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { Speaker, codexModels, modelWindow, opencodeVariants, type Cli, type Tools, type TurnResult } from "./speaker.ts";
import { planRoomStart, roomBinding, RoomGeneration } from "./lifecycle.ts";
import intentionSchema from "./schemas/intention.schema.json";
import responseSchema from "./schemas/response.schema.json";
import deliberationSchema from "./schemas/deliberation.schema.json";

interface Config {
  speakers: Seat[];
  former?: Ghost[];
  etiquette: string;
  /** what every seat should know about this folder: text, or a path to a file (relative to the room, or ~) */
  brief?: string;
  timeoutSeconds?: number;
  /** autonomous rounds per human message before the room stops on its own: a runaway guard, not the normal stop (unset: no limit) */
  /** poll only seats the human message tags (@all asks everyone); off by default */
  tagRouting?: boolean;
  /** per call, for seats with tools (default 600) */
  toolTimeoutSeconds?: number;
}
interface Seat { id: string; cli: Cli; model: string; thinking?: string; persona?: string; tools?: Tools }
// a seat that left the room; its lines stay in the transcript, it stays visible as a pale dot
interface Ghost { id: string; cli: Cli; model: string; thinking?: string; left: string }
type Kind = "human" | "speak" | "error" | "intention" | "deliberation" | "phase" | "usage" | "tool" | "recap";
interface Event { id: string; cycle: number; author: string; text: string; kind: Kind; data?: unknown; roomId?: string }
interface Stat { state: string; since: number; activity?: string; ctx?: number; window?: number; fresh: number; cached: number; out: number; cost: number; calls: number; turns: number; lastSpoke: number; lastIntent?: string; intentStamp?: number; lastReply?: string }
interface Saved { cli: Cli; model: string; thinking?: string; tools?: Tools; session_id?: string; sent: number; rules?: string }
const PUBLIC: Kind[] = ["human", "speak", "error"]; // "tool" events from older logs are history only

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const cfgPath = join(cwd, "committee.json");
  const cfg: Config = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8"))
    : { speakers: [], etiquette: "Be conversational and brief. Silence is welcome. Yield when someone else covers your point. Humans can speak at any time. Nobody schedules turns." };
  const dir = join(cwd, "committee");
  mkdirSync(dir, { recursive: true });
  // one directory per conversation; `current` names the room this run is speaking in
  const roomsDir = join(dir, "rooms");
  mkdirSync(roomsDir, { recursive: true });
  const newRoomId = () => new Date().toISOString().replace(/[:.]/g, "-");
  // migrate a pre-rooms room into rooms/<id>/ so nothing is stranded at the root
  if (existsSync(join(dir, "events.jsonl")) || existsSync(join(dir, "sessions.json"))) {
    const legacy = newRoomId(); mkdirSync(join(roomsDir, legacy), { recursive: true });
    for (const f of ["events.jsonl", "sessions.json"]) { const src = join(dir, f); if (existsSync(src)) renameSync(src, join(roomsDir, legacy, f)); }
    writeFileSync(join(dir, "current"), legacy + "\n");
  }
  let roomId = (() => { try { const v = readFileSync(join(dir, "current"), "utf8").trim(); if (v) return v; } catch {} const v = newRoomId(); mkdirSync(join(roomsDir, v), { recursive: true }); writeFileSync(join(dir, "current"), v + "\n"); return v; })();
  const roomPath = (f: string) => join(roomsDir, roomId, f);
  let logPath = roomPath("events.jsonl");
  const diagPath = join(dir, "diag.jsonl");
  let sessPath = roomPath("sessions.json");
  mkdirSync(join(roomsDir, roomId), { recursive: true });
  const timeoutMs = (cfg.timeoutSeconds ?? 120) * 1000;
  const toolTimeoutMs = (cfg.toolTimeoutSeconds ?? 600) * 1000;
  const budget = (s: { meta: Seat }) => (s.meta.tools ? toolTimeoutMs : timeoutMs);

  // ---- sessions: resume a speaker's native session only if cli+model match what was saved
  const saved: Record<string, Saved> = existsSync(sessPath) ? JSON.parse(readFileSync(sessPath, "utf8")) : {};
  const makeSeat = (meta: Seat) => {
    const seat = makeSeat0(meta);
    modelWindow(meta.cli, meta.model, cwd).then((w) => { seat.stat.window = w || undefined; refresh(); });
    return seat;
  };
  const makeSeat0 = (meta: Seat) => {
    const prev = saved[meta.id];
    const match = prev && prev.cli === meta.cli && prev.model === meta.model && (prev.thinking ?? "") === (meta.thinking ?? "") && (prev.tools ?? "") === (meta.tools ?? "");
    return {
      meta,
      session: new Speaker({ id: meta.id, cli: meta.cli, model: meta.model, thinking: meta.thinking, cwd, session_id: match ? prev.session_id : undefined, tools: meta.tools, onActivity: (t) => { const st = byId(meta.id)?.stat; if (st) { st.activity = t ?? undefined; refresh(); } } }),
      sent: match ? prev.sent : 0,
      rulesSeen: match ? prev.rules : undefined,
      /** public transcript size when this seat was last polled; an unchanged size means nothing new to ask about */
      polledAt: undefined as number | undefined,
      /** transcript cursor of the packet this seat is currently reading; `sent` only advances on success */
      pendingSent: undefined as number | undefined,
      /** true from the moment a call is dispatched until its reply lands: a busy seat is skipped, never overlapped */
      inflight: false,
      stat: { state: "idle", since: Date.now(), fresh: 0, cached: 0, out: 0, cost: 0, calls: 0, turns: 0, lastSpoke: 0 } as Stat,
    };
  };
  for (const s of cfg.speakers) if ((s.tools as unknown) === true) s.tools = "read"; // older configs stored a boolean
  const speakers: ReturnType<typeof makeSeat>[] = [];
  let booted = false;
  const boot = () => {
    if (booted) return; booted = true;
    for (const m of cfg.speakers) speakers.push(makeSeat(m));
    // usage events carry each call's numbers, so totals and the context bar survive a restart
    for (const e of events) if (e.kind === "usage" && e.data) { const d = e.data as any; const st = byId(e.author)?.stat; if (st) { st.calls++; st.fresh += d.fresh ?? 0; st.cached += d.cached ?? 0; st.out += d.out ?? 0; st.cost += reportedCost(d, byId(e.author)?.meta.cli) ?? 0; if (typeof d.ctx === "number") st.ctx = d.ctx; } }
  };
  const former: Ghost[] = cfg.former ?? [];
  const byId = (id: string) => speakers.find((s) => s.meta.id === id);
  const ghostOf = (id: string) => former.find((g) => g.id === id);
  // persona is free text or a path (relative to the room folder, or ~); read when the first packet is built
  const textOrFile = (v?: string) => {
    const p = v?.trim(); if (!p) return "";
    for (const file of [p.replace(/^~(?=\/|$)/, homedir()), join(cwd, p)]) { try { if (existsSync(file)) return readFileSync(file, "utf8").trim(); } catch {} }
    return p;
  };
  const personaOf = (s: Seat) => textOrFile(s.persona);
  const briefOf = () => textOrFile(cfg.brief);
  const retire = (s: (typeof speakers)[number]) => {
    s.session.close(); speakers.splice(speakers.indexOf(s), 1);
    const last = [...events].reverse().find((e) => PUBLIC.includes(e.kind));
    former.push({ id: s.meta.id, cli: s.meta.cli, model: s.meta.model, thinking: s.meta.thinking, left: last?.id ?? "event-0" });
  };
  let busy = false;
  const queued: string[] = [];
  const queuedIds: string[] = [];
  const failedHumans = new Map<string, string>();
  // one dim line per waiting message, in pi's own vocabulary, above the editor
  const drawQueue = (ctx: ExtensionContext) =>
    ctx.ui.setWidget("committee-queue", queued.length ? queued.map((t, i) => `⏳ waiting ${i + 1}: ${t} (already sent)`) : undefined, { placement: "aboveEditor" });
  let paused = false;
  let heldWhilePaused = false;
  const pausedTexts: string[] = [];
  const saveSessions = () => {
    const out: Record<string, Saved> = {};
    for (const s of speakers) out[s.meta.id] = { cli: s.meta.cli, model: s.meta.model, thinking: s.meta.thinking, tools: s.meta.tools, session_id: s.session.session_id, sent: s.sent, rules: s.rulesSeen };
    writeFileSync(sessPath, JSON.stringify(out, null, 2));
  };

  // ---- colors: one fixed identity color per speaker, one per state (256-color ANSI)
  const ansi = (n: number, text: string) => `\x1b[38;5;${n}m${text}\x1b[0m`;
  const palette = [39, 208, 141, 42, 213, 220, 51, 203];
  const colorOf = (id: string) => ghostOf(id) ? 240 : palette[Math.max(0, speakers.findIndex((s) => s.meta.id === id)) % palette.length];
  const tag = (id: string) => ansi(colorOf(id), `● ${id}`);
  // shorthand tags: initials of the id (simply-precise -> @sp); a clash with an earlier seat falls back to a longer form
  const tagOf = (id: string): string => {
    const taken = new Set<string>();
    for (const x of speakers) {
      const parts = x.meta.id.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
      const ini = parts.map((q) => q[0]).join("");
      const pick = [ini, (parts[0]?.slice(0, 2) ?? "") + ini.slice(1), x.meta.id.toLowerCase()].find((c) => c && !taken.has(c)) ?? x.meta.id.toLowerCase();
      taken.add(pick);
      if (x.meta.id === id) return pick;
    }
    return id.toLowerCase();
  };
  // color @tags in transcript text with the tagged seat's identity color
  const highlightTags = (t: string) => t.replace(/@([a-z0-9]+)\b/g, (m, k) => { const x = speakers.find((q) => tagOf(q.meta.id) === k); return x ? ansi(colorOf(x.meta.id), m) : m; });
  const stateColor = (st: string) => st.startsWith("err") ? 196 : st === "thinking" ? 220 : st === "working" || st === "replying" ? 214 : st === "spoke" ? 42 : st === "idle" ? 244 : 250;
  const glyph = (st: string) => st === "idle" ? "·" : st.startsWith("err") ? "✗" : st === "thinking" ? "◌" : st === "working" ? "⚙" : st === "replying" ? "●" : st === "spoke" ? "✓" : "○";
  const fmt = (n: number) => (n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`);

  // ---- public state (append-only; replayed from disk on start)
  const events: Event[] = [];
  let cycleNo = 0;
  let floorHolder: string | null = null;
  const currentRoomTitle = () => titleFrom(events.find((e) => e.kind === "human")?.text ?? "");
  let liveRecap = "";
  let recapStatus: "discussing" | "finished" = "discussing";
  let recapAfter = "";
  const record = (ev: Event) => {
    const previous = ev.kind === "deliberation" ? events.find((e) => e.id === ev.id) : undefined;
    if (previous) Object.assign(previous, ev);
    else events.push(ev);
    if (ev.kind === "speak") { const st = byId(ev.author)?.stat; if (st) { st.turns++; st.lastSpoke = ev.cycle; } floorHolder = ev.author; }
    if (ev.kind === "human") { cycleNo = ev.cycle; recapAfter = ev.id; liveRecap = ""; recapStatus = "discussing"; }
    const d = ev.data as { recap?: string; recapAfter?: string } | undefined;
    if ((ev.kind === "speak" || ev.kind === "deliberation") && typeof d?.recap === "string" && d.recapAfter === recapAfter) liveRecap = d.recap;
  };
  // one real pi session per room, so the room shows up in pi's native /resume list and carries the conversation
  let roomSession: SessionManager | undefined;
  let activeCtx: ExtensionContext | undefined;
  const mirrorFile = () => roomPath("pi-session");
  // no writer of our own caches a tree: we open the file fresh, append one message, and drop the manager.
  // This does not make us the only writer. After pi natively resumes one of these files, pi's own
  // session manager holds it too, and its cached leaf will not see what we append here (and vice
  // versa) until it reloads. Unknown: whether that shows up as a lost branch in practice.
  const mirror = (text: string) => {
    roomSession = undefined;
    try {
      let saved: string | undefined;
      try { saved = readFileSync(mirrorFile(), "utf8").trim() || undefined; } catch {}
      // if pi is already writing this same file, leave it alone rather than race it
      const piFile = activeCtx?.sessionManager?.getSessionFile?.();
      const fresh = !(saved && existsSync(saved));
      if (piFile && saved && piFile === saved) return;
      roomSession = fresh ? SessionManager.create(cwd, undefined, { id: roomId }) : SessionManager.open(saved!, undefined, cwd);
      const name = roomSession.getSessionName();
      if (!name || name.startsWith("⚒ ")) roomSession.appendSessionInfo(`⚒ ${currentRoomTitle()}`);
      // lifecycle.roomBinding looks for exactly this entry on resume; without it the room is listed but never reattaches
      if (fresh) roomSession.appendCustomEntry("committee-room", { roomId });
      roomSession.appendMessage({ role: "user", content: text, timestamp: Date.now() });
      const f = roomSession.getSessionFile();
      if (f) writeFileSync(mirrorFile(), f + "\n");
    } catch (e) { appendFileSync(diagPath, JSON.stringify({ ts: Date.now(), phase: "mirror", error: String(e) }) + "\n"); }
    roomSession = undefined;
  };
  const displayEvent = (ev: Event) => pi.sendMessage({ customType: "committee", content: ev.text, display: true, details: { ...ev, roomId } });
  const publish = (e: Omit<Event, "id" | "cycle">) => {
    const ev: Event = { id: `event-${events.length + 1}`, cycle: cycleNo, ...e };
    record(ev);
    appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
    // PUBLIC decides what reaches a seat's delta; display is a separate question. A deliberation
    // round is shown to the human and never sent to seats, so it gets its own display path.
    if (PUBLIC.includes(ev.kind) || ev.kind === "deliberation" || ev.kind === "phase" || ev.kind === "recap") displayEvent(ev);
    if (ev.kind === "human") mirror(ev.text);
    return ev;
  };
  const diag = (r: TurnResult, phase: string) => appendFileSync(diagPath, JSON.stringify({ ts: Date.now(), phase, speaker: r.speaker, error: r.error, raw: r.raw }) + "\n");
  if (existsSync(logPath)) {
    let c = 0;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.kind === "human") c++;
      record({ id: e.id, cycle: e.cycle ?? c, author: e.author, text: e.text, kind: e.kind, data: e.data });
    }
  }
  recapStatus = "finished";

  // ---- usage: exact per call, logged and accumulated
  const account = (r: TurnResult, phase: string) => {
    const s = byId(r.speaker); if (!s) return;
    s.stat.calls++;
    if (r.usage) { s.stat.fresh += r.usage.fresh; s.stat.cached += r.usage.cached; s.stat.out += r.usage.out; s.stat.cost += reportedCost(r.usage, s.meta.cli) ?? 0;
      if (typeof r.usage.ctx === "number") s.stat.ctx = r.usage.ctx; }
    publish({ author: r.speaker, kind: "usage", text: `${phase}: fresh ${r.usage?.fresh ?? "?"} cached ${r.usage?.cached ?? "?"} out ${r.usage?.out ?? "?"}${r.usage?.cost != null ? ` $${r.usage.cost.toFixed(4)}` : ""}${r.resumed ? " (resumed)" : ""}`, data: { phase, ...r.usage, cli: s.meta.cli, resumed: r.resumed, ok: r.ok } });
  };

  // ---- UI: compact status line by default, /usage toggles the table; footer = totals
  let ui: ExtensionContext["ui"] | undefined;
  let showTable = false;
  const col = (t: string, w: number, right = false) => { const p = " ".repeat(Math.max(0, w - visibleWidth(t))); return right ? p + t : t + p; };
  let openSeat: string | null = null;
  let widgetTui: { requestRender(): void } | undefined;
  const seatMeta = (s: Seat) => `${s.cli}:${s.model.split("/").pop()}${s.thinking ? " #" + s.thinking : ""}${s.tools === "all" ? " ⚙⚙" : s.tools ? " ⚙" : ""}`;
  const SEP = ` ${ansi(240, "·")} `;
  const GAP = 3; // visible width of SEP
  const ABOUT = "(⚒)"; // openSeat value when the logo panel is open
  const LOGO = () => ansi(openSeat === ABOUT ? 250 : 244, ABOUT) + "  ";
  const initials = (id: string) => id.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 3);
  const seatCell = (s: (typeof speakers)[number]) => {
    // ○ normally, ◉ when this seat's panel is open: same glyph family, same size, concentric
    const dot = openSeat === s.meta.id ? "◍" : "◯";
    const live = BUSY.has(s.stat.state) ? (s.stat.activity ? `⚙ ${s.stat.activity.split(" ")[0]}` : s.stat.state) + " " + elapsed(Date.now() - s.stat.since) : s.stat.state;
    return `${ansi(colorOf(s.meta.id), dot + " " + initials(s.meta.id))} ${ansi(stateColor(s.stat.state), live)}`;
  };
  const ghostCell = (g: Ghost) => ansi(240, `${openSeat === g.id ? "◍" : "◌"} ${initials(g.id)} gone`);
  const cells = () => [...speakers.map((s) => ({ id: s.meta.id, text: seatCell(s) })), ...former.map((g) => ({ id: g.id, text: ghostCell(g) }))];
  const statusLines = () => [LOGO() + cells().map((c) => c.text).join(SEP)];
  // panel for the clicked seat: full identity in the title, then state, last intention, last reply;
  // its bottom border opens over that seat's dot so the two read as one piece
  // Latest provider-reported input context, not cumulative tokens billed across calls.
  const contextUsage = (st: Stat) => `${st.ctx == null ? "?" : fmt(st.ctx)} / ${st.window ? fmt(st.window) : "?"}${st.ctx != null && st.window ? ` (${Math.round(st.ctx / st.window * 100)}%)` : ""}`;
  const detailLines = (width: number) => {
    const inner = Math.max(20, width - 4);
    const dim = (t: string) => ansi(244, t);
    const frame = (title: string, body: string[]) => {
      const t = truncateToWidth(title, Math.max(10, width - 4));
      const top = dim("╭─" + t + "─".repeat(Math.max(0, width - 3 - visibleWidth(t))) + "╮");
      const bottom = dim("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
      return [top, ...body.map((l) => `${dim("│")} ${l}${" ".repeat(Math.max(0, inner - visibleWidth(l)))} ${dim("│")}`), bottom];
    };
    if (openSeat === COST) {
      const total = speakers.reduce((a, s) => a + s.stat.cost, 0);
      const row = (s: (typeof speakers)[number]) => wrapTextWithAnsi(`${ansi(colorOf(s.meta.id), s.meta.id.padEnd(20))}${col(`$${s.stat.cost.toFixed(3)}`, 9, true)}${col(total ? `${Math.round((s.stat.cost / total) * 100)}%` : "", 6, true)}${col(`${s.stat.calls} calls`, 11, true)}${col(`ctx ${contextUsage(s.stat)}`, 25, true)}  ${dim(seatMeta(s.meta))}`, inner);
      const phases = new Map<string, { cost: number; calls: number; reported: number }>();
      for (const ev of events) {
        if (ev.kind !== "usage" || !byId(ev.author)) continue;
        const usage = ev.data as { phase?: string; cost?: number; costScope?: string; cli?: string } | undefined;
        const phase = usage?.phase ?? "other";
        const entry = phases.get(phase) ?? { cost: 0, calls: 0, reported: 0 };
        entry.calls++;
        const cost = reportedCost(usage, byId(ev.author)?.meta.cli);
        if (cost != null) { entry.cost += cost; entry.reported++; }
        phases.set(phase, entry);
      }
      const seatRows = [...speakers].sort((a, b) => b.stat.cost - a.stat.cost).flatMap((s) => [
        ...row(s),
        ...wrapTextWithAnsi(dim(`  cumulative billed tokens: ${fmt(s.stat.fresh)} fresh input · ${fmt(s.stat.cached)} cached input · ${fmt(s.stat.out)} output`), inner),
      ]);
      const phaseRows = [...phases].flatMap(([phase, entry]) => wrapTextWithAnsi(
        `${phase}: $${entry.cost.toFixed(4)} · ${entry.calls} calls · cost reported for ${entry.reported}/${entry.calls}`, inner));
      return frame(` cost · $${total.toFixed(3)} `, [...seatRows, ...phaseRows,
        ...wrapTextWithAnsi(dim("cost as the providers report it; missing costs and unverified legacy Claude costs are excluded, not free. Claude totals cover corrected calls only. Context = latest reported input / window, not a live meter. Billed tokens accumulate across calls; they are not a dollar-price breakdown."), inner)]);
    }
    if (openSeat === ABOUT) {
      const t = speakers.reduce((a, s) => ({ fresh: a.fresh + s.stat.fresh, cached: a.cached + s.stat.cached, out: a.out + s.stat.out, calls: a.calls + s.stat.calls, cost: a.cost + s.stat.cost }), { fresh: 0, cached: 0, out: 0, calls: 0, cost: 0 });
      const pub = events.filter((e) => PUBLIC.includes(e.kind));
      const row = (label: string, text: string) => wrapTextWithAnsi(`${ansi(250, label.padEnd(10))}${text}`, inner);
      return frame(" pi-committee ", [
        ...row("what", "a room of independent LLM speakers; each states an intention, sees the others', and decides for itself whether to speak. No facilitator."),
        ...row("room", cwd),
        ...row("seats", `${speakers.length} live${former.length ? `, ${former.length} former` : ""} · ${cfg.etiquette}`),
        ...row("so far", `cycle ${cycleNo} · ${pub.length} messages · ${t.calls} calls`),
        ...speakers.flatMap((s) => row("context", `${s.meta.id}: ${contextUsage(s.stat)}`)),
        ...row("cost", t.cost ? `$${t.cost.toFixed(3)} (providers that report it)` : "not reported by these providers"),
        ...row("source", "github.com/sushruth/pi-committee · /committee · /seats · /usage"),
      ]);
    }
    const s = openSeat ? byId(openSeat) : undefined;
    const g = openSeat && !s ? ghostOf(openSeat) : undefined;
    if (!s && !g) return [];
    const row = (label: string, text: string) => wrapTextWithAnsi(`${ansi(colorOf(openSeat!), label.padEnd(10))}${text}`, inner);
    const body = s
      ? [...row("state", `${glyph(s.stat.state)} ${s.stat.state}${BUSY.has(s.stat.state) ? " " + elapsed(Date.now() - s.stat.since) : ""}`), ...(s.stat.activity ? row("now", `⚙ ${s.stat.activity}`) : []), ...row("intention", s.stat.lastIntent ?? "(none yet)"), ...row("reply", s.stat.lastReply ?? "(none yet)")]
      : [...row("state", `◌ gone, left after ${g!.left}`), ...row("was", seatMeta(g!))];
    const m = s?.meta ?? g!;
    return frame(` ${m.id} · ${m.cli}:${m.model} ${m.thinking ? "#" + m.thinking + " " : ""}`, body);
  };
  const widgetFactory = (tui: { requestRender(): void }) => {
    widgetTui = tui;
    return {
      invalidate() {},
      render(width: number) { tick(); return [...detailLines(width), ...statusLines().map((l) => truncateToWidth(l, width))]; },
      handleMouse(ev: { type: string; button: string; x: number; y: number; height: number }) {
        if (ev.type !== "click" || ev.button !== "left" || ev.y !== ev.height - 1) return;
        // which seat sits under x on the status line
        if (ev.x < 3) { openSeat = openSeat === ABOUT ? null : ABOUT; tui.requestRender(); return { handled: true }; }
        let x = 5; // after the logo
        for (const c of cells()) {
          const w = visibleWidth(c.text);
          if (ev.x >= x && ev.x < x + w) { openSeat = openSeat === c.id ? null : c.id; tui.requestRender(); return { handled: true }; }
          x += w + GAP;
        }
        return { handled: true };
      },
    };
  };
  let delibTicker: ReturnType<typeof setInterval> | undefined;
  let delibActive = false; // true only while the hidden exchange is running: the phase belongs to the room, not to a seat
  const expandedDeliberations = new Set<string>();
  const drawRecap = () => {
    if (!ui) return;
    ui.setWidget("committee-recap", active && liveRecap ? (_tui, theme) => ({
      invalidate() {},
      render: (width: number) => recapBox(theme, liveRecap, width, `since your last message · ${recapStatus === "finished" ? "finished" : "still discussing"}`),
    }) : undefined, { placement: "aboveEditor" });
  };
  const drawDeliberating = () => {
    if (!ui) return;
    ui.setWidget("committee-deliberating", undefined);
    if (!delibActive) {
      if (delibTicker) { clearInterval(delibTicker); delibTicker = undefined; }
      return;
    }
    if (!delibTicker) delibTicker = setInterval(() => widgetTui?.requestRender(), 1000);
  };
  const refresh = () => {
    drawDeliberating();
    drawRecap();
    if (!showTable) { if (widgetTui) widgetTui.requestRender(); else ui?.setWidget("committee", widgetFactory as any); return; }
    const idW = Math.max(...speakers.map((s) => s.meta.id.length)) + 2;
    const short = (s: (typeof speakers)[number]) => `${s.meta.cli}:${s.meta.model.split("/").pop()}`;
    const modelW = Math.min(24, Math.max(...speakers.map((s) => short(s).length)));
    const dim = (t: string) => ansi(244, t);
    const header = `${col("", idW)} ${col(dim("cli/model"), modelW)} ${col(dim("calls"), 6, true)} ${col(dim("context / window"), 25, true)} ${col(dim("$"), 8, true)}  ${dim("state")}`;
    const rows = speakers.map((s) => `${col(tag(s.meta.id), idW)} ${col(dim(truncateToWidth(short(s), modelW)), modelW)} ${col(String(s.stat.calls), 6, true)} ${col(contextUsage(s.stat), 25, true)} ${col(s.stat.cost ? s.stat.cost.toFixed(3) : dim("n/a"), 8, true)}  ${ansi(stateColor(s.stat.state), `${glyph(s.stat.state)} ${s.stat.state}`)}`);
    widgetTui = undefined;
    ui?.setWidget("committee", [header, ...rows]);
  };
  // one bar for the whole room: each seat's used context as a slice of the summed windows, in the seat's color; the rest dim
  const contextBar = (cells: number, total: number) => {
    if (!total) return "";
    let out = "", filled = 0;
    for (const s of speakers) {
      const n = Math.round(((s.stat.ctx ?? 0) / total) * cells);
      if (n > 0) { out += ansi(colorOf(s.meta.id), "█".repeat(n)); filled += n; }
    }
    return out + ansi(238, "░".repeat(Math.max(0, cells - filled)));
  };
  // always full: each seat's share of the room's cost, in its color
  const COST = "$";
  const costBar = (cells: number, total: number) => {
    if (!total) return ansi(238, "░".repeat(cells));
    let out = "", filled = 0;
    const shares = speakers.map((s) => ({ s, n: Math.floor((s.stat.cost / total) * cells) }));
    // hand the rounding remainder to the biggest spender so the bar is always full
    const top = shares.reduce((a, b) => (b.s.stat.cost > a.s.stat.cost ? b : a), shares[0]);
    if (top) top.n += cells - shares.reduce((a, b) => a + b.n, 0);
    for (const { s, n } of shares) if (n > 0) { out += ansi(colorOf(s.meta.id), "█".repeat(n)); filled += n; }
    return out + ansi(238, "░".repeat(Math.max(0, cells - filled)));
  };
  const setState = (id: string, state: string) => { const s = byId(id); if (s && s.stat.state !== state) { s.stat.state = state; s.stat.since = Date.now(); if (!BUSY.has(state)) s.stat.activity = undefined; } refresh(); };
  const BUSY = new Set(["thinking", "working", "replying"]);
  const elapsed = (ms: number) => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; };
  // the clock in the seat cells ticks while anyone is busy
  let ticker: ReturnType<typeof setInterval> | undefined;
  const tick = () => { const anyBusy = speakers.some((s) => BUSY.has(s.stat.state)); if (anyBusy && !ticker) ticker = setInterval(() => widgetTui?.requestRender(), 1000); if (!anyBusy && ticker) { clearInterval(ticker); ticker = undefined; } };

  // ---- a folder that already has a committee gets one clickable line above the editor
  // instead of a toast you can miss. ✕ remembers "not now" in committee/ui.json (gitignored with
  // the rest of committee/); the flag is only read here, never written to the shared committee.json.
  const hintPath = join(dir, "ui.json");
  const hintDismissed = () => { try { const j = JSON.parse(readFileSync(hintPath, "utf8")); return j.dismissed === true || j.hintDismissed === true; } catch { return false; } };
  // turning the room on, shared by /committee on and the hint's click
  let enableMode: (ctx: ExtensionContext) => Promise<void> = async () => {};
  const showHint = (ctx: ExtensionContext) => {
    if (!existsSync(cfgPath) || hintDismissed()) return false;
    const n = events.filter((e) => PUBLIC.includes(e.kind)).length;
    const label = `⚒ committee used here · ${cfg.speakers.length} seats, ${n} msgs — click to turn on`;
    const clear = () => ctx.ui.setWidget("committee-hint", undefined);
    ctx.ui.setWidget("committee-hint", (_tui, theme) => ({
      dispose() {}, invalidate() {},
      handleMouse(ev: { type: string; button: string; x: number; width: number }) {
        if (ev.type !== "click" || ev.button !== "left") return;
        clear();
        if (ev.x >= ev.width - 2) { try { writeFileSync(hintPath, JSON.stringify({ dismissed: true }, null, 2)); } catch {} return { handled: true }; }
        void enableMode(ctx);
        return { handled: true };
      },
      render(width: number) {
        const room = Math.max(0, width - visibleWidth(label) - 2);
        return [truncateToWidth(theme.fg("dim", label) + " ".repeat(room) + theme.fg("dim", "✕"), width)];
      },
    }), { placement: "aboveEditor" });
    return true;
  };

  pi.registerFlag("committee", { description: "start with committee mode on (resumes this folder's room)", type: "boolean", default: false });
  pi.on("session_start", async (_e, ctx) => {
    ui = ctx.ui;
    footerFactory = (_tui, theme) => ({
      dispose() {}, invalidate() {},
      handleMouse(ev: { type: string; button: string }) {
        if (ev.type !== "click" || ev.button !== "left") return;
        openSeat = openSeat === COST ? null : COST; refresh();
        return { handled: true };
      },
      render(width: number) {
        const t = speakers.reduce((a, s) => ({ used: a.used + (s.stat.ctx ?? 0), window: a.window + (s.stat.window ?? 0), cost: a.cost + s.stat.cost, calls: a.calls + s.stat.calls }), { used: 0, window: 0, cost: 0, calls: 0 });
        const left = theme.fg("dim", `⚒ ${speakers.length} seats · cycle ${cycleNo} · ${t.calls} calls · $${t.cost.toFixed(2)} `) + costBar(12, t.cost) + theme.fg("dim", ` · context ${fmt(t.used)} / ${t.window ? fmt(t.window) : "?"} `);
        return [truncateToWidth(left + contextBar(Math.max(10, Math.min(40, width - visibleWidth(left) - 1)), t.window), width)];
      },
    });
    // what this pi session is: a new one gets a fresh room when --committee is set; a resumed or reloaded one goes back to the room it was bound to
    const bound = roomBinding((ctx.sessionManager?.getEntries?.() ?? []) as any);
    const plan = planRoomStart(_e.reason, pi.getFlag("committee") === true, bound && existsSync(join(roomsDir, bound)) ? bound : undefined);
    if (plan.kind === "restore") { if (plan.roomId !== roomId) switchRoom(plan.roomId); await enableMode(ctx); return; }
    if (plan.kind === "fork") {
      // a fork keeps the transcript but not the seats' memory: copy events only into a new room
      const src = join(roomsDir, plan.sourceRoomId, "events.jsonl"), id = newRoomId();
      mkdirSync(join(roomsDir, id), { recursive: true });
      if (existsSync(src)) writeFileSync(join(roomsDir, id, "events.jsonl"), readFileSync(src, "utf8"));
      switchRoom(id); await enableMode(ctx); return;
    }
    if (plan.kind === "fresh") { freshRoom(); await enableMode(ctx); return; }
    // pi starts as plain pi; a folder that has a committee gets the clickable hint instead of a toast
    if (showHint(ctx)) return;
    ctx.ui.notify(cfg.speakers.length ? "committee: /committee on to turn it on" : "committee: no seats in this folder yet · /committee on to set up", "info");
  });
  // first time the room is switched on this run: check the CLIs, show the transcript, say which sessions resume
  let shown = false;
  const show = async (ctx: ExtensionContext) => {
    boot();
    if (shown) return; shown = true;
    if (speakers.length) await checkEngines(ctx);
    const entries = ctx.sessionManager.getBranch();
    const displayed = entries.filter((e) => e.type === "custom_message" && e.customType === "committee" && e.display).map((e) => (e as { details?: Event }).details);
    for (const ev of events) {
      if (!(PUBLIC.includes(ev.kind) || ev.kind === "deliberation" || ev.kind === "phase" || ev.kind === "recap")) continue;
      if (displayed.some((d) => d?.id === ev.id && (d.roomId ? d.roomId === roomId : d.kind === ev.kind && d.author === ev.author && d.text === ev.text))) continue;
      displayEvent(ev);
    }
    const resumed = speakers.filter((s) => s.sent > 0).map((s) => s.meta.id);
    if (events.length) ctx.ui.notify(`replayed ${events.filter((e) => PUBLIC.includes(e.kind)).length} messages; resuming sessions for ${resumed.length ? resumed.join(", ") : "nobody"}`, "info");
  };

  pi.registerCommand("queue", {
    description: "List messages waiting for a seat to free up (they are already in the room; they cannot be cancelled)",
    handler: async (args, ctx) => {
      const a = (args ?? "").trim();
      if (!queued.length) return ctx.ui.notify("nothing waiting: no message is held back", "info");
      if (a === "clear" || a.startsWith("drop")) return ctx.ui.notify("cannot cancel: the message is already in the room and the seats will read it. Use /clear to drop it from view.", "warning");
      ctx.ui.notify(`waiting for a free seat (already in the room):\n${queued.map((t, i) => `${i + 1}. ${t.slice(0, 80)}`).join("\n")}`, "info");
    },
  });

  pi.registerCommand("usage", {
    description: "Toggle the per-speaker token usage table above the editor",
    handler: async () => { showTable = !showTable; refresh(); },
  });

  const run = (cmd: string, args: string[]) => new Promise<string>((res) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (_e, out) => res(String(out ?? ""))));
  const modelsFor = async (cli: Cli): Promise<string[]> => {
    if (cli === "claude") return ["opus", "sonnet", "haiku"];
    if (cli === "codex") return codexModels(cwd).map((m: any) => m.slug).filter(Boolean);
    if (cli === "pi") return (await run("pi", ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--list-models"])).split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length > 1).map((p) => `${p[0]}/${p[1]}`);
    return (await run("opencode", ["models"])).split("\n").map((l) => l.trim()).filter((l) => l.includes("/"));
  };
  // combo box: fuzzy filter as you type (pi-tui's fuzzyFilter, tokens split on space and slash), arrows to move, enter picks, esc cancels.
  // SelectList has no setItems, so the list is rebuilt on every keystroke from the fuzzy result.
  const combo = (ctx: ExtensionContext, title: string, items: string[]) => ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
    let query = "";
    const head = new Text(theme.fg("accent", title), 0, 0);
    const line = new Text("", 0, 0);
    const foot = new Text(theme.fg("dim", "type to fuzzy-filter · ↑↓ move · enter pick · esc cancel"), 0, 0);
    const listTheme = {
      selectedPrefix: (t: string) => theme.fg("accent", t), selectedText: (t: string) => theme.fg("accent", t),
      description: (t: string) => theme.fg("muted", t), scrollInfo: (t: string) => theme.fg("dim", t), noMatch: (t: string) => theme.fg("warning", t),
    };
    let list: SelectList;
    const draw = () => {
      const hits = query ? fuzzyFilter(items, query, (m) => m) : items;
      list = new SelectList(hits.map((value) => ({ value, label: value })), Math.min(Math.max(hits.length, 1), 12), listTheme);
      list.onSelect = (item) => done(item.value);
      list.onCancel = () => done(null);
      line.setText(`${theme.fg("dim", "filter: ")}${query}${theme.fg("dim", "▏")}  ${theme.fg("dim", `${hits.length}/${items.length}`)}`);
      tui.requestRender();
    };
    draw();
    return {
      render: (w: number) => [...head.render(w), ...line.render(w), ...list.render(w), ...foot.render(w)],
      invalidate() { head.invalidate(); line.invalidate(); list.invalidate(); foot.invalidate(); },
      handleInput(data: string) {
        if (matchesKey(data, "escape")) return done(null);
        if (matchesKey(data, "backspace")) { query = query.slice(0, -1); return draw(); }
        if (data.length === 1 && data >= " " && data !== "\x7f") { query += data; return draw(); }
        list.handleInput(data); tui.requestRender();
      },
    };
  });
  const pickModel = async (ctx: ExtensionContext, cli: Cli, current?: string) => {
    const list = await modelsFor(cli);
    if (!list.length) return (await ctx.ui.input("Model (no list available for " + cli + ")", current ?? ""))?.trim();
    const r = await combo(ctx, `Pick a ${cli} model (${list.length} available)`, current ? [current, ...list.filter((m) => m !== current)] : list);
    return r ?? undefined;
  };
  // effort ladders the CLIs accept; a model may reject some (the next call then shows an error)
  const DEFAULT = "(model default)";
  const thinkingFor = (cli: Cli) => cli === "claude" ? ["low", "medium", "high", "xhigh", "max"] : cli === "codex" ? ["minimal", "low", "medium", "high", "xhigh"] : cli === "opencode" ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"] : cli === "pi" ? ["off", "minimal", "low", "medium", "high", "xhigh", "max"] : [];
  const pickThinking = async (ctx: ExtensionContext, cli: Cli, current?: string, model?: string) => {
    // opencode variants differ per model; the live list beats the generic ladder
    const codexLevels = cli === "codex" ? (codexModels(cwd).find((m: any) => m.slug === model)?.supported_reasoning_levels ?? []).map((l: any) => l.effort) : [];
    const list = cli === "opencode" && model ? (await opencodeVariants(cwd, model)).concat() : codexLevels.length ? codexLevels : thinkingFor(cli);
    if (cli === "opencode" && model && !list.length) ctx.ui.notify("opencode lists no variants for this model; the generic ladder is shown, the model may reject some", "warning");
    if (cli === "opencode" && !list.length) list.push(...thinkingFor(cli));
    const v = await ctx.ui.select(`Thinking (${cli})`, [current ?? DEFAULT, ...[DEFAULT, ...list].filter((x) => x !== (current ?? DEFAULT))]);
    return v === undefined ? undefined : v === DEFAULT ? "" : v;
  };
  const seatsPath = join(cwd, "committee.json");
  const saveSeats = () => { if (booted) cfg.speakers = speakers.map((s) => s.meta); cfg.former = former; writeFileSync(seatsPath, JSON.stringify(cfg, null, 2) + "\n"); saveSessions(); refresh(); };
  const seatLine = (s: Seat) => `${s.id}: ${s.cli} ${s.model}${s.thinking ? ` #${s.thinking}` : ""}${s.tools === "all" ? " ⚙⚙" : s.tools ? " ⚙" : ""}`;
  let active = false;
  let footerFactory: Parameters<ExtensionContext["ui"]["setFooter"]>[0] | undefined;
  const applyMode = (ctx: ExtensionContext) => {
    if (active) { ctx.ui.setWidget("committee-hint", undefined); ctx.ui.setFooter(footerFactory); refresh(); ctx.ui.setStatus("committee", "idle"); }
    else { ctx.ui.setFooter(undefined); widgetTui = undefined; ctx.ui.setWidget("committee", undefined); ctx.ui.setStatus("committee", undefined); }
    drawRecap();
  };
  // one path for turning the room on: /committee on, and a click on the hint
  enableMode = async (ctx: ExtensionContext) => {
    activeCtx = ctx;
    if (!active && speakers.length === 0 && !(await onboarding(ctx))) return ctx.ui.notify("no seats, committee stays off", "warning");
    // make this pi session findable in the native /resume list, and remember which room it belongs to
    try {
      const name = pi.getSessionName();
      if (!name || name.startsWith("⚒ ")) pi.setSessionName(`⚒ ${currentRoomTitle()}`);
      pi.appendEntry("committee-room", { roomId });
    } catch {}
    await show(ctx);
    active = true; applyMode(ctx);
    ctx.ui.notify("committee mode on", "info");
  };
  // ---- onboarding: which CLIs exist, which are worth using, then one seat at a time
  const CLI_NOTE: Record<Cli, string> = {
    opencode: "recommended · any provider you are logged into, ~100 fresh tokens per call",
    claude: "recommended · ~1.5k tokens per call with the committee flags",
    pi: "recommended · any provider pi is logged into, its own prompt replaced",
    codex: "recommended · ~2.4k tokens per call with the committee config, ~200 fresh",
  };
  const SUPPORTED: Cli[] = ["opencode", "claude", "pi", "codex"];
  const installed = async (): Promise<Cli[]> => {
    const out: Cli[] = [];
    for (const cli of ["claude", "codex", "opencode", "pi"] as Cli[]) if ((await run("which", [cli])).trim()) out.push(cli);
    return out;
  };
  const ADVERBS = ["quietly", "simply", "boldly", "oddly", "nearly", "mostly", "barely", "wildly", "gently", "sharply", "plainly", "slowly", "briskly", "warmly", "coolly", "deeply"];
  const ADJECTIVES = ["excellent", "exhausted", "curious", "stubborn", "cheerful", "skeptical", "patient", "restless", "precise", "hungry", "sleepy", "fearless", "honest", "nervous", "tidy", "grumpy"];
  // a new name shares no word and no initials with any seat in the room, live or former, so the status row stays readable
  const randomName = () => {
    const p = (a: string[]) => a[Math.floor(Math.random() * a.length)];
    const taken = [...speakers.map((s) => s.meta.id), ...former.map((g) => g.id)];
    const words = new Set(taken.flatMap((id) => id.split("-")));
    const inits = new Set(taken.map(initials));
    for (let i = 0; i < 200; i++) {
      const adv = p(ADVERBS), adj = p(ADJECTIVES), n = `${adv}-${adj}`;
      if (!words.has(adv) && !words.has(adj) && !inits.has(initials(n))) return n;
    }
    return `${p(ADVERBS)}-${p(ADJECTIVES)}-${speakers.length + former.length + 1}`;
  };
  const cliLabel = (cli: Cli) => SUPPORTED.includes(cli) ? `${cli}  ${ansi(244, CLI_NOTE[cli])}` : ansi(240, `${cli}  ${CLI_NOTE[cli]}`);
  const TOOL_CHOICES: [string, Tools | undefined][] = [["none", undefined], ["read-only: read, grep, glob, shell", "read"], ["everything the CLI has, writes included", "all"]];
  const pickTools = async (ctx: ExtensionContext, current?: Tools): Promise<Tools | undefined | null> => {
    const labels = TOOL_CHOICES.map(([l]) => l);
    const cur = TOOL_CHOICES.find(([, v]) => v === current)?.[0];
    const t = await ctx.ui.select("Tools for this seat?", cur ? [cur, ...labels.filter((l) => l !== cur)] : labels);
    if (t === undefined) return null;
    return TOOL_CHOICES.find(([l]) => l === t)![1];
  };
  const pickEngine = async (ctx: ExtensionContext, clis: Cli[]): Promise<Pick<Seat, "cli" | "model" | "thinking" | "tools"> | undefined> => {
    const pick = await ctx.ui.select("Which CLI runs this seat?", clis.map(cliLabel));
    if (!pick) return;
    const cli = clis[clis.map(cliLabel).indexOf(pick)];
    if (!SUPPORTED.includes(cli)) { ctx.ui.notify(`${cli} is not supported yet: ${CLI_NOTE[cli]}`, "warning"); return pickEngine(ctx, clis); }
    const model = await pickModel(ctx, cli);
    if (!model) return;
    const thinking = (await pickThinking(ctx, cli, undefined, model)) || undefined;
    const tools = await pickTools(ctx);
    if (tools === null) return;
    return { cli, model, thinking, tools };
  };
  const addSeatFlow = async (ctx: ExtensionContext): Promise<boolean> => {
    boot();
    const engine = await pickEngine(ctx, await installed());
    if (!engine) return false;
    const suggested = randomName();
    const id = (await ctx.ui.input(`Name this seat (optional, picked for you: ${suggested})`, suggested))?.trim() || suggested;
    if (byId(id) || ghostOf(id)) { ctx.ui.notify("that name is taken", "warning"); return false; }
    const persona = (await ctx.ui.input("Persona (optional: a description, or a path to a file with one)", ""))?.trim() || undefined;
    speakers.push(makeSeat({ id, ...engine, persona }));
    saveSeats();
    ctx.ui.notify(`seat ${id}: ${engine.cli} ${engine.model}${engine.thinking ? " #" + engine.thinking : ""}`, "info");
    return true;
  };
  // a shared committee.json may name a CLI this machine lacks: remap the seat or let it go
  const checkEngines = async (ctx: ExtensionContext) => {
    const have = await installed();
    let changed = false;
    for (const s of [...speakers]) {
      if (have.includes(s.meta.cli)) continue;
      const pick = await ctx.ui.select(`Seat ${s.meta.id} needs ${s.meta.cli}, which is not installed here`, ["just start without it", "remap it to another CLI"]);
      const engine = pick === "remap it to another CLI" ? await pickEngine(ctx, have) : undefined;
      if (engine) { s.session.close(); Object.assign(s, makeSeat({ ...s.meta, ...engine })); }
      else retire(s);
      changed = true;
    }
    if (changed) saveSeats();
  };
  const onboarding = async (ctx: ExtensionContext) => {
    const clis = await installed();
    ctx.ui.notify(`committee setup · CLIs found: ${clis.join(", ") || "none"}`, "info");
    if (!clis.length) return false;
    while (true) {
      if (!(await addSeatFlow(ctx))) break;
      const more = await ctx.ui.select(`${speakers.length} seat${speakers.length === 1 ? "" : "s"} so far`, ["add another seat", "done"]);
      if (more !== "add another seat") break;
    }
    if (speakers.length) {
      const b = (await ctx.ui.input("Room brief (optional): what seats should know about this folder, as text or a file path", ""))?.trim();
      if (b) cfg.brief = b;
      saveSeats();
    }
    return speakers.length > 0;
  };

  const pause = (ctx: ExtensionContext) => {
    if (!active) return;
    paused = true; ctx.ui.setStatus("committee", busy ? "pausing after this phase" : "paused");
    ctx.ui.notify(busy ? "pausing: calls in flight finish, then nothing new starts · /committee resume" : "paused: your messages are logged, nobody answers until /committee resume", "info");
  };
  // alt+p pauses; resume is manual. escape is out: pi reserves it for interrupt and select-cancel
  pi.registerShortcut("alt+p", { description: "committee: pause the seats", handler: (ctx) => pause(ctx) });
  // ---- one directory per conversation; switching never deletes anything
  /** move the room this run is speaking in, loading its log and its seat sessions */
  const roomGen = new RoomGeneration(); // a reply that started in another room is dropped, never published into this one
  const switchRoom = (id: string) => {
    roomGen.advance(); pendingReplies = 0; busy = false; ongoing = undefined; roundPending = false; queued.length = 0; queuedIds.length = 0; failedHumans.clear();
    liveRecap = ""; recapAfter = ""; recapStatus = "finished"; delibActive = false;
    for (const s of speakers) { try { s.session.close(); } catch {} }
    speakers.length = 0; former.length = 0; cfg.former = [];
    for (const k of Object.keys(saved)) delete saved[k];
    events.length = 0; pausedTexts.length = 0; cycleNo = 0; floorHolder = null; openSeat = null; lastLedger.clear();
    roomId = id; logPath = roomPath("events.jsonl"); sessPath = roomPath("sessions.json"); roomSession = undefined;
    mkdirSync(join(roomsDir, roomId), { recursive: true });
    writeFileSync(join(dir, "current"), roomId + "\n");
    if (existsSync(logPath)) {
      for (const line of readFileSync(logPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try { const e = JSON.parse(line); record({ id: e.id, cycle: e.cycle ?? 0, author: e.author, text: e.text, kind: e.kind, data: e.data }); } catch {}
      }
    }
    if (existsSync(sessPath)) { try { Object.assign(saved, JSON.parse(readFileSync(sessPath, "utf8"))); } catch {} }
    booted = false; boot(); shown = false;
    lastHumanId = [...events].reverse().find((e) => e.kind === "human")?.id ?? "";
    recapStatus = "finished";
    drawRecap();
  };
  const freshRoom = () => switchRoom(newRoomId());
  /** archived conversations, newest first, current excluded */
  const roomsList = () => { try { return readdirSync(roomsDir).filter((n) => n !== roomId).sort().reverse(); } catch { return [] as string[]; } };

  /** resume an archived room: the current one is archived first, then its seats' sessions are reattached */
  const resumeRoom = async (ctx: ExtensionContext) => {
    if (busy) return ctx.ui.notify("wait for the committee to settle first", "warning");
    const rooms = roomsList();
    if (!rooms.length) return ctx.ui.notify("no archived rooms in this folder yet", "info");
    const labels = new Map<string, string>();
    for (const id of rooms) {
      let title = "new room", msgs = 0;
      try {
        const evs = readFileSync(join(roomsDir, id, "events.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
        msgs = evs.filter((e) => e.kind === "human" || e.kind === "speak").length;
        const h = evs.find((e) => e.kind === "human"); if (h) title = titleFrom(h.text);
      } catch {}
      labels.set(roomLabel(id, title, msgs), id);
    }
    const choice = await ctx.ui.select("Resume an archived committee room", [...labels.keys(), "cancel"]);
    const pick = choice ? labels.get(choice) : undefined;
    if (!pick) return;
    switchRoom(pick); await enableMode(ctx);
    ctx.ui.notify(`resumed room: ${currentRoomTitle()}`, "info");
  };
  pi.registerCommand("resume-committee", {
    description: "Resume an earlier conversation in this folder; the current room stays on disk, and the seats' native sessions are reattached",
    handler: async (_args, ctx) => { await resumeRoom(ctx); },
  });
  pi.registerCommand("committee", {
    description: "Toggle committee mode: on/off; pause/resume the seats; discuss the current topic; brief <text|path> sets room context (- clears); deliberation [event] toggles an expanded discussion; sessions picks an earlier room; fresh starts a new chat with the same seats; reset deletes committee.json and committee/",
    handler: async (args, ctx) => {
      if (args.trim() === "pause") return pause(ctx);
      if (args.trim() === "resume") {
        paused = false; ctx.ui.setStatus("committee", "idle");
        if (!busy && (heldWhilePaused || ongoing || queued.length)) { heldWhilePaused = false; await runCycles(ctx); }
        return ctx.ui.notify("resumed", "info");
      }
      boot();
      if (args.trim() === "discuss") {
        if (!events.some((e) => e.kind === "human")) return ctx.ui.notify("send a topic first, then ask the committee to discuss", "info");
        if (!active) await enableMode(ctx);
        await requestDiscussion(ctx);
        return;
      }
      if (args.trim().startsWith("brief")) {
        const v = args.trim().slice(5).trim();
        if (!v) return ctx.ui.notify(cfg.brief ? `brief: ${cfg.brief}` : "no brief; /committee brief <text or file path>", "info");
        cfg.brief = v === "-" ? undefined : v; saveSeats();
        return ctx.ui.notify(cfg.brief ? "brief set; every seat gets it on its next call" : "brief removed", "info");
      }
      // fresh conversation, same committee: archive this room and start with empty seats
      if (args.trim() === "fresh") {
        if (busy) return ctx.ui.notify("wait for the committee to settle first", "warning");
        freshRoom();
        await enableMode(ctx);
        return ctx.ui.notify(`started a fresh conversation (room ${roomId})`, "info");
      }
      if (args.trim() === "sessions") return resumeRoom(ctx);
      // expand a collapsed deliberation line: the transcript shows one line, the detail lives here
      if (args.trim().startsWith("deliberation")) {
        const want = args.trim().slice(12).trim();
        const rounds = events.filter((e) => e.kind === "deliberation" && (e.data as any)?.status !== "intentions");
        const pickOne = want ? rounds.find((e) => e.id === want) : rounds[rounds.length - 1];
        if (!pickOne) return ctx.ui.notify(want ? `no deliberation round ${want}` : "no deliberation yet in this room", "info");
        if (expandedDeliberations.has(pickOne.id)) expandedDeliberations.delete(pickOne.id);
        else expandedDeliberations.add(pickOne.id);
        refresh();
        return;
      }
      if (args.trim() === "reset") {
        if (busy) return ctx.ui.notify("wait for the committee to settle first", "warning");
        const n = events.filter((e) => PUBLIC.includes(e.kind)).length;
        const ok = await ctx.ui.select(`Are you sure? This removes the folder's committee: ${speakers.length} seats, ${n} messages, every session? committee.json and committee/ are deleted.`, ["no, keep it", "yes, I am sure"]);
        if (ok !== "yes, I am sure") return;
        for (const s of speakers) s.session.close();
        rmSync(seatsPath, { force: true }); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
        events.length = 0; pausedTexts.length = 0; cycleNo = 0; floorHolder = null; lastLedger.clear(); openSeat = null;
        queued.length = 0; queuedIds.length = 0; failedHumans.clear(); ongoing = undefined; roundPending = false;
        liveRecap = ""; recapAfter = ""; recapStatus = "finished"; expandedDeliberations.clear();
        for (const k of Object.keys(saved)) delete saved[k];
        speakers.length = 0; former.length = 0; cfg.speakers = []; cfg.former = [];
        active = false; applyMode(ctx);
        return ctx.ui.notify("committee removed from this folder. /committee on sets up a new one. Messages above are history only; /clear drops them from view.", "info");
      }
      const want = args.trim() === "on" ? true : args.trim() === "off" ? false : !active;
      if (busy && !want) return ctx.ui.notify("wait for the committee to settle first", "warning");
      if (want) {
        // /committee on means "turn on for this thread": a thread not bound to the folder's last room starts a fresh one; /resume-committee is how to go back
        const bound = roomBinding((ctx.sessionManager?.getEntries?.() ?? []) as any);
        if (!active && events.length && bound !== roomId) switchRoom(newRoomId());
        return enableMode(ctx);
      }
      active = false; applyMode(ctx);
      ctx.ui.notify("committee mode off", "info");
    },
  });

  pi.registerCommand("seats", {
    description: "Add, remove or change a seat (cli + model + thinking); saved to committee.json",
    handler: async (_args, ctx) => {
      if (busy) return ctx.ui.notify("wait for the committee to settle first", "warning");
      boot();
      const pick = await ctx.ui.select("Seats", [...speakers.map((s) => seatLine(s.meta)), "+ add a seat"]);
      if (!pick) return;
      if (pick === "+ add a seat") { await addSeatFlow(ctx); return; }
      const s = speakers.find((x) => seatLine(x.meta) === pick)!;
      const action = await ctx.ui.select(`Seat ${s.meta.id}`, ["change model", "change thinking", "change tools", "remove seat"]);
      if (!action) return;
      if (action === "change tools") {
        const tools = await pickTools(ctx, s.meta.tools);
        if (tools === null || tools === s.meta.tools) return;
        const meta: Seat = { ...s.meta, tools };
        s.session.close(); Object.assign(s, makeSeat(meta)); saveSeats();
        return ctx.ui.notify(`${s.meta.id} tools: ${tools ?? "none"} (fresh session)`, "info");
      }
      if (action === "remove seat") {
        retire(s); saveSeats();
        return ctx.ui.notify(`removed ${s.meta.id}; its past lines stay in the transcript`, "info");
      }
      const field = action === "change model" ? "model" : "thinking";
      const v = field === "model" ? await pickModel(ctx, s.meta.cli, s.meta.model) : await pickThinking(ctx, s.meta.cli, s.meta.thinking, s.meta.model);
      if (v === undefined) return;
      const meta: Seat = { ...s.meta, [field]: v || undefined };
      s.session.close();
      Object.assign(s, makeSeat(meta));
      saveSeats();
      ctx.ui.notify(`${s.meta.id} now ${seatLine(meta)} (fresh session)`, "info");
    },
  });

  pi.registerMessageRenderer("committee", (message, { outputPad, expanded }, theme) => {
    const d = message.details as Event;
    const content = String(message.content);
    const color = d.kind === "human" ? 250 : d.kind === "error" ? 196 : d.kind === "tool" ? 244 : colorOf(d.author);
    if (d.kind === "phase") {
      // one rule per speaking episode, not one per turn: the turns are detail, the episode is the unit
      return {
        invalidate() {},
        render(width: number) {
          const dd = (d.data ?? {}) as { seats?: number };
          const label = `── committee speaks · ${dd.seats ?? 0} seats · ${d.id} `;
          const pad = " ".repeat(outputPad); // same left edge as every other row
          return [truncateToWidth(pad + theme.fg("dim", label.padEnd(Math.max(0, width - outputPad), "─")), width)];
        },
      };
    }
    if (d.kind === "deliberation") {
      // one line per round, not a block: the detail stays in the file, the room sees a summary.
      // Intention rounds are status, not conversation: they stay in the log and never take a row.
      if ((d.data as any)?.status === "intentions") return { invalidate() {}, render: () => [] };
      return {
        invalidate() {},
        handleMouse(ev: { type: string; button: string; y: number }) {
          if (ev.type !== "click" || ev.button !== "left" || ev.y !== 0) return;
          if (expandedDeliberations.has(d.id)) expandedDeliberations.delete(d.id);
          else expandedDeliberations.add(d.id);
          refresh();
          return { handled: true };
        },
        render(width: number) {
          const current = (!d.roomId || d.roomId === roomId ? events.find((e) => e.id === d.id) : undefined) ?? d;
          const dd = (current.data ?? {}) as { turn?: number; seats?: number; ms?: number; started?: number; status?: string };
          const pad = " ".repeat(outputPad);
          const open = expanded || expandedDeliberations.has(d.id);
          const ms = dd.status === "running" && dd.started ? Date.now() - dd.started : dd.ms ?? 0;
          const status = dd.status === "running" ? "discussing" : dd.status === "paused" ? "paused" : "finished";
          const head = `${open ? "▾" : "▸"} deliberation · ${status} · ${dd.seats ?? 0} seats · ${Math.round(ms / 1000)}s`;
          const hint = ` · /committee deliberation ${d.id}`;
          const lines = [truncateToWidth(pad + theme.fg("dim", head + hint), width)];
          if (open) lines.push(...new Markdown(current.text || "Waiting for the first exchange…", 0, 0, getMarkdownTheme()).render(Math.max(1, width - outputPad - 2)).map((line) => pad + theme.fg("dim", "│ ") + highlightTags(line)));
          return lines;
        },
      };
    }
    if (d.kind === "recap") return {
      invalidate() {},
      render: (width: number) => recapBox(theme, String(message.content), Math.max(1, width - outputPad), `recap when you sent this${(d.data as any)?.status === "discussing" ? " · still discussing" : (d.data as any)?.status === "finished" ? " · finished" : ""}`).map((line) => " ".repeat(outputPad) + line),
    };
    const rep = (d.data as any)?.repeat;
    const name = d.kind === "human" ? theme.fg("accent", d.author) : ansi(d.kind === "tool" ? colorOf(d.author) : color, d.author + (d.kind === "error" ? " ✗" : d.kind === "tool" ? " ⚙ " + (d.data as any)?.tool : rep ? ` ↺ already answered (${rep})` : ""));
    return {
      invalidate() {},
      render(width: number) {
        const pad = " ".repeat(outputPad);
        // a one eighth block: still a continuous line of color, without the heavy block the full cell made
        const bar = `${ansi(color, "▏")} `;
        const inner = Math.max(1, width - outputPad - 2);
        // speech is markdown (bold, lists, code); tool lines stay plain dim text. tags are colored after rendering so ANSI never sits inside the markdown source
        let body: string[];
        if (d.kind === "tool") body = wrapTextWithAnsi(ansi(244, content), inner);
        else { try { body = new Markdown(content, 0, 0, getMarkdownTheme()).render(inner).map(highlightTags); } catch { body = wrapTextWithAnsi(highlightTags(content), inner); } }
        const seat = d.kind === "human" || d.kind === "tool" ? undefined : byId(d.author)?.meta ?? ghostOf(d.author);
        const w = (d.data as any)?.tools as { calls: number; chars: number } | undefined;
        // name on the left, cli:model #thinking (and the tool-work marker) right-aligned on the same line
        const right = seat ? ansi(244, (w ? `⚙ ${w.calls} tool call${w.calls === 1 ? "" : "s"}, ${fmt(w.chars)} chars   ` : "") + seatMeta(seat)) : "";
        const gap = width - outputPad - 2 - visibleWidth(name) - visibleWidth(right);
        // the empty gap between the seat's name and its turn details carries a hairline rule, so the
        // eye reads the head as one line rather than two columns
        const rule = gap >= 8 ? `${theme.fg("dim", " ─" + "─".repeat(gap - 4) + "─ ")}` : " ".repeat(Math.max(0, gap));
        const head = gap >= 2 ? `${name}${rule}${right}` : name;
        const who = seat && gap < 2 ? [`${pad}${bar}${right}`] : [];
        const lines = [`${pad}${bar}${head}`, ...who, ...body.map((l) => `${pad}${bar}${l}`)];
        return d.kind === "speak" ? lines.map((line) => speakerBand(theme, line, width, color)) : lines;
      },
    };
  });

  // ---- packets: preamble + rules + full transcript once per session, then only the delta
  const roster = () => speakers.map(({ meta: s }) => { const p = personaOf(s); return `- ${s.id} [@${tagOf(s.id)}] (${s.cli} ${s.model}${s.tools === "all" ? ", has full tools" : s.tools ? ", has read-only tools" : ""})${p ? `: ${p}` : ""}`; }).join("\n")
    + (former.length ? `\nFormer, no longer in the room (do not address them): ${former.map((g) => `${g.id} (left after ${g.left})`).join(", ")}` : "");
  const ledger = () => speakers.map((s) => `${s.meta.id} ${s.stat.turns}x${s.stat.lastSpoke ? `@c${s.stat.lastSpoke}` : ""}`).join(", ") + `; floor: ${floorHolder ?? "nobody"}`;
  // factual spend so far, printed only when the ledger itself changes, so it costs nothing extra per call
  const spendLine = () => speakers.map((s) => `${s.meta.id}: ${s.stat.calls} calls, ${fmt(s.stat.fresh + s.stat.cached + s.stat.out)} billed tokens (re-reads included)${s.stat.cost ? `, $${s.stat.cost.toFixed(3)}` : ""}`).join(" · ");
  const rules = `Floor rules (self-governed): normally one speaker per cycle. Speak only when you add something new. Defer to speakers who have spoken less; the last floor holder may finish a thought. Only numbered transcript events were said publicly. Coordination signals are private: never cite a topic as if it were a spoken answer. Write public replies like an SMS, roughly 25 words, at most one important answer or ask. Use longer replies only when the human needs the detail. Say the result, without advance announcements or acknowledgments.
When you refer to another seat, use its shorthand tag from the roster (for example @sp), not its full id; the transcript colors each tag in that seat\'s color. Humans use the same tags to address a seat. Never use gendered pronouns (he, she, his, her) for a seat or a person; use "they" or "it". When a message tags specific seats, the seats not tagged stay silent unless they have a pressing, urgent matter (a safety problem, a factual error that would mislead, a conflict about to happen); a tagged seat answers, and tags in another seat's reply do not count as addressing you.
Speaking again is allowed: one turn is not a cap. Come back on new information only — a new human request, new evidence that changes your conclusion, or a consequential correction. Never to acknowledge, agree or restate what was said. Prefer saying it inside the round you are already in; a further round re-reads every seat's session, so it costs far more than your words do. Output tokens are cheap; calls are not.
A human message never goes unanswered: if nobody has anything new to add, whoever answered the human most recently responds with action "repeat" and the event id of that earlier reply in ref, so it is shown again instead of silence.
Tools: your calls and output stay in your own session, so share material evidence, paths and results in your contribution. Orient yourself from the room's files when needed. Keep tool output small. Tools are off during token passing; lookups happen in deliberation or your response. Plan and report by default; change files only when the human asked, and only with full tools.
Phases, always JSON: intention is tiny token passing, preference speak, wait, or deliberate, and an optional topic of a few words (at most 80 characters). Never put an answer or argument there. Choose deliberate when the human requests discussion or the room needs to exchange evidence, resolve disagreement or coordinate work. Deliberation is an expandable discussion among seats: action discuss with your contribution, or ready when the room can report; readiness does not require unanimous agreement. Flag discovery only for material new evidence needing extra discussion, never to repeat an old point. The least-spoken seat reports the outcome, unresolved objections and anything needed from the human. Respond with action speak and text, wait/silent to hold, or repeat and ref for an earlier reply of yours.
Human messages arrive together at your next available turn. Absorb them without treating each as a restart or emergency; work them in when practical. Explicit urgency, corrections and cancellation take priority. Never ignore an earlier queued message because a later one arrived.
Every public response also includes recap: a concise replacement for the running recap since the latest human message. Merge prior outcomes with new findings, completed actions, unresolved disagreement and any decision needed from the human. Cite event ids for earlier claims. Do not invent consensus or describe unperformed work as done. A new human message starts a fresh recap segment.`;
  const rulesText = () => `Etiquette: ${cfg.etiquette}\n${rules}${briefOf() ? `\nAbout this room, from the human who set it up:\n${briefOf()}` : ""}`;
  const rulesVersion = () => createHash("sha1").update(rulesText()).digest("hex").slice(0, 8);
  const line = (e: Event) => `[${e.id} ${e.author}] ${e.text}`;
  const lastLedger = new Map<string, string>();
  const packet = (s: (typeof speakers)[number], phase: string, extra: string) => {
    const me = s.meta;
    const pub = events.filter((e) => PUBLIC.includes(e.kind));
    const fresh = pub.slice(s.sent);
    const first = s.sent === 0;
    // committed only when the call succeeds, so a failed or superseded call replays the gap instead of eating it
    s.pendingSent = pub.length;
    const l = ledger();
    const ledgerLine = l !== lastLedger.get(me.id) ? `Ledger (times spoken, last cycle): ${l}\nSpent so far: ${spendLine()}\n` : "";
    lastLedger.set(me.id, l);
    const v = rulesVersion();
    const rulesBlock = first ? `${rulesText()}\n` : s.rulesSeen !== v ? `The room's rules changed; this replaces what you had:\n${rulesText()}\n\n` : "";
    s.rulesSeen = v;
    const head = first
      ? `You are "${me.id}" (${me.cli} ${me.model}) in a committee conversation with humans and other models.${personaOf(me) ? ` Persona: ${personaOf(me)}` : " Speak as yourself; no assigned role."}${me.tools === "all" ? ` You have your CLI's full tools; the room folder is ${cwd}.` : me.tools ? ` You have read-only tools; the room folder is ${cwd}.` : " You have no tools."}\n${rulesBlock}Roster:\n${roster()}\n\nTranscript so far:\n${fresh.map(line).join("\n") || "(empty)"}\n\n`
      : `${rulesBlock}${fresh.length ? `New in the transcript:\n${fresh.map(line).join("\n")}\n\n` : ""}`;
    return `${head}${ledgerLine}${extra}Phase: ${phase}.`;
  };

  const deliberate = async (seats: (typeof speakers)[number][], state: RoundState, tok: ReturnType<typeof roomGen.capture>) => {
    if (!seats.length) return "";
    const started = Date.now();
    let board = "";
    const held = seats.filter((s) => !s.inflight);
    for (const s of held) s.inflight = true;
    syncBusy();
    const exchange = publish({ author: "host", kind: "deliberation", text: "", data: { turn: state.n, seats: seats.length, started, ms: 0, status: "running" } });
    try {
      delibActive = true;
      recapStatus = "discussing"; drawRecap();
      while (!paused) {
        const joining = freeSeats().filter((s) => !state.focus || state.focus.has(s.meta.id));
        for (const s of joining) { seats.push(s); held.push(s); s.inflight = true; }
        syncBusy();
        const humanAtStart = lastHumanId;
        const weight = state.discussion.weight;
        const reporter = seats.slice().sort((a, b) => a.stat.turns - b.stat.turns)[0];
        for (const s of seats) setState(s.meta.id, "thinking");
        const said = await Promise.all(seats.map(async (s) => {
          const r = await s.session.send(packet(s, "deliberation", `Discussion weight ${Math.round(weight * 100)}%, exchange ${state.discussion.round}. ${weight < WRAP_UP ? "Report now; preserve any unresolved disagreement. Return action ready with your final position in text." : "Discuss freely with the other seats; do not address the human. Return action discuss to continue or ready when the room can report, with your contribution in text."} Set discovery:true only for material new evidence needing more time. Read queued human messages naturally; urgency is explicit, not implied by arrival.${s === reporter ? ` Also return recap: update the running summary of outcomes, unsettled points and questions for the human, preserving significant earlier outcomes. Current recap: ${liveRecap || "(none)"}.` : ""}${board ? `\nPrevious exchange:\n${board}` : ""}\n`), deliberationSchema, budget(s));
          if (!roomGen.accepts(tok)) return r;
          account(r, "deliberation");
          if (r.ok) { s.sent = s.pendingSent ?? s.sent; failedHumans.delete(s.meta.id); pruneQueue(); }
          else { failedHumans.set(s.meta.id, humanAtStart); diag(r, "deliberation"); }
          return r;
        }));
        if (!roomGen.accepts(tok)) return "";
        const successful = said.filter((r) => r.ok);
        board = said.map((r) => r.ok ? `${r.speaker}: ${String((r.payload as any)?.text ?? "").trim()} [${(r.payload as any)?.action}]` : `${r.speaker}: call failed (${r.error})`).join("\n");
        exchange.text += `${exchange.text ? "\n\n" : ""}Exchange ${state.discussion.round}\n${board}`;
        const report = successful.find((r) => r.speaker === reporter.meta.id)?.payload as { recap?: unknown } | undefined;
        if (humanAtStart === lastHumanId && typeof report?.recap === "string" && report.recap.trim()) { liveRecap = report.recap.trim().slice(0, 1200); drawRecap(); }
        exchange.data = { turn: state.discussion.round, seats: seats.length, started, ms: Date.now() - started, status: "running", ...(humanAtStart === lastHumanId ? { recap: liveRecap, recapAfter } : {}) };
        appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...exchange }) + "\n");
        refresh(); saveSessions();
        const discovery = successful.some((r) => (r.payload as any)?.discovery === true);
        const ready = successful.length === seats.length && successful.every((r) => (r.payload as any)?.action === "ready");
        const extended = state.discussion.advance(discovery);
        if (successful.length < seats.length || (ready && !extended && humanAtStart === lastHumanId) || (weight < WRAP_UP && !extended)) break;
      }
      return exchange.text;
    } finally {
      for (const s of held) s.inflight = false;
      if (roomGen.accepts(tok)) {
        if (paused) state.discuss = true;
        exchange.data = { ...(exchange.data as object), ms: Date.now() - started, status: paused ? "paused" : "concluded" };
        appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...exchange }) + "\n");
        delibActive = false; drawDeliberating(); syncBusy(); refresh();
      }
    }
  };

  // ---- one cycle: intentions (parallel) → everyone sees them → each holds or responds (parallel)
  const takeReply = (r: TurnResult, after = recapAfter, base = liveRecap) => {
    if (!r.ok) { diag(r, "respond"); setState(r.speaker, "err:respond"); publish({ author: r.speaker, kind: "error", text: `respond failed: ${r.error}` }); return 0; }
    const p = r.payload as { action: string; text?: string; ref?: string; recap?: string };
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (p.action === "repeat") {
      const prev = events.find((e) => e.id === p.ref && e.kind === "speak" && e.author === r.speaker);
      if (!prev) { setState(r.speaker, "err:repeat"); publish({ author: r.speaker, kind: "error", text: `repeat pointed at ${p.ref ?? "nothing"}, which is not one of its replies` }); return 0; }
      const st = byId(r.speaker)?.stat; if (st) st.lastReply = `(repeat of ${prev.id})`;
      setState(r.speaker, "repeated"); publish({ author: r.speaker, kind: "speak", text: prev.text, data: { repeat: prev.id } }); return 0;
    }
    const st = byId(r.speaker)?.stat; if (st) st.lastReply = p.action === "speak" ? text : `(${p.action})`;
    if (p.action === "speak" && text) {
      const update = typeof p.recap === "string" && p.recap.trim() ? p.recap.trim().slice(0, 1200) : text.slice(0, 1200);
      const recap = base === liveRecap ? update : [...new Set([liveRecap, update].filter(Boolean))].join("\n");
      setState(r.speaker, "spoke"); publish({ author: r.speaker, kind: "speak", text, data: { ...(r.tools ? { tools: r.tools } : {}), ...(after === recapAfter ? { recap, recapAfter: after } : {}) } });
      drawRecap(); return 1;
    }
    setState(r.speaker, p.action); return 0;
  };
  // ---- deliberation: a round polls only the seats that are free, and dispatches replies without
  // awaiting them, so one slow tool-using seat never freezes the room. A busy seat reads the gap
  // it missed as one delta batch when it returns.
  let lastHumanId = [...events].reverse().find((e) => e.kind === "human")?.id ?? "";
  let pendingReplies = 0;
  /** per-round bookkeeping, passed explicitly so overlapping rounds can't reset each other */
  interface RoundState { n: number; spoke: number; focus?: Set<string>; wrapped?: boolean; phased?: boolean; discuss?: boolean; discussion: DiscussionBudget }
  let ongoing: RoundState | undefined;
  let roundPending = false;
  /** appetite for another round: 1 at the start, halving every 4 rounds, never 0. A signal to seats, not a gate. */
  const appetite = (n: number) => Math.pow(2, -(n - 1) / 4);
  const WRAP_UP = 0.1;
  // the two phases decay at different rates: deciding who speaks is cheap and worth doing slowly,
  // one more round of speech is not. Each phase hears only its own number.
  const converge = (st: RoundState) => {
    return `Token passing only: preference speak, wait, or deliberate. Optional topic: a few words, at most 80 characters. No answer or argument. Use deliberate if the human asks for discussion or you need an exchange with peers. Discovery:true requests temporary extra time for material new evidence. Discussion weight ${Math.round(st.discussion.weight * 100)}%; speaking appetite ${Math.round(appetite(st.n) * 100)}%.\n`;
  };
  const appetiteLine = (st: RoundState) => {
    if (st.n < 2) return "";
    return `Appetite for more turns on this request: ${Math.round(appetite(st.n) * 100)}% (round ${st.n}). The lower it is, the more the room should pick and decide soon. It is a signal, not a rule.\n`;
  };
  const newState = (focus?: Set<string>): RoundState => ({ n: 1, spoke: 0, focus, discussion: new DiscussionBudget() });
  /** opt-in (cfg.tagRouting): a human message that tags seats is polled only on those seats; @all/@everyone/@others or no tag asks everyone */
  const seatTags = () => speakers.map((q) => ({ id: q.meta.id, tag: tagOf(q.meta.id) }));
  const focusOf = (text: string) => (cfg.tagRouting ? focusFromText(text, seatTags()) : undefined);
  const focusOfQueue = () => (cfg.tagRouting ? focusFromQueue(queued, seatTags()) : undefined);
  const syncBusy = () => { busy = speakers.some((s) => s.inflight); };
  const freeSeats = () => speakers.filter((s) => !s.inflight);
  const unreadQueue = (s: (typeof speakers)[number]) => {
    if (failedHumans.get(s.meta.id) === recapAfter) return false;
    const pub = events.filter((e) => PUBLIC.includes(e.kind));
    return queuedIds.some((id) => { const i = pub.findIndex((e) => e.id === id); return i >= s.sent && i >= 0 && (!focusOf(pub[i].text) || focusOf(pub[i].text)!.has(s.meta.id)); });
  };
  const pruneQueue = () => {
    const pub = events.filter((e) => PUBLIC.includes(e.kind));
    for (let i = queuedIds.length - 1; i >= 0; i--) {
      const at = pub.findIndex((e) => e.id === queuedIds[i]);
      const focus = at >= 0 ? focusOf(pub[at].text) : undefined;
      if (at < 0 || speakers.filter((s) => !focus || focus.has(s.meta.id)).every((s) => s.sent > at)) { queuedIds.splice(i, 1); queued.splice(i, 1); }
    }
    if (activeCtx) drawQueue(activeCtx);
  };
  const requestDiscussion = async (ctx: ExtensionContext) => {
    if (delibActive) return;
    const state = ongoing ??= newState();
    state.discuss = true;
    if (!paused && !roundPending && freeSeats().length) await round(ctx, state);
  };

  async function round(ctx: ExtensionContext, state: RoundState, only?: (typeof speakers)[number]): Promise<number> {
    if (roundPending || paused || delibActive) return 0;
    roundPending = true;
    const tok = roomGen.capture();
    try { return await runRound(ctx, state, only); }
    finally { if (roomGen.accepts(tok)) { roundPending = false; if (!pendingReplies) afterRound(ctx, state); } }
  }
  async function runRound(ctx: ExtensionContext, state: RoundState, only?: (typeof speakers)[number]): Promise<number> {
    const free = only ? (only.inflight ? [] : [only]) : freeSeats().filter((s) => !state.focus || state.focus.has(s.meta.id));
    if (!free.length) return 0;
    // one delimiter per speaking episode: everything the room says about this human message sits under it
    if (!only && !state.phased) {
      state.phased = true;
      publish({ author: "host", kind: "phase", text: `committee · ${speakers.length} seats`, data: { seats: speakers.length, after: lastHumanId } });
    }
    cycleNo++;
    // captured once for this invocation: a concurrent catch-up round must not steal the stamp
    const stamp = cycleNo;
    if (!only) state.spoke = 0;
    for (const s of free) setState(s.meta.id, "thinking");
    // a seat that has seen no new public event since its last poll has nothing to decide; skip the call
    const seen = events.filter((e) => PUBLIC.includes(e.kind)).length;
    const roundTok = roomGen.capture();
    const intents = await Promise.all(free.map((s) => {
      if (s.polledAt === seen && !state.discuss) {
        setState(s.meta.id, "listening");
        return Promise.resolve({ speaker: s.meta.id, ok: true, skipped: true, payload: { preference: "wait" } } as unknown as TurnResult);
      }
      s.inflight = true; syncBusy();
      const seenHuman = recapAfter;
      // only a poll that actually happened counts as "seen up to here"; a failed call stays eligible
      return s.session.send(packet(s, "intention", converge(state)), intentionSchema, timeoutMs, { noTools: true })
        .then((r) => {
          if (!roomGen.accepts(roundTok)) return r;
          if (r.ok) { s.polledAt = seen; s.sent = s.pendingSent ?? s.sent; failedHumans.delete(s.meta.id); }
          else failedHumans.set(s.meta.id, seenHuman);
          s.inflight = false; syncBusy();
          account(r, "intention"); pruneQueue(); const p = r.payload as any; const st = byId(r.speaker)?.stat; if (st && r.ok) { st.lastIntent = `${p.preference}${p.topic ? `: ${compactTopic(p.topic)}` : ""}`; st.intentStamp = stamp; } setState(r.speaker, r.ok ? p.preference : "err:intention"); return r;
        });
    }));
    if (!roomGen.accepts(roundTok)) return 0; // the room changed while seats were thinking
    // Intentions carry a one-line topic. A seat that pastes its whole answer into the poll must not
    // have it shown to the room: the others then defer to a reply that was never published.
    const intentionLine = (p: any) => `${p?.preference}${p?.topic ? `: ${compactTopic(p.topic)}` : ""}`;
    const summary = intents.map((r) => !r.ok ? `${r.speaker}: ERROR ${r.error}` : (r as any).skipped ? `${r.speaker}: (not polled, nothing new)` : `${r.speaker}: ${intentionLine(r.payload)}`).join("\n");
    if (!only) {
      publish({ author: "host", kind: "intention", text: summary });
      for (const r of intents) if (!r.ok) { diag(r, "intention"); publish({ author: r.speaker, kind: "error", text: `intention failed: ${r.error}` }); }
    }
    saveSessions();

    const discuss = state.discuss || intents.some((r) => r.ok && (r.payload as any)?.preference === "deliberate");
    state.discuss = false;
    const candidates = discuss ? free : free.filter((s) => { const r = intents.find((i) => i.speaker === s.meta.id); return r?.ok && (r.payload as any).preference === "speak" && !s.inflight; });
    for (const s of free) if (!candidates.includes(s)) setState(s.meta.id, "listening");
    if (!candidates.length) return 0;

    // appetite is nearly gone: the last seat in the list that wanted to speak says why the room could not pick, and the rest hold
    const wrap = appetite(state.n) < WRAP_UP && !state.wrapped;
    if (wrap) state.wrapped = true;
    const speakers_ = wrap ? candidates.slice().sort((a, b) => a.stat.turns - b.stat.turns).slice(0, 1) : candidates;
    for (const s of candidates) if (!speakers_.includes(s)) setState(s.meta.id, "listening");
    let alone = speakers_.length === 1;
    // two or more seats wanted the floor: let them settle it between themselves first, one conclusion on screen
    if (intents.some((r) => r.ok && (r.payload as any)?.discovery === true)) state.discussion.advance(true);
    const concluded = discuss && !wrap ? await deliberate(speakers_, state, roundTok) : "";
    if (!roomGen.accepts(roundTok)) return 0;
    if (paused) return 0;
    const asHuman = lastHumanId;
    // one conclusion, one voice: after deliberating, the seat that has spoken least presents for the room
    if (concluded && speakers_.length > 1) {
      const available = speakers_.filter((s) => failedHumans.get(s.meta.id) !== lastHumanId);
      const presenter = (available.length ? available : speakers_).slice().sort((a, b) => a.stat.turns - b.stat.turns)[0];
      for (const s of speakers_) if (s !== presenter) setState(s.meta.id, "listening");
      speakers_.length = 0; speakers_.push(presenter); alone = true;
    }
    for (const s of speakers_) {
      if (wrap) { dispatch(ctx, s, `Appetite for more turns is below 10%. Say in one short reply why the room could not settle who speaks or what to decide, then stop. The human or another seat can carry on from there. Action "speak".`, asHuman, state); continue; }
      const extra = alone
        ? `You have the floor. Use tools if needed. Put the contribution in text with action speak.\n`
        : `Everyone's intentions:\n${summary}\nHold (action wait or silent, empty text) or respond now (action speak, contribution in text).${s.meta.tools ? " If you respond and your intention needed a lookup, use your tools first." : ""}\n`;
      const open = concluded ? `Report for the room from this discussion:\n${concluded}\nGive the outcome, unresolved disagreement and any question for the human. Do not claim consensus if the exchange did not reach it.\n` : "";
      dispatch(ctx, s, open + extra, asHuman, state);
    }
    return speakers_.length;
  }

  /** fire a reply without awaiting it; the seat stays on the floor while it works, everyone else keeps going */
  const dispatch = (ctx: ExtensionContext, s: (typeof speakers)[number], extra: string, asHuman: string, state: RoundState) => {
    const tok = roomGen.capture();
    const after = recapAfter;
    const recapBase = liveRecap;
    s.inflight = true; pendingReplies++; syncBusy();
    setState(s.meta.id, s.meta.tools ? "working" : "replying");
    void s.session.send(packet(s, "respond", extra + appetiteLine(state) + `Return recap as a concise updated summary since the latest human message: outcomes, completed actions, unsettled points, and anything needed from the human. Preserve significant earlier outcomes. Current recap:\n${liveRecap || "(none yet)"}\n`), responseSchema, budget(s))
      .then((r) => {
        if (!roomGen.accepts(tok)) return;
        account(r, "respond");
        if (r.ok) { s.sent = s.pendingSent ?? s.sent; failedHumans.delete(s.meta.id); }
        else failedHumans.set(s.meta.id, after);
        const published = takeReply(r, after, recapBase);
        if (published > 0 || (r.ok && (r.payload as any)?.action === "repeat" && events.some((e) => e.id === (r.payload as any)?.ref && e.kind === "speak" && e.author === r.speaker))) answeredHumans.add(asHuman);
        state.spoke += published;
        s.inflight = false; pendingReplies--; syncBusy(); pruneQueue(); saveSessions(); refresh();
        if (!paused && queued.length && unreadQueue(s)) { void round(ctx, state, s); return; }
        if (pendingReplies === 0) afterRound(ctx, state);
      })
      .catch((e) => {
        if (!roomGen.accepts(tok)) return;
        failedHumans.set(s.meta.id, after);
        publish({ author: s.meta.id, kind: "error", text: `respond failed: ${String((e as any)?.message ?? e)}` });
        s.inflight = false; pendingReplies--; syncBusy(); saveSessions(); refresh();
        if (pendingReplies === 0) afterRound(ctx, state);
      });
  };

  /** a human message must not end unanswered: when the round ended with no published reply since it, ask the seat that has spoken least, once, with no option to hold */
  let forcedFor = "";
  let notedFor = "";
  /** human message ids that got a published reply from a call dispatched for that message; a late reply to an older message does not count */
  const answeredHumans = new Set<string>();
  const unanswered = () => !!lastHumanId && !answeredHumans.has(lastHumanId);
  const forceAnswer = (ctx: ExtensionContext, state: RoundState): boolean => {
    if (lastHumanId && forcedFor === lastHumanId && unanswered() && notedFor !== lastHumanId) {
      notedFor = lastHumanId;
      publish({ author: "host", kind: "error", text: "nobody answered; asked one seat directly and it still had nothing to add" });
    }
    if (!lastHumanId || forcedFor === lastHumanId || !unanswered()) return false;
    const pool = freeSeats().filter((s) => !state.focus || state.focus.has(s.meta.id));
    if (!pool.length) return false; // a tagged request waits for its recipient; an untagged seat must not take it
    const seat = pool.sort((a, b) => a.stat.turns - b.stat.turns)[0];
    if (!seat) return false;
    forcedFor = lastHumanId;
    ctx.ui.notify(`nobody answered: asking ${seat.meta.id} directly`, "info");
    dispatch(ctx, seat, `Nobody has answered the human's last message. You must answer it now: action "speak" with your answer (or "repeat" an earlier reply of yours). Do not hold.`, lastHumanId, state);
    return true;
  };

  const afterRound = (ctx: ExtensionContext, state: RoundState) => {
    if (paused || roundPending || delibActive) return;
    pruneQueue();
    if ((queued.length && freeSeats().some(unreadQueue)) || (state.discuss && freeSeats().length)) {
      state.focus = focusOfQueue(); void round(ctx, state); return;
    }
    if (pendingReplies) return;
    if (state.spoke === 0 && forceAnswer(ctx, state)) return;
    if (state.spoke > 0 && !state.wrapped) {
      state.n++;
      state.discussion.advance();
      void round(ctx, state);
      return;
    }
    ongoing = undefined; recapStatus = "finished"; drawRecap(); ctx.ui.setStatus("committee", "idle");
  };

  pi.on("input", async (event, ctx) => {
    activeCtx = ctx;
    if (!active || event.source === "extension" || event.text.startsWith("/")) return { action: "continue" };
    cycleNo++;
    if (liveRecap) publish({ author: "host", kind: "recap", text: liveRecap, data: { status: recapStatus, after: recapAfter } });
    publish({ author: "you", kind: "human", text: event.text });
    drawRecap();
    // name the pi session after the first human message, once per room, unless the user already named it
    if (!events.some((e) => e !== events[events.length - 1] && e.kind === "human")) {
      try { const cur = pi.getSessionName(); if (!cur || cur.startsWith("⚒ ")) pi.setSessionName(`⚒ ${titleFrom(event.text)}`); } catch {}
    }
    lastHumanId = events[events.length - 1]?.id ?? "";
    queued.push(event.text); queuedIds.push(lastHumanId); drawQueue(ctx);
    if (paused) { heldWhilePaused = true; pausedTexts.push(event.text); return { action: "handled" }; }
    const state = ongoing ??= newState(focusOfQueue());
    state.focus = focusOfQueue();
    const tok = roomGen.capture();
    queueMicrotask(() => { if (roomGen.accepts(tok) && !roundPending && !delibActive) void round(ctx, state); });
    return { action: "handled" };
  });
  async function runCycles(ctx: ExtensionContext) {
    failedHumans.clear();
    pausedTexts.length = 0;
    const state = ongoing ??= newState(focusOfQueue());
    state.focus = focusOfQueue();
    await round(ctx, state);
  }

  pi.on("session_shutdown", async () => { if (ticker) clearInterval(ticker); if (delibTicker) clearInterval(delibTicker); saveSessions(); for (const s of speakers) s.session.close(); });
}

import { focusFromText, focusFromQueue } from "./routing.ts";
import { reportedCost } from "./accounting.ts";
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

interface Config {
  speakers: Seat[];
  former?: Ghost[];
  etiquette: string;
  /** what every seat should know about this folder: text, or a path to a file (relative to the room, or ~) */
  brief?: string;
  timeoutSeconds?: number;
  /** autonomous rounds per human message before the room stops on its own: a runaway guard, not the normal stop (default 8) */
  /** poll only seats the human message tags (@all asks everyone); off by default */
  tagRouting?: boolean;
  maxRounds?: number;
  /** per call, for seats with tools (default 600) */
  toolTimeoutSeconds?: number;
}
interface Seat { id: string; cli: Cli; model: string; thinking?: string; persona?: string; tools?: Tools }
// a seat that left the room; its lines stay in the transcript, it stays visible as a pale dot
interface Ghost { id: string; cli: Cli; model: string; thinking?: string; left: string }
type Kind = "human" | "speak" | "error" | "intention" | "usage" | "tool";
interface Event { id: string; cycle: number; author: string; text: string; kind: Kind; data?: unknown }
interface Stat { state: string; since: number; activity?: string; ctx?: number; window?: number; fresh: number; cached: number; out: number; cost: number; calls: number; turns: number; lastSpoke: number; lastIntent?: string; lastReply?: string }
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
  /** messages typed while a cycle is running; they are logged only when delivered, never before */
  const queued: string[] = [];
  // one dim line per waiting message, in pi's own vocabulary, above the editor
  const drawQueue = (ctx: ExtensionContext) =>
    ctx.ui.setWidget("committee-queue", queued.length ? queued.map((t, i) => `⏳ waiting ${i + 1}: ${t} (already sent)`) : undefined, { placement: "aboveEditor" });
  let paused = false;
  let heldWhilePaused = false;
  const pausedTexts: string[] = [];
  let lastHumanText = "";
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
  const record = (ev: Event) => {
    events.push(ev);
    if (ev.kind === "speak") { const st = byId(ev.author)?.stat; if (st) { st.turns++; st.lastSpoke = ev.cycle; } floorHolder = ev.author; }
    if (ev.kind === "human") cycleNo = ev.cycle;
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
      // lifecycle.roomBinding looks for exactly this entry on resume; without it the room is listed but never reattaches
      if (fresh) roomSession.appendCustomEntry("committee-room", { roomId });
      roomSession.appendMessage({ role: "user", content: text, timestamp: Date.now() });
      const f = roomSession.getSessionFile();
      if (f) writeFileSync(mirrorFile(), f + "\n");
    } catch (e) { appendFileSync(diagPath, JSON.stringify({ ts: Date.now(), phase: "mirror", error: String(e) }) + "\n"); }
    roomSession = undefined;
  };
  const publish = (e: Omit<Event, "id" | "cycle">) => {
    const ev: Event = { id: `event-${events.length + 1}`, cycle: cycleNo, ...e };
    record(ev);
    appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
    if (PUBLIC.includes(ev.kind)) pi.sendMessage({ customType: "committee", content: ev.text, display: true, details: ev });
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
  const refresh = () => {
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
    for (const ev of events) if (PUBLIC.includes(ev.kind)) pi.sendMessage({ customType: "committee", content: ev.text, display: true, details: ev });
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
  };
  // one path for turning the room on: /committee on, and a click on the hint
  enableMode = async (ctx: ExtensionContext) => {
    activeCtx = ctx;
    if (!active && speakers.length === 0 && !(await onboarding(ctx))) return ctx.ui.notify("no seats, committee stays off", "warning");
    // make this pi session findable in the native /resume list, and remember which room it belongs to
    try {
      if (!pi.getSessionName()) pi.setSessionName(`⚒ ${roomId}`);
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
    roomGen.advance(); pendingReplies = 0; busy = false;
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
  };
  const freshRoom = () => switchRoom(newRoomId());
  /** archived conversations, newest first, current excluded */
  const roomsList = () => { try { return readdirSync(roomsDir).filter((n) => n !== roomId).sort().reverse(); } catch { return [] as string[]; } };

  /** resume an archived room: the current one is archived first, then its seats' sessions are reattached */
  const resumeRoom = async (ctx: ExtensionContext) => {
    if (busy) return ctx.ui.notify("wait for the committee to settle first", "warning");
    const rooms = roomsList();
    if (!rooms.length) return ctx.ui.notify("no archived rooms in this folder yet", "info");
    const pick = await ctx.ui.select("Resume an archived committee room", [...rooms, "cancel"]);
    if (!pick || pick === "cancel") return;
    switchRoom(pick); await enableMode(ctx);
    ctx.ui.notify(`resumed room ${pick}`, "info");
  };
  pi.registerCommand("resume-committee", {
    description: "Resume an earlier conversation in this folder; the current room stays on disk, and the seats' native sessions are reattached",
    handler: async (_args, ctx) => { await resumeRoom(ctx); },
  });
  pi.registerCommand("committee", {
    description: "Toggle committee mode: on = your input goes to the committee; off = pi works as usual; pause/resume = hold the seats; brief <text|path> = what seats should know about this folder (- clears); sessions = pick an earlier room to resume (the current one stays on disk); fresh = archive this room and start a new conversation with the same seats; reset = delete this folder's committee.json and committee/",
    handler: async (args, ctx) => {
      if (args.trim() === "pause") return pause(ctx);
      if (args.trim() === "resume") {
        paused = false; ctx.ui.setStatus("committee", "idle");
        if (heldWhilePaused && !busy) { heldWhilePaused = false; await runCycles(ctx); }
        return ctx.ui.notify("resumed", "info");
      }
      boot();
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
      if (args.trim() === "reset") {
        if (busy) return ctx.ui.notify("wait for the committee to settle first", "warning");
        const n = events.filter((e) => PUBLIC.includes(e.kind)).length;
        const ok = await ctx.ui.select(`Are you sure? This removes the folder's committee: ${speakers.length} seats, ${n} messages, every session? committee.json and committee/ are deleted.`, ["no, keep it", "yes, I am sure"]);
        if (ok !== "yes, I am sure") return;
        for (const s of speakers) s.session.close();
        rmSync(seatsPath, { force: true }); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
        events.length = 0; pausedTexts.length = 0; cycleNo = 0; floorHolder = null; lastLedger.clear(); openSeat = null;
        for (const k of Object.keys(saved)) delete saved[k];
        speakers.length = 0; former.length = 0; cfg.speakers = []; cfg.former = [];
        active = false; applyMode(ctx);
        return ctx.ui.notify("committee removed from this folder. /committee on sets up a new one. Messages above are history only; /clear drops them from view.", "info");
      }
      const want = args.trim() === "on" ? true : args.trim() === "off" ? false : !active;
      if (busy && !want) return ctx.ui.notify("wait for the committee to settle first", "warning");
      if (want) return enableMode(ctx);
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

  pi.registerMessageRenderer("committee", (message, { outputPad }, theme) => {
    const d = message.details as Event;
    const color = d.kind === "human" ? 250 : d.kind === "error" ? 196 : d.kind === "tool" ? 244 : colorOf(d.author);
    const rep = (d.data as any)?.repeat;
    const name = d.kind === "human" ? theme.fg("accent", d.author) : ansi(d.kind === "tool" ? colorOf(d.author) : color, d.author + (d.kind === "error" ? " ✗" : d.kind === "tool" ? " ⚙ " + (d.data as any)?.tool : rep ? ` ↺ already answered (${rep})` : ""));
    return {
      invalidate() {},
      render(width: number) {
        const pad = " ".repeat(outputPad);
        // a one eighth block: still a continuous line of color, without the heavy block the full cell made
        const bar = `${ansi(color, "▏")} `;
        const inner = Math.max(20, width - outputPad - 2);
        // speech is markdown (bold, lists, code); tool lines stay plain dim text. tags are colored after rendering so ANSI never sits inside the markdown source
        let body: string[];
        if (d.kind === "tool") body = wrapTextWithAnsi(ansi(244, message.content), inner);
        else { try { body = new Markdown(message.content, 0, 0, getMarkdownTheme()).render(inner).map(highlightTags); } catch { body = wrapTextWithAnsi(highlightTags(message.content), inner); } }
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
        return [`${pad}${bar}${head}`, ...who, ...body.map((l) => `${pad}${bar}${l}`)];
      },
    };
  });

  // ---- packets: preamble + rules + full transcript once per session, then only the delta
  const roster = () => speakers.map(({ meta: s }) => { const p = personaOf(s); return `- ${s.id} [@${tagOf(s.id)}] (${s.cli} ${s.model}${s.tools === "all" ? ", has full tools" : s.tools ? ", has read-only tools" : ""})${p ? `: ${p}` : ""}`; }).join("\n")
    + (former.length ? `\nFormer, no longer in the room (do not address them): ${former.map((g) => `${g.id} (left after ${g.left})`).join(", ")}` : "");
  const ledger = () => speakers.map((s) => `${s.meta.id} ${s.stat.turns}x${s.stat.lastSpoke ? `@c${s.stat.lastSpoke}` : ""}`).join(", ") + `; floor: ${floorHolder ?? "nobody"}`;
  // factual spend so far, printed only when the ledger itself changes, so it costs nothing extra per call
  const spendLine = () => speakers.map((s) => `${s.meta.id}: ${s.stat.calls} calls, ${fmt(s.stat.fresh + s.stat.cached + s.stat.out)} billed tokens (re-reads included)${s.stat.cost ? `, $${s.stat.cost.toFixed(3)}` : ""}`).join(" · ");
  const rules = `Floor rules (self-governed, nobody schedules turns): normally one speaker per cycle. Speak only when you add something the others' intentions do not cover. Defer to speakers who have spoken less. Whoever last held the floor may keep it to finish a thought. If several speak at once, fine; do not re-litigate, just be brief. Only what appears in the transcript was said; never cite an intention as if it were spoken. Contributions are at most 120 words unless your intention said length "long". If you ever have tools, keep their output short: ask for the smallest result that answers the question, since everything you bring back is read by the whole room.
When you refer to another seat, use its shorthand tag from the roster (for example @sp), not its full id; the transcript colors each tag in that seat\'s color. Humans use the same tags to address a seat. Never use gendered pronouns (he, she, his, her) for a seat or a person; use "they" or "it". When a message tags specific seats, the seats not tagged stay silent unless they have a pressing, urgent matter (a safety problem, a factual error that would mislead, a conflict about to happen); a tagged seat answers, and tags in another seat's reply do not count as addressing you.
Speaking again is allowed: one turn is not a cap. Come back on new information only — a new human request, new evidence that changes your conclusion, or a consequential correction. Never to acknowledge, agree or restate what was said. Prefer saying it inside the round you are already in; a further round re-reads every seat's session, so it costs far more than your words do. Output tokens are cheap; calls are not.
A human message never goes unanswered: if nobody has anything new to add, whoever answered the human most recently responds with action "repeat" and the event id of that earlier reply in ref, so it is shown again instead of silence.
Tools: some seats have tools in the room folder, read-only (read files, grep, glob, a shell for inspection) or full (editing and commands too). Your tool work is yours alone: the room never sees your calls or their output, only your reply. So whatever you found or did goes into the reply, with the numbers, paths and results the others need; a reply that says "I checked" without them is wasted work. Nobody tells you where you are: the first time a question needs the code or data, orient yourself (list the room folder, read a README or AGENTS file, find what the question is about) and say in one line what you found so the others need not. Work is divided through intentions: say in the "tool" field what work you would do, one line; if another seat's intention names the same work and it has spoken less, leave it to them and take a different part. Measure before proposing. Tools are off during the intention phase; the work happens in the respond phase, when you actually speak. Plan and report by default; create, change or delete things only when the human asked for that, and only seats with full tools can.
Two phases, always as JSON: "intention" (do you have something to add; topic is one sentence under 20 words), then "respond" (you see everyone's intentions and either hold, with action wait or silent, respond, with action speak and the contribution in text, or re-show an earlier reply of yours, with action repeat and its event id in ref).`;
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

  // ---- one cycle: intentions (parallel) → everyone sees them → each holds or responds (parallel)
  const takeReply = (r: TurnResult) => {
    if (!r.ok) { diag(r, "respond"); setState(r.speaker, "err:respond"); publish({ author: r.speaker, kind: "error", text: `respond failed: ${r.error}` }); return 0; }
    const p = r.payload as { action: string; text: string; ref?: string };
    if (p.action === "repeat") {
      const prev = events.find((e) => e.id === p.ref && e.kind === "speak" && e.author === r.speaker);
      if (!prev) { setState(r.speaker, "err:repeat"); publish({ author: r.speaker, kind: "error", text: `repeat pointed at ${p.ref ?? "nothing"}, which is not one of its replies` }); return 0; }
      const st = byId(r.speaker)?.stat; if (st) st.lastReply = `(repeat of ${prev.id})`;
      setState(r.speaker, "repeated"); publish({ author: r.speaker, kind: "speak", text: prev.text, data: { repeat: prev.id } }); return 0;
    }
    const st = byId(r.speaker)?.stat; if (st) st.lastReply = p.action === "speak" ? p.text.trim() : `(${p.action})`;
    if (p.action === "speak" && p.text.trim()) { setState(r.speaker, "spoke"); publish({ author: r.speaker, kind: "speak", text: p.text.trim(), data: r.tools ? { tools: r.tools } : undefined }); return 1; }
    setState(r.speaker, p.action); return 0;
  };
  // ---- deliberation: a round polls only the seats that are free, and dispatches replies without
  // awaiting them, so one slow tool-using seat never freezes the room. A busy seat reads the gap
  // it missed as one delta batch when it returns.
  let lastHumanId = "";
  let pendingReplies = 0;
  const cap = () => Math.max(1, cfg.maxRounds ?? 8);
  /** per-round bookkeeping, passed explicitly so overlapping rounds can't reset each other */
  interface RoundState { left: number; spoke: number; focus?: Set<string> }
  /** from the third round on, ask seats to converge: speak only if the answer changes or a direct question is open */
  const converge = (st: RoundState) => {
    const round = cap() - st.left;
    return round >= 3 ? `This is round ${round} on the same human request. Speak only if you change the answer, correct a fact, or a direct question to you is still open. Otherwise hold; agreement and restating are not needed.\n` : "";
  };
  const newState = (focus?: Set<string>): RoundState => ({ left: cap() - 1, spoke: 0, focus });
  /** opt-in (cfg.tagRouting): a human message that tags seats is polled only on those seats; @all/@everyone/@others or no tag asks everyone */
  const seatTags = () => speakers.map((q) => ({ id: q.meta.id, tag: tagOf(q.meta.id) }));
  const focusOf = (text: string) => (cfg.tagRouting ? focusFromText(text, seatTags()) : undefined);
  const focusOfQueue = () => (cfg.tagRouting ? focusFromQueue(queued, seatTags()) : undefined);
  const syncBusy = () => { busy = speakers.some((s) => s.inflight); };
  const freeSeats = () => speakers.filter((s) => !s.inflight);

  async function round(ctx: ExtensionContext, state: RoundState, only?: (typeof speakers)[number]): Promise<number> {
    const free = only ? (only.inflight ? [] : [only]) : freeSeats().filter((s) => !state.focus || state.focus.has(s.meta.id));
    if (!free.length) return 0;
    cycleNo++;
    if (!only) state.spoke = 0;
    for (const s of free) setState(s.meta.id, "thinking");
    // a seat that has seen no new public event since its last poll has nothing to decide; skip the call
    const seen = events.filter((e) => PUBLIC.includes(e.kind)).length;
    const roundTok = roomGen.capture();
    const intents = await Promise.all(free.map((s) => {
      if (s.polledAt === seen) {
        setState(s.meta.id, "listening");
        return Promise.resolve({ speaker: s.meta.id, ok: true, skipped: true, payload: { preference: "silent", intent: "contribute", topic: "nothing new since the last poll" } } as unknown as TurnResult);
      }
      s.inflight = true; syncBusy();
      // only a poll that actually happened counts as "seen up to here"; a failed call stays eligible
      return s.session.send(packet(s, "intention", converge(state)), intentionSchema, timeoutMs, { noTools: true })
        .then((r) => {
          if (r.ok) { s.polledAt = seen; s.sent = s.pendingSent ?? s.sent; }
          s.inflight = false; syncBusy();
          account(r, "intention"); const p = r.payload as any; const st = byId(r.speaker)?.stat; if (st && r.ok) st.lastIntent = `${p.preference}/${p.intent ?? "contribute"}: ${p.topic}${p.tool ? " ⚙ " + p.tool : ""}`; setState(r.speaker, r.ok ? `${p.preference}/${p.intent ?? "contribute"}` : "err:intention"); return r;
        });
    }));
    if (!roomGen.accepts(roundTok)) return 0; // the room changed while seats were thinking
    // Intentions carry a one-line topic. A seat that pastes its whole answer into the poll must not
    // have it shown to the room: the others then defer to a reply that was never published.
    const intentionLine = (p: any) => {
      const kind = [p?.preference, p?.intent].filter(Boolean).join("/");
      const topic = String(p?.topic ?? "").slice(0, 160);
      return `${kind}: ${topic}${p?.tool ? ` ⚙ ${p.tool}` : ""}`;
    };
    const summary = intents.map((r) => !r.ok ? `${r.speaker}: ERROR ${r.error}` : (r as any).skipped ? `${r.speaker}: (not polled, nothing new)` : `${r.speaker}: ${intentionLine(r.payload)}`).join("\n");
    if (!only) {
      publish({ author: "host", kind: "intention", text: summary });
      for (const r of intents) if (!r.ok) { diag(r, "intention"); publish({ author: r.speaker, kind: "error", text: `intention failed: ${r.error}` }); }
    }
    saveSessions();

    const candidates = free.filter((s) => { const r = intents.find((i) => i.speaker === s.meta.id); return r?.ok && (r.payload as any).preference === "speak" && !s.inflight; });
    for (const s of free) if (!candidates.includes(s)) setState(s.meta.id, "listening");
    if (!candidates.length) { if (pendingReplies === 0 && !paused) { ctx.ui.setStatus("committee", "idle"); afterRound(ctx, state); } return 0; } // nobody speaks: still deliver anything queued meanwhile

    const asHuman = lastHumanId;
    const alone = candidates.length === 1;
    for (const s of candidates) {
      const extra = alone
        ? `Nobody else wants to speak this cycle; you have the floor.${s.meta.tools ? " Use your tools now if your intention needed a lookup." : ""} Put the contribution in text with action "speak".\n`
        : `Everyone's intentions:\n${summary}\nHold (action wait or silent, empty text) or respond now (action speak, contribution in text).${s.meta.tools ? " If you respond and your intention needed a lookup, use your tools first." : ""}\n`;
      dispatch(ctx, s, extra, asHuman, state);
    }
    return candidates.length;
  }

  /** fire a reply without awaiting it; the seat stays on the floor while it works, everyone else keeps going */
  const dispatch = (ctx: ExtensionContext, s: (typeof speakers)[number], extra: string, asHuman: string, state: RoundState) => {
    const tok = roomGen.capture();
    s.inflight = true; pendingReplies++; syncBusy();
    setState(s.meta.id, s.meta.tools ? "working" : "replying");
    void s.session.send(packet(s, "respond", extra), responseSchema, budget(s))
      .then((r) => {
        if (!roomGen.accepts(tok)) return;
        account(r, "respond");
        if (r.ok) s.sent = s.pendingSent ?? s.sent;
        const published = takeReply(r);
        if (published > 0) answeredHumans.add(asHuman);
        state.spoke += published;
        s.inflight = false; pendingReplies--; syncBusy(); saveSessions(); refresh();
        // this seat alone catches up on anything said while it worked; it does not wait for co-respondents
        if (lastHumanId && lastHumanId !== asHuman) {
          if (paused) return; // catch-up waits for /committee resume
          // routed message addressed to other seats: this seat does not catch up, and the queued request stays for its recipient
          const f = focusOf(lastHumanText);
          if (f && !f.has(s.meta.id)) { if (pendingReplies === 0) afterRound(ctx, state); return; }
          ctx.ui.notify(`${s.meta.id} answered before your latest message; catching it up now`, "info");
          if (queued.length) { queued.splice(0); drawQueue(ctx); }
          void round(ctx, state, s); return;
        }
        if (pendingReplies === 0) afterRound(ctx, state);
      })
      .catch((e) => {
        if (!roomGen.accepts(tok)) return;
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
    if (paused) return;
    if (queued.length) {
      // already published at input time; only the round was held back
      const focus = focusOfQueue(); queued.splice(0); drawQueue(ctx); const fresh = newState(focus); void round(ctx, fresh); return;
    }
    if (state.spoke === 0 && forceAnswer(ctx, state)) return;
    if (state.spoke > 0 && state.left > 0) { state.left--; void round(ctx, state); }
    else if (state.spoke > 0) { ctx.ui.setStatus("committee", "idle"); ctx.ui.notify(`stopped after ${cap()} rounds (safety limit); type again to continue`, "info"); }
  };

  pi.on("input", async (event, ctx) => {
    activeCtx = ctx;
    if (!active || event.source === "extension" || event.text.startsWith("/")) return { action: "continue" };
    cycleNo++;
    publish({ author: "you", kind: "human", text: event.text });
    lastHumanId = events[events.length - 1]?.id ?? "";
    lastHumanText = event.text;
    if (paused) { heldWhilePaused = true; pausedTexts.push(event.text); ctx.ui.notify("paused: logged, nobody answers until /committee resume", "warning"); return { action: "handled" }; }
    // every seat is busy: the message is in the room already, so the first seat to finish reads it and
    // catches up; the round itself waits for a free seat
    const focus = focusOf(event.text);
    const eligible = freeSeats().filter((s) => !focus || focus.has(s.meta.id));
    if (speakers.length && eligible.length === 0) {
      queued.push(event.text); drawQueue(ctx);
      ctx.ui.setStatus("committee", `waiting · ${queued.length}`);
      ctx.ui.notify(`waiting for a free seat (${queued.length}): your message is already in the room and will be read when a seat returns · /queue lists`, "info");
      return { action: "handled" };
    }
    await round(ctx, newState(focus));
    return { action: "handled" };
  });
  async function runCycles(ctx: ExtensionContext) {
    const texts = [...queued, ...pausedTexts];
    const focus = cfg.tagRouting ? focusFromQueue(texts, seatTags()) : undefined;
    pausedTexts.length = 0;
    if (queued.length) { queued.splice(0); drawQueue(ctx); }
    await round(ctx, newState(focus));
  }

  pi.on("session_shutdown", async () => { if (ticker) clearInterval(ticker); saveSessions(); for (const s of speakers) s.session.close(); });
}

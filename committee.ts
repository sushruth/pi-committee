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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, fuzzyFilter, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { Speaker, opencodeVariants, type Cli, type ToolUse, type TurnResult } from "./speaker.ts";
import intentionSchema from "./schemas/intention.schema.json";
import responseSchema from "./schemas/response.schema.json";

interface Config {
  speakers: Seat[];
  former?: Ghost[];
  etiquette: string;
  /** what every seat should know about this folder: text, or a path to a file (relative to the room, or ~) */
  brief?: string;
  timeoutSeconds?: number;
}
interface Seat { id: string; cli: Cli; model: string; thinking?: string; persona?: string; tools?: boolean }
// a seat that left the room; its lines stay in the transcript, it stays visible as a pale dot
interface Ghost { id: string; cli: Cli; model: string; thinking?: string; left: string }
type Kind = "human" | "speak" | "error" | "intention" | "usage" | "tool";
interface Event { id: string; cycle: number; author: string; text: string; kind: Kind; data?: unknown }
interface Stat { state: string; fresh: number; cached: number; out: number; cost: number; calls: number; turns: number; lastSpoke: number; lastIntent?: string; lastReply?: string }
interface Saved { cli: Cli; model: string; thinking?: string; tools?: boolean; session_id?: string; sent: number; rules?: string }
const PUBLIC: Kind[] = ["human", "speak", "error", "tool"];
const TOOL_OUTPUT_CAP = 1500;

export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();
  const cfgPath = join(cwd, "committee.json");
  const cfg: Config = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, "utf8"))
    : { speakers: [], etiquette: "Be conversational and brief. Silence is welcome. Yield when someone else covers your point. Humans can speak at any time. Nobody schedules turns." };
  const dir = join(cwd, "committee");
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, "events.jsonl");
  const diagPath = join(dir, "diag.jsonl");
  const sessPath = join(dir, "sessions.json");
  const timeoutMs = (cfg.timeoutSeconds ?? 120) * 1000;

  // ---- sessions: resume a speaker's native session only if cli+model match what was saved
  const saved: Record<string, Saved> = existsSync(sessPath) ? JSON.parse(readFileSync(sessPath, "utf8")) : {};
  const makeSeat = (meta: Seat) => {
    const prev = saved[meta.id];
    const match = prev && prev.cli === meta.cli && prev.model === meta.model && (prev.thinking ?? "") === (meta.thinking ?? "") && !!prev.tools === !!meta.tools;
    return {
      meta,
      session: new Speaker({ id: meta.id, cli: meta.cli, model: meta.model, thinking: meta.thinking, cwd, session_id: match ? prev.session_id : undefined, tools: meta.tools, onTool: (t) => onTool(meta.id, t) }),
      sent: match ? prev.sent : 0,
      rulesSeen: match ? prev.rules : undefined,
      stat: { state: "idle", fresh: 0, cached: 0, out: 0, cost: 0, calls: 0, turns: 0, lastSpoke: 0 } as Stat,
    };
  };
  const speakers = cfg.speakers.map(makeSeat);
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
  let paused = false;
  let heldWhilePaused = false;
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
  const stateColor = (st: string) => st.startsWith("err") ? 196 : st === "thinking" || st === "deciding" ? 220 : st === "speaking" ? 214 : st === "spoke" ? 42 : st === "idle" ? 244 : 250;
  const glyph = (st: string) => st === "idle" ? "·" : st.startsWith("err") ? "✗" : st === "thinking" || st === "deciding" ? "◌" : st === "speaking" ? "●" : st === "spoke" ? "✓" : "○";
  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

  // ---- public state (append-only; replayed from disk on start)
  const events: Event[] = [];
  let cycleNo = 0;
  let floorHolder: string | null = null;
  const record = (ev: Event) => {
    events.push(ev);
    if (ev.kind === "speak") { const st = byId(ev.author)?.stat; if (st) { st.turns++; st.lastSpoke = ev.cycle; } floorHolder = ev.author; }
    if (ev.kind === "human") cycleNo = ev.cycle;
  };
  const publish = (e: Omit<Event, "id" | "cycle">) => {
    const ev: Event = { id: `event-${events.length + 1}`, cycle: cycleNo, ...e };
    record(ev);
    appendFileSync(logPath, JSON.stringify({ ts: Date.now(), ...ev }) + "\n");
    if (PUBLIC.includes(ev.kind)) pi.sendMessage({ customType: "committee", content: ev.text, display: true, details: ev });
    return ev;
  };
  // a seat's tool call and result become one public event so the whole room sees it once
  const onTool = (id: string, t: ToolUse) => {
    const cut = t.output.length - TOOL_OUTPUT_CAP;
    const out = cut > 0 ? t.output.slice(0, TOOL_OUTPUT_CAP) + `\n… (${cut} more characters; ${id} saw them all)` : t.output;
    publish({ author: id, kind: "tool", text: `${t.name} ${t.input}\n${out}`.trim(), data: { tool: t.name } });
  };
  const diag = (r: TurnResult, phase: string) => appendFileSync(diagPath, JSON.stringify({ ts: Date.now(), phase, speaker: r.speaker, error: r.error, raw: r.raw }) + "\n");
  if (existsSync(logPath)) {
    let c = 0;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line);
      if (e.kind === "human") c++;
      record({ id: e.id, cycle: e.cycle ?? c, author: e.author, text: e.text, kind: e.kind });
    }
  }

  // ---- usage: exact per call, logged and accumulated
  const account = (r: TurnResult, phase: string) => {
    const s = byId(r.speaker); if (!s) return;
    s.stat.calls++;
    if (r.usage) { s.stat.fresh += r.usage.fresh; s.stat.cached += r.usage.cached; s.stat.out += r.usage.out; s.stat.cost += r.usage.cost ?? 0; }
    publish({ author: r.speaker, kind: "usage", text: `${phase}: fresh ${r.usage?.fresh ?? "?"} cached ${r.usage?.cached ?? "?"} out ${r.usage?.out ?? "?"}${r.usage?.cost != null ? ` $${r.usage.cost.toFixed(4)}` : ""}${r.resumed ? " (resumed)" : ""}`, data: { phase, ...r.usage, resumed: r.resumed, ok: r.ok } });
  };

  // ---- UI: compact status line by default, /usage toggles the table; footer = totals
  let ui: ExtensionContext["ui"] | undefined;
  let showTable = false;
  const col = (t: string, w: number, right = false) => { const p = " ".repeat(Math.max(0, w - visibleWidth(t))); return right ? p + t : t + p; };
  let openSeat: string | null = null;
  let widgetTui: { requestRender(): void } | undefined;
  const seatMeta = (s: Seat) => `${s.cli}:${s.model.split("/").pop()}${s.thinking ? " #" + s.thinking : ""}${s.tools ? " ⚙" : ""}`;
  const SEP = ` ${ansi(240, "·")} `;
  const GAP = 3; // visible width of SEP
  const ABOUT = "(⚒)"; // openSeat value when the logo panel is open
  const LOGO = () => ansi(openSeat === ABOUT ? 250 : 244, ABOUT) + "  ";
  const initials = (id: string) => id.split(/[-_\s]+/).filter(Boolean).map((w) => w[0]).join("").slice(0, 3);
  const seatCell = (s: (typeof speakers)[number]) => {
    // ○ normally, ◉ when this seat's panel is open: same glyph family, same size, concentric
    const dot = openSeat === s.meta.id ? "◍" : "◯";
    return `${ansi(colorOf(s.meta.id), dot + " " + initials(s.meta.id))} ${ansi(stateColor(s.stat.state), s.stat.state)}`;
  };
  const ghostCell = (g: Ghost) => ansi(240, `${openSeat === g.id ? "◍" : "◌"} ${initials(g.id)} gone`);
  const cells = () => [...speakers.map((s) => ({ id: s.meta.id, text: seatCell(s) })), ...former.map((g) => ({ id: g.id, text: ghostCell(g) }))];
  const statusLines = () => [LOGO() + cells().map((c) => c.text).join(SEP)];
  // panel for the clicked seat: full identity in the title, then state, last intention, last reply;
  // its bottom border opens over that seat's dot so the two read as one piece
  const detailLines = (width: number) => {
    const inner = Math.max(20, width - 4);
    const dim = (t: string) => ansi(244, t);
    const frame = (title: string, body: string[]) => {
      const t = truncateToWidth(title, Math.max(10, width - 4));
      const top = dim("╭─" + t + "─".repeat(Math.max(0, width - 3 - visibleWidth(t))) + "╮");
      const bottom = dim("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
      return [top, ...body.map((l) => `${dim("│")} ${l}${" ".repeat(Math.max(0, inner - visibleWidth(l)))} ${dim("│")}`), bottom];
    };
    if (openSeat === ABOUT) {
      const t = speakers.reduce((a, s) => ({ fresh: a.fresh + s.stat.fresh, cached: a.cached + s.stat.cached, out: a.out + s.stat.out, calls: a.calls + s.stat.calls, cost: a.cost + s.stat.cost }), { fresh: 0, cached: 0, out: 0, calls: 0, cost: 0 });
      const pub = events.filter((e) => PUBLIC.includes(e.kind));
      const row = (label: string, text: string) => wrapTextWithAnsi(`${ansi(250, label.padEnd(10))}${text}`, inner);
      return frame(" pi-committee ", [
        ...row("what", "a room of independent LLM speakers; each states an intention, sees the others', and decides for itself whether to speak. No facilitator."),
        ...row("room", cwd),
        ...row("seats", `${speakers.length} live${former.length ? `, ${former.length} former` : ""} · ${cfg.etiquette}`),
        ...row("so far", `cycle ${cycleNo} · ${pub.length} messages · ${t.calls} calls`),
        ...row("tokens", `fresh ${fmt(t.fresh)} · cached ${fmt(t.cached)} · out ${fmt(t.out)}`),
        ...row("cost", t.cost ? `$${t.cost.toFixed(3)} (providers that report it)` : "not reported by these providers"),
        ...row("source", "github.com/sushruth/pi-committee · /committee · /seats · /usage"),
      ]);
    }
    const s = openSeat ? byId(openSeat) : undefined;
    const g = openSeat && !s ? ghostOf(openSeat) : undefined;
    if (!s && !g) return [];
    const row = (label: string, text: string) => wrapTextWithAnsi(`${ansi(colorOf(openSeat!), label.padEnd(10))}${text}`, inner);
    const body = s
      ? [...row("state", `${glyph(s.stat.state)} ${s.stat.state}`), ...row("intention", s.stat.lastIntent ?? "(none yet)"), ...row("reply", s.stat.lastReply ?? "(none yet)")]
      : [...row("state", `◌ gone, left after ${g!.left}`), ...row("was", seatMeta(g!))];
    const m = s?.meta ?? g!;
    return frame(` ${m.id} · ${m.cli}:${m.model} ${m.thinking ? "#" + m.thinking + " " : ""}`, body);
  };
  const widgetFactory = (tui: { requestRender(): void }) => {
    widgetTui = tui;
    return {
      invalidate() {},
      render(width: number) { return [...detailLines(width), ...statusLines().map((l) => truncateToWidth(l, width))]; },
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
    const header = `${col("", idW)} ${col(dim("cli/model"), modelW)} ${col(dim("calls"), 6, true)} ${col(dim("fresh in"), 9, true)} ${col(dim("cached in"), 10, true)} ${col(dim("out"), 7, true)} ${col(dim("$"), 8, true)}  ${dim("state")}`;
    const rows = speakers.map((s) => `${col(tag(s.meta.id), idW)} ${col(dim(truncateToWidth(short(s), modelW)), modelW)} ${col(String(s.stat.calls), 6, true)} ${col(fmt(s.stat.fresh), 9, true)} ${col(dim(fmt(s.stat.cached)), 10, true)} ${col(fmt(s.stat.out), 7, true)} ${col(s.stat.cost ? s.stat.cost.toFixed(3) : dim("n/a"), 8, true)}  ${ansi(stateColor(s.stat.state), `${glyph(s.stat.state)} ${s.stat.state}`)}`);
    widgetTui = undefined;
    ui?.setWidget("committee", [header, ...rows]);
  };
  const setState = (id: string, state: string) => { const s = byId(id); if (s) s.stat.state = state; refresh(); };

  pi.on("session_start", async (_e, ctx) => {
    ui = ctx.ui;
    footerFactory = (_tui, theme) => ({
      dispose() {}, invalidate() {},
      render(width: number) {
        const t = speakers.reduce((a, s) => ({ fresh: a.fresh + s.stat.fresh, cached: a.cached + s.stat.cached, out: a.out + s.stat.out, calls: a.calls + s.stat.calls }), { fresh: 0, cached: 0, out: 0, calls: 0 });
        return [truncateToWidth(theme.fg("dim", `committee host: pi extension · ${speakers.length} speakers · cycle ${cycleNo} · ${t.calls} calls · fresh ${fmt(t.fresh)} · cached ${fmt(t.cached)} · out ${fmt(t.out)}`), width)];
      },
    });
    if (speakers.length) await checkEngines(ctx);
    applyMode(ctx);
    for (const ev of events) if (PUBLIC.includes(ev.kind)) pi.sendMessage({ customType: "committee", content: ev.text, display: true, details: ev });
    const resumed = speakers.filter((s) => s.sent > 0).map((s) => s.meta.id);
    if (!speakers.length) ctx.ui.notify("committee: no seats in this folder yet · /committee on to set up", "info");
    if (events.length) ctx.ui.notify(`replayed ${events.filter((e) => PUBLIC.includes(e.kind)).length} messages; resuming sessions for ${resumed.length ? resumed.join(", ") : "nobody"}`, "info");
    refresh();
  });

  pi.registerCommand("usage", {
    description: "Toggle the per-speaker token usage table above the editor",
    handler: async () => { showTable = !showTable; refresh(); },
  });

  const run = (cmd: string, args: string[]) => new Promise<string>((res) => execFile(cmd, args, { maxBuffer: 1 << 24 }, (_e, out) => res(String(out ?? ""))));
  const modelsFor = async (cli: Cli): Promise<string[]> => {
    if (cli === "claude") return ["opus", "sonnet", "haiku"];
    if (cli === "codex") { try { const j = JSON.parse(readFileSync(join(homedir(), ".codex", "models_cache.json"), "utf8")); return (j.models ?? []).map((m: any) => m.slug ?? m.id).filter(Boolean); } catch { return []; } }
    if (cli === "cursor") return (await run("cursor-agent", ["--list-models"])).split("\n").map((l) => l.split(" - ")[0].trim()).filter((l) => l && !l.startsWith("Available"));
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
  const thinkingFor = (cli: Cli) => cli === "claude" ? ["low", "medium", "high", "xhigh", "max"] : cli === "codex" ? ["minimal", "low", "medium", "high", "xhigh"] : cli === "opencode" ? ["none", "minimal", "low", "medium", "high", "xhigh", "max"] : [];
  const pickThinking = async (ctx: ExtensionContext, cli: Cli, current?: string, model?: string) => {
    // opencode variants differ per model; the live list beats the generic ladder
    const list = cli === "opencode" && model ? (await opencodeVariants(cwd, model)).concat() : thinkingFor(cli);
    if (cli === "opencode" && model && !list.length) ctx.ui.notify("opencode lists no variants for this model; the generic ladder is shown, the model may reject some", "warning");
    if (cli === "opencode" && !list.length) list.push(...thinkingFor(cli));
    if (!list.length) { ctx.ui.notify("cursor sets thinking in the model id (e.g. glm-5.2-high)", "info"); return current; }
    const v = await ctx.ui.select(`Thinking (${cli})`, [current ?? DEFAULT, ...[DEFAULT, ...list].filter((x) => x !== (current ?? DEFAULT))]);
    return v === undefined ? undefined : v === DEFAULT ? "" : v;
  };
  const seatsPath = join(cwd, "committee.json");
  const saveSeats = () => { cfg.speakers = speakers.map((s) => s.meta); cfg.former = former; writeFileSync(seatsPath, JSON.stringify(cfg, null, 2) + "\n"); saveSessions(); refresh(); };
  const seatLine = (s: Seat) => `${s.id}: ${s.cli} ${s.model}${s.thinking ? ` #${s.thinking}` : ""}${s.tools ? " ⚙" : ""}`;
  let active = speakers.length > 0;
  let footerFactory: Parameters<ExtensionContext["ui"]["setFooter"]>[0] | undefined;
  const applyMode = (ctx: ExtensionContext) => {
    if (active) { ctx.ui.setFooter(footerFactory); refresh(); ctx.ui.setStatus("committee", "idle"); }
    else { ctx.ui.setFooter(undefined); widgetTui = undefined; ctx.ui.setWidget("committee", undefined); ctx.ui.setStatus("committee", undefined); }
  };
  // ---- onboarding: which CLIs exist, which are worth using, then one seat at a time
  const CLI_NOTE: Record<Cli, string> = {
    opencode: "recommended · any provider you are logged into, ~100 fresh tokens per call",
    claude: "recommended · ~1.5k tokens per call with the committee flags",
    codex: "not supported yet · ~27k tokens of its own prompt on every call",
    cursor: "not supported yet · ~11k tokens of its own prompt on every call",
  };
  const SUPPORTED: Cli[] = ["opencode", "claude"];
  const installed = async (): Promise<Cli[]> => {
    const out: Cli[] = [];
    for (const cli of ["claude", "codex", "cursor", "opencode"] as Cli[]) if ((await run("which", [cli === "cursor" ? "cursor-agent" : cli])).trim()) out.push(cli);
    return out;
  };
  const ADVERBS = ["quietly", "simply", "boldly", "oddly", "nearly", "mostly", "barely", "wildly", "gently", "sharply", "plainly", "slowly", "briskly", "warmly", "coolly", "deeply"];
  const ADJECTIVES = ["excellent", "exhausted", "curious", "stubborn", "cheerful", "skeptical", "patient", "restless", "precise", "hungry", "sleepy", "fearless", "honest", "nervous", "tidy", "grumpy"];
  const randomName = () => { const p = (a: string[]) => a[Math.floor(Math.random() * a.length)]; let n = `${p(ADVERBS)}-${p(ADJECTIVES)}`; while (byId(n)) n = `${p(ADVERBS)}-${p(ADJECTIVES)}`; return n; };
  const cliLabel = (cli: Cli) => SUPPORTED.includes(cli) ? `${cli}  ${ansi(244, CLI_NOTE[cli])}` : ansi(240, `${cli}  ${CLI_NOTE[cli]}`);
  const pickEngine = async (ctx: ExtensionContext, clis: Cli[]): Promise<Pick<Seat, "cli" | "model" | "thinking" | "tools"> | undefined> => {
    const pick = await ctx.ui.select("Which CLI runs this seat?", clis.map(cliLabel));
    if (!pick) return;
    const cli = clis[clis.map(cliLabel).indexOf(pick)];
    if (!SUPPORTED.includes(cli)) { ctx.ui.notify(`${cli} is not supported yet: ${CLI_NOTE[cli]}`, "warning"); return pickEngine(ctx, clis); }
    const model = await pickModel(ctx, cli);
    if (!model) return;
    const thinking = (await pickThinking(ctx, cli, undefined, model)) || undefined;
    const t = await ctx.ui.select("Tools for this seat?", ["none", "read-only (read, grep, glob, shell)"]);
    if (t === undefined) return;
    return { cli, model, thinking, tools: t !== "none" || undefined };
  };
  const addSeatFlow = async (ctx: ExtensionContext): Promise<boolean> => {
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
  pi.registerCommand("committee", {
    description: "Toggle committee mode: on = your input goes to the committee; off = pi works as usual; pause/resume = hold the seats; brief <text|path> = what seats should know about this folder (- clears); reset = delete this folder's committee.json and committee/",
    handler: async (args, ctx) => {
      if (args.trim() === "pause") return pause(ctx);
      if (args.trim() === "resume") {
        paused = false; ctx.ui.setStatus("committee", "idle");
        if (heldWhilePaused && !busy) { heldWhilePaused = false; await runCycles(ctx); }
        return ctx.ui.notify("resumed", "info");
      }
      if (args.trim().startsWith("brief")) {
        const v = args.trim().slice(5).trim();
        if (!v) return ctx.ui.notify(cfg.brief ? `brief: ${cfg.brief}` : "no brief; /committee brief <text or file path>", "info");
        cfg.brief = v === "-" ? undefined : v; saveSeats();
        return ctx.ui.notify(cfg.brief ? "brief set; every seat gets it on its next call" : "brief removed", "info");
      }
      if (args.trim() === "reset") {
        if (busy) return ctx.ui.notify("wait for the committee to settle first", "warning");
        const n = events.filter((e) => PUBLIC.includes(e.kind)).length;
        const ok = await ctx.ui.select(`Are you sure? This removes the folder's committee: ${speakers.length} seats, ${n} messages, every session? committee.json and committee/ are deleted.`, ["no, keep it", "yes, I am sure"]);
        if (ok !== "yes, I am sure") return;
        for (const s of speakers) s.session.close();
        rmSync(seatsPath, { force: true }); rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
        events.length = 0; cycleNo = 0; floorHolder = null; lastLedger.clear(); openSeat = null;
        for (const k of Object.keys(saved)) delete saved[k];
        speakers.length = 0; former.length = 0; cfg.speakers = []; cfg.former = [];
        active = false; applyMode(ctx);
        return ctx.ui.notify("committee removed from this folder. /committee on sets up a new one. Messages above are history only; /clear drops them from view.", "info");
      }
      const want = args.trim() === "on" ? true : args.trim() === "off" ? false : !active;
      if (busy && !want) return ctx.ui.notify("wait for the committee to settle first", "warning");
      if (want && speakers.length === 0 && !(await onboarding(ctx))) return ctx.ui.notify("no seats, committee stays off", "warning");
      active = want; applyMode(ctx);
      ctx.ui.notify(`committee mode ${active ? "on" : "off"}`, "info");
    },
  });

  pi.registerCommand("seats", {
    description: "Add, remove or change a seat (cli + model + thinking); saved to committee.json",
    handler: async (_args, ctx) => {
      if (busy) return ctx.ui.notify("wait for the committee to settle first", "warning");
      const pick = await ctx.ui.select("Seats", [...speakers.map((s) => seatLine(s.meta)), "+ add a seat"]);
      if (!pick) return;
      if (pick === "+ add a seat") { await addSeatFlow(ctx); return; }
      const s = speakers.find((x) => seatLine(x.meta) === pick)!;
      const action = await ctx.ui.select(`Seat ${s.meta.id}`, ["change model", "change thinking", s.meta.tools ? "take tools away" : "give read-only tools", "remove seat"]);
      if (!action) return;
      if (action.includes("tools")) {
        const meta: Seat = { ...s.meta, tools: !s.meta.tools || undefined };
        s.session.close(); Object.assign(s, makeSeat(meta)); saveSeats();
        return ctx.ui.notify(`${s.meta.id} ${meta.tools ? "has read-only tools" : "has no tools"} (fresh session)`, "info");
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
        const bar = ansi(color, "▏");
        const body = wrapTextWithAnsi(d.kind === "tool" ? ansi(244, message.content) : message.content, Math.max(20, width - outputPad - 2));
        const seat = d.kind === "human" || d.kind === "tool" ? undefined : byId(d.author)?.meta ?? ghostOf(d.author);
        const who = seat ? [`${pad}${bar}${ansi(244, seatMeta(seat))}`] : [];
        return [`${pad}${bar}${name}`, ...who, ...body.map((l) => `${pad}${bar}${l}`)];
      },
    };
  });

  // ---- packets: preamble + rules + full transcript once per session, then only the delta
  const roster = () => speakers.map(({ meta: s }) => { const p = personaOf(s); return `- ${s.id} (${s.cli} ${s.model}${s.tools ? ", has read-only tools" : ""})${p ? `: ${p}` : ""}`; }).join("\n")
    + (former.length ? `\nFormer, no longer in the room (do not address them): ${former.map((g) => `${g.id} (left after ${g.left})`).join(", ")}` : "");
  const ledger = () => speakers.map((s) => `${s.meta.id} ${s.stat.turns}x${s.stat.lastSpoke ? `@c${s.stat.lastSpoke}` : ""}`).join(", ") + `; floor: ${floorHolder ?? "nobody"}`;
  const rules = `Floor rules (self-governed, nobody schedules turns): normally one speaker per cycle. Speak only when you add something the others' intentions do not cover. Defer to speakers who have spoken less. Whoever last held the floor may keep it to finish a thought. If several speak at once, fine; do not re-litigate, just be brief. Only what appears in the transcript was said; never cite an intention as if it were spoken. Contributions are at most 120 words unless your intention said length "long". If you ever have tools, keep their output short: ask for the smallest result that answers the question, since everything you bring back is read by the whole room.
A human message never goes unanswered: if nobody has anything new to add, whoever answered the human most recently responds with action "repeat" and the event id of that earlier reply in ref, so it is shown again instead of silence.
Tools: some seats have read-only tools (read files, grep, glob, a shell for inspection) in the room folder. Nobody tells you where you are: the first time a question needs the code or data, orient yourself (list the room folder, read a README or AGENTS file, find the repo or dataset the question is about) and say in one line what you found so the others need not. When a question needs measuring, measure before proposing, and split the lookups between the seats that have tools rather than all running the same one. If your turn needs a lookup, say what you would run in the intention's "tool" field, one line. Run tools only in the respond phase when you actually speak; if another seat's intention names the same lookup and it has spoken less, leave it to them. Lines marked ⚙ in the transcript are tool calls and results already made: reuse them, never repeat them. Plan and report; never create, change or delete anything unless the human says so, and even then only seats whose tools allow it.
Two phases, always as JSON: "intention" (do you have something to add; topic is one sentence under 20 words), then "respond" (you see everyone's intentions and either hold, with action wait or silent, respond, with action speak and the contribution in text, or re-show an earlier reply of yours, with action repeat and its event id in ref).`;
  const rulesText = () => `Etiquette: ${cfg.etiquette}\n${rules}${briefOf() ? `\nAbout this room, from the human who set it up:\n${briefOf()}` : ""}`;
  const rulesVersion = () => createHash("sha1").update(rulesText()).digest("hex").slice(0, 8);
  const line = (e: Event) => `[${e.id} ${e.author}${e.kind === "tool" ? " ⚙" : ""}] ${e.text}`;
  const lastLedger = new Map<string, string>();
  const packet = (s: (typeof speakers)[number], phase: string, extra: string) => {
    const me = s.meta;
    const pub = events.filter((e) => PUBLIC.includes(e.kind));
    // a seat's own tool events are already in its session; the others' are new to it
    const fresh = pub.slice(s.sent).filter((e) => !(e.kind === "tool" && e.author === me.id));
    const first = s.sent === 0;
    s.sent = pub.length;
    const l = ledger();
    const ledgerLine = l !== lastLedger.get(me.id) ? `Ledger (times spoken, last cycle): ${l}\n` : "";
    lastLedger.set(me.id, l);
    const v = rulesVersion();
    const rulesBlock = first ? `${rulesText()}\n` : s.rulesSeen !== v ? `The room's rules changed; this replaces what you had:\n${rulesText()}\n\n` : "";
    s.rulesSeen = v;
    const head = first
      ? `You are "${me.id}" (${me.cli} ${me.model}) in a committee conversation with humans and other models.${personaOf(me) ? ` Persona: ${personaOf(me)}` : " Speak as yourself; no assigned role."}${me.tools ? ` You have read-only tools; the room folder is ${cwd}.` : " You have no tools."}\n${rulesBlock}Roster:\n${roster()}\n\nTranscript so far:\n${fresh.map(line).join("\n") || "(empty)"}\n\n`
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
    if (p.action === "speak" && p.text.trim()) { setState(r.speaker, "spoke"); publish({ author: r.speaker, kind: "speak", text: p.text.trim() }); return 1; }
    setState(r.speaker, p.action); return 0;
  };
  async function cycle() {
    cycleNo++;
    for (const s of speakers) setState(s.meta.id, "thinking");
    const intents = await Promise.all(speakers.map((s) =>
      s.session.send(packet(s, "intention", ""), intentionSchema, timeoutMs)
        .then((r) => { account(r, "intention"); const p = r.payload as any; const st = byId(r.speaker)?.stat; if (st && r.ok) st.lastIntent = `${p.preference}/${p.intent ?? "contribute"}: ${p.topic}${p.tool ? " ⚙ " + p.tool : ""}`; setState(r.speaker, r.ok ? `${p.preference}/${p.intent ?? "contribute"}` : "err:intention"); return r; })));
    const summary = intents.map((r) => r.ok ? `${r.speaker}: ${JSON.stringify(r.payload)}` : `${r.speaker}: ERROR ${r.error}`).join("\n");
    publish({ author: "host", kind: "intention", text: summary });
    for (const r of intents) if (!r.ok) { diag(r, "intention"); publish({ author: r.speaker, kind: "error", text: `intention failed: ${r.error}` }); }
    saveSessions();

    const candidates = speakers.filter((s) => { const r = intents.find((i) => i.speaker === s.meta.id); return r?.ok && (r.payload as any).preference === "speak"; });
    for (const s of speakers) if (!candidates.includes(s)) setState(s.meta.id, "listening");
    if (candidates.length === 0) return 0;

    // one speaker wants the floor and nobody else does: nothing to weigh, let it speak
    if (candidates.length === 1) {
      const s = candidates[0];
      setState(s.meta.id, "speaking");
      const r = await s.session.send(packet(s, "respond", `Nobody else wants to speak this cycle; you have the floor.${s.meta.tools ? " Use your tools now if your intention needed a lookup." : ""} Put the contribution in text with action "speak".\n`), responseSchema, timeoutMs);
      account(r, "respond"); saveSessions();
      return takeReply(r);
    }

    for (const s of candidates) setState(s.meta.id, "deciding");
    let spoke = 0;
    await Promise.all(candidates.map((s) =>
      s.session.send(packet(s, "respond", `Everyone's intentions:\n${summary}\nHold (action wait or silent, empty text) or respond now (action speak, contribution in text).${s.meta.tools ? " If you respond and your intention needed a lookup, use your tools first." : ""}\n`), responseSchema, timeoutMs)
        .then((r) => { account(r, "respond"); spoke += takeReply(r); })));
    saveSessions();
    return spoke;
  }

  pi.on("input", async (event, ctx) => {
    if (!active || event.source === "extension" || event.text.startsWith("/")) return { action: "continue" };
    if (busy) { ctx.ui.notify("committee still settling, wait a moment", "warning"); return { action: "handled" }; }
    cycleNo++;
    publish({ author: "you", kind: "human", text: event.text });
    if (paused) { heldWhilePaused = true; ctx.ui.notify("paused: logged, nobody answers until /committee resume", "warning"); return { action: "handled" }; }
    await runCycles(ctx);
    return { action: "handled" };
  });
  async function runCycles(ctx: ExtensionContext) {
    busy = true;
    try {
      let n = 0;
      do { ctx.ui.setStatus("committee", `cycle ${++n}`); } while (!paused && (await cycle()) > 0);
      ctx.ui.setStatus("committee", paused ? "paused" : "idle");
      refresh();
    } finally { busy = false; }
  }

  pi.on("session_shutdown", async () => { saveSessions(); for (const s of speakers) s.session.close(); });
}

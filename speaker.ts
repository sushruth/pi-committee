import { CumulativeCost } from "./accounting.ts";
// One speaker = one native session on one CLI, kept open for the whole conversation
// and resumed across host restarts by its session id. Every call carries only new
// material; the CLI's own context/cache holds the rest. The JSON schema for a call
// goes in the prompt text and the reply is parsed and checked locally, so one
// session serves every phase.
//
// claude:   long-lived `claude -p --input-format stream-json --output-format stream-json`
//           (+ --resume <id>); JSON user messages on stdin, JSONL events on stdout.
// codex:    long-lived `codex app-server` (JSON-RPC over stdio); thread/start or thread/resume,
//           turn/start per message; answer = last agentMessage before turn/completed.
// opencode: one shared `opencode serve` per host, one session per speaker over HTTP
//           (any provider opencode is logged into); a tool-less "speaker" agent is passed inline.
// pi:       one `pi -p --mode json` process per message, --session-id resumes; its own system prompt is replaced.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";

export type Cli = "claude" | "codex" | "opencode" | "pi";

export interface SpeakerOpts {
  id: string;
  cli: Cli;
  model: string;
  cwd?: string;
  /** reasoning effort: claude --effort, codex turn effort, opencode model variant, pi --thinking */
  thinking?: string;
  /** native session id from a previous run; the adapter resumes it, or starts fresh if that fails */
  session_id?: string;
  /** "read": read, grep, glob, shell for inspection; "all": everything the CLI has, writes included. Tool work stays in the seat's session; the result only counts it */
  tools?: Tools;
  /** live: the tool the seat is running right now (null when none); for the host's status line only */
  onActivity?: (text: string | null) => void;
}
export interface ToolWork { calls: number; chars: number }
export type Tools = "read" | "all";

export interface Usage { fresh: number; cached: number; out: number; cost?: number; costScope?: "call"; /** input of the last model step: the session's live context size */ ctx?: number }

export interface TurnResult {
  speaker: string;
  ok: boolean;
  session_id?: string;
  /** true when the native session was resumed from `opts.session_id` (so its memory is intact) */
  resumed?: boolean;
  payload?: unknown;
  error?: string;
  usage?: Usage;
  /** how much tool work the seat did for this reply; the room never sees the calls themselves */
  tools?: ToolWork;
  raw?: unknown;
}

const SPEAKER_PROMPT = "You are one participant in a text conversation among humans and other models. You have no tools and no files. Reply only with the JSON the host asks for.";
const TOOLS_PROMPT = "You are one participant in a text conversation among humans and other models. You have read-only tools: read files, grep, glob, and a shell for inspection. Never create, change or delete anything. Everything a tool returns is shown to the whole room, so ask for small results. Reply only with the JSON the host asks for.";
const ALL_PROMPT = "You are one participant in a text conversation among humans and other models. You have your CLI's full tools, including editing files and running commands. Do only what the humans in the conversation asked for; plan and report otherwise. Everything a tool returns is shown to the whole room, so ask for small results. Reply only with the JSON the host asks for.";
const CLAUDE_TOOLS = "Read,Grep,Glob,Bash";
const promptFor = (t?: Tools) => t === "all" ? ALL_PROMPT : t === "read" ? TOOLS_PROMPT : SPEAKER_PROMPT;
const OC_TOOLS_PERMISSION = { "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow", bash: "allow" };
const PI_READ_TOOLS = "read,grep,find,ls,bash";
const CODEX_NOT_TOOLS = ["userMessage", "agentMessage", "reasoning", "plan", "hookPrompt", "contextCompaction"];
const brief = (input: unknown) => { const o: any = input ?? {}; const s = String(o.command ?? o.pattern ?? o.path ?? o.file_path ?? o.query ?? JSON.stringify(o)); return s.replace(/\s+/g, " ").slice(0, 90); };

export class Speaker {
  readonly id: string;
  session_id?: string;
  resumed = false;
  private proc?: ChildProcess;
  private pending: ((r: TurnResult) => void) | null = null;
  private stderr = "";
  private dead = false;
  private rpcId = 0;
  private rpcWaiters = new Map<number, (res: any) => void>();
  private lastText = "";
  private lastUsage?: Usage;
  private schema: object = {};
  private ready: Promise<void> = Promise.resolve();
  private oc?: { base: string; auth: string };
  private work: ToolWork = { calls: 0, chars: 0 };
  private lastCtx?: number;
  private claudeCost = new CumulativeCost();
  private nudged = false;
  private codexTotal?: any;
  private codexBase?: any;
  private act(text: string | null) { this.opts.onActivity?.(text); }
  private didTool(output: unknown) { this.act(null); this.work.calls++; this.work.chars += (typeof output === "string" ? output : JSON.stringify(output ?? "")).length; }

  constructor(private opts: SpeakerOpts) {
    this.id = opts.id;
    this.session_id = opts.session_id;
    if (opts.cli === "pi") { this.resumed = !!opts.session_id; this.session_id ??= randomUUID(); return; }
    if (opts.cli === "opencode") { this.ready = this.opencodeInit(); return; }
    this.proc = this.spawnLongLived();
    if (opts.cli === "codex") this.ready = this.codexInit();
    else this.resumed = !!opts.session_id;
  }

  // ---------- claude / codex: long-lived process
  private spawnLongLived(): ChildProcess {
    const { cli, model, cwd, session_id } = this.opts;
    this.claudeCost = new CumulativeCost();
    const args = cli === "claude"
      ? ["-p", "--verbose", "--model", model,
         "--input-format", "stream-json", "--output-format", "stream-json",
         ...(this.opts.tools === "all" ? ["--permission-mode", "bypassPermissions"]
           : this.opts.tools === "read" ? ["--tools", CLAUDE_TOOLS, "--allowedTools", CLAUDE_TOOLS, "--disallowedTools", "Edit,Write,MultiEdit,NotebookEdit"]
           : ["--tools", ""]),
         "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
         "--system-prompt", promptFor(this.opts.tools), "--setting-sources", "",
         ...(this.opts.thinking ? ["--effort", this.opts.thinking] : []),
         ...(session_id ? ["--resume", session_id] : [])]
      : ["app-server", ...(this.opts.tools ? ["-c", "features.shell_tool=true", "-c", "features.unified_exec=true", "-c", "features.code_mode_host=true"] : [])];
    const env = cli === "codex" ? { ...process.env, CODEX_HOME: codexHome(cwd ?? process.cwd()) } : process.env;
    const proc = spawn(cli, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    proc.stderr!.on("data", (d) => (this.stderr += d));
    proc.on("exit", (code) => { this.dead = true; this.settle({ speaker: this.id, ok: false, error: `exited ${code}: ${this.stderr.slice(-400)}` }); });
    let buf = "";
    proc.stdout!.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { this.onLine(buf.slice(0, i)); buf = buf.slice(i + 1); } });
    return proc;
  }

  private rpc(method: string, params: object): Promise<any> {
    const id = ++this.rpcId;
    return new Promise((resolve) => {
      this.rpcWaiters.set(id, resolve);
      this.proc!.stdin!.write(JSON.stringify({ id, method, params }) + "\n");
    });
  }

  private async codexInit() {
    await this.rpc("initialize", { clientInfo: { name: "committee", version: "0" } });
    this.proc!.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
    const common = { model: this.opts.model, sandbox: this.opts.tools === "all" ? "workspace-write" : "read-only", approvalPolicy: "never", cwd: this.opts.cwd ?? process.cwd(), baseInstructions: promptFor(this.opts.tools) };
    if (this.opts.session_id) {
      const r = await this.rpc("thread/resume", { threadId: this.opts.session_id, ...common });
      if (r?.thread?.id) { this.session_id = r.thread.id; this.resumed = true; return; }
    }
    const res = await this.rpc("thread/start", { ...common, ephemeral: false });
    this.session_id = res?.thread?.id;
    if (!this.session_id) throw new Error(`codex thread/start failed: ${JSON.stringify(res).slice(0, 300)}`);
  }

  private onLine(line: string) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    if (this.opts.cli === "codex") return this.onCodex(ev);
    if (ev.session_id) this.session_id = ev.session_id;
    if (ev.type === "assistant" && ev.message?.usage) { const su = ev.message.usage; this.lastCtx = (su.input_tokens ?? 0) + (su.cache_read_input_tokens ?? 0) + (su.cache_creation_input_tokens ?? 0); }
    if (ev.type === "assistant") for (const b of ev.message?.content ?? []) if (b?.type === "tool_use") this.act(`${b.name} ${brief(b.input)}`);
    if (ev.type === "user") for (const b of ev.message?.content ?? []) if (b?.type === "tool_result") this.didTool(Array.isArray(b.content) ? b.content.map((p: any) => p.text ?? "").join("\n") : b.content);
    if (ev.type !== "result") return;
    if (ev.is_error) return this.settle({ speaker: this.id, ok: false, error: String(ev.result ?? ev.subtype), raw: ev });
    const u = ev.usage ?? {};
    this.settleJson(String(ev.result ?? ""), ev, { fresh: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, out: u.output_tokens ?? 0, cost: this.claudeCost.next(ev.total_cost_usd), costScope: "call", ctx: this.lastCtx });
  }

  private onCodex(ev: any) {
    if (ev.id !== undefined && this.rpcWaiters.has(ev.id)) {
      const w = this.rpcWaiters.get(ev.id)!; this.rpcWaiters.delete(ev.id);
      return w(ev.error ? { error: ev.error } : ev.result);
    }
    const item = ev.params?.item;
    if (ev.method === "item/completed" && item?.type === "agentMessage") this.lastText = item.text;
    if (item && !CODEX_NOT_TOOLS.includes(item.type)) {
      if (ev.method === "item/started") this.act(`${item.type === "commandExecution" ? "shell" : item.tool ?? item.type} ${brief(item.command ?? item.arguments ?? item.changes ?? item.query ?? "")}`);
      if (ev.method === "item/completed") this.didTool(item.aggregatedOutput ?? item.result ?? item.contentItems ?? item.output ?? item.changes);
    }
    if (ev.method === "thread/tokenUsage/updated") {
      // `total` is the thread's running sum over every model step; this turn's spend is its growth since turn/start
      const { total, last } = ev.params?.tokenUsage ?? {};
      const u = this.codexBase && total ? { inputTokens: total.inputTokens - this.codexBase.inputTokens, cachedInputTokens: total.cachedInputTokens - this.codexBase.cachedInputTokens, outputTokens: total.outputTokens - this.codexBase.outputTokens } : last;
      if (u) this.lastUsage = { fresh: (u.inputTokens ?? 0) - (u.cachedInputTokens ?? 0), cached: u.cachedInputTokens ?? 0, out: u.outputTokens ?? 0, ctx: last?.inputTokens };
      if (total) this.codexTotal = total;
    }
    if (ev.method === "error") return this.settle({ speaker: this.id, ok: false, error: JSON.stringify(ev.params).slice(0, 300), raw: ev });
    if (ev.method !== "turn/completed") return;
    const turn = ev.params?.turn;
    if (turn?.status !== "completed") return this.settle({ speaker: this.id, ok: false, error: `turn ${turn?.status}: ${JSON.stringify(turn?.error ?? "").slice(0, 300)}`, raw: ev });
    this.settleJson(this.lastText, ev, this.lastUsage);
  }

  // ---------- pi: one process per message, session file under the room folder
  private piOneShot(text: string): ChildProcess {
    const { model, cwd, thinking, tools } = this.opts;
    const args = ["-p", "--mode", "json", "--no-extensions", "--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates",
      "--session-dir", join(cwd ?? process.cwd(), "committee", "pi-sessions"), "--session-id", this.session_id!,
      "--system-prompt", promptFor(tools), "--model", model,
      ...(thinking ? ["--thinking", thinking] : []),
      ...(this.noTools || !tools ? ["--no-tools"] : tools === "read" ? ["--tools", PI_READ_TOOLS] : [])];
    const proc = spawn("pi", [...args, text], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let err = "", last: any;
    proc.stderr!.on("data", (d) => (err += d));
    let buf = "";
    proc.stdout!.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let ev: any; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.type === "tool_execution_start") this.act(`${ev.toolName} ${brief(ev.args)}`);
      if (ev.type === "tool_execution_end") this.didTool(ev.result?.content?.map?.((p: any) => p.text ?? "").join("") ?? ev.result);
      if (ev.type === "turn_end") last = ev.message; } });
    proc.on("exit", (code) => {
      if (!last) return this.settle({ speaker: this.id, ok: false, error: `pi exit ${code}: ${err.slice(-300)}` });
      if (last.stopReason === "error") return this.settle({ speaker: this.id, ok: false, error: String(last.errorMessage ?? "error").slice(0, 300), raw: last });
      const u = last.usage ?? {};
      this.settleJson((last.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(""), last, { fresh: (u.input ?? 0) + (u.cacheWrite ?? 0), cached: u.cacheRead ?? 0, out: u.output ?? 0, cost: u.cost?.total, ctx: (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) });
      this.resumed = true;
    });
    return proc;
  }

  // ---------- opencode: shared server, one session
  private async opencodeInit() {
    this.oc = await opencodeServer(this.opts.cwd ?? process.cwd());
    if (this.opts.session_id) {
      const r = await this.ocFetch("GET", `/api/session/${this.opts.session_id}`);
      if (r?.data?.id) { this.session_id = r.data.id; this.resumed = true; return; }
    }
    const [providerID, ...rest] = this.opts.model.split("/");
    const res = await this.ocFetch("POST", "/api/session", { title: `committee:${this.id}`, agent: this.opts.tools === "all" ? "speaker-all" : this.opts.tools === "read" ? "speaker-tools" : "speaker", model: { providerID, id: rest.join("/"), ...(this.opts.thinking ? { variant: this.opts.thinking } : {}) } });
    this.session_id = res?.data?.id;
    if (!this.session_id) throw new Error(`opencode session create failed: ${JSON.stringify(res).slice(0, 300)}`);
  }
  private async ocFetch(method: string, path: string, body?: object) {
    const r = await fetch(this.oc!.base + path, { method, headers: { authorization: this.oc!.auth, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { error: `${r.status} ${text.slice(0, 200)}` }; }
  }
  private async opencodeTurn(text: string) {
    const sent = await this.ocFetch("POST", `/api/session/${this.session_id}/prompt`, { text, ...(this.noTools ? { agent: "speaker" } : {}) });
    if (!sent?.data?.id) return this.settle({ speaker: this.id, ok: false, error: `opencode prompt failed: ${JSON.stringify(sent).slice(0, 300)}` });
    const t0 = sent.data.time?.created ?? Date.now();
    // poll the message list while waiting so the host can show which tool is running
    let done = false;
    const waiting = this.ocFetch("POST", `/api/experimental/session/${this.session_id}/wait`).then(() => { done = true; });
    while (!done) {
      await Promise.race([waiting, new Promise((r) => setTimeout(r, 1500))]);
      if (done) break;
      const peek = await this.ocFetch("GET", `/api/session/${this.session_id}/message`);
      const running = (peek?.data ?? []).filter((m: any) => m.type === "assistant" && (m.time?.created ?? 0) >= t0).flatMap((m: any) => m.content ?? []).find((p: any) => p.type === "tool" && p.state?.status !== "completed" && p.state?.status !== "error");
      this.act(running ? `${running.name} ${brief(running.state?.input)}` : null);
    }
    this.act(null);
    const list = await this.ocFetch("GET", `/api/session/${this.session_id}/message`);
    // one assistant message per model step (a tool round is a step): oldest first, text from the last, usage summed
    const steps = (list?.data ?? []).filter((m: any) => m.type === "assistant" && (m.time?.created ?? 0) >= t0).reverse();
    if (!steps.length) return this.settle({ speaker: this.id, ok: false, error: `opencode: no assistant reply (${JSON.stringify(list).slice(0, 200)})`, raw: list });
    for (const m of steps) for (const p of m.content ?? []) if (p.type === "tool") this.didTool((p.state?.content ?? []).map((x: any) => x.text ?? "").join("\n") || p.state?.error);
    const last = steps[steps.length - 1];
    const reply = (last.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    const u = steps.reduce((a: any, m: any) => { const tk = m.tokens ?? {}; return { fresh: a.fresh + (tk.input ?? 0) + (tk.cache?.write ?? 0), cached: a.cached + (tk.cache?.read ?? 0), out: a.out + (tk.output ?? 0) + (tk.reasoning ?? 0), cost: a.cost + (m.cost ?? 0) }; }, { fresh: 0, cached: 0, out: 0, cost: 0 });
    const lt = last.tokens ?? {};
    this.settleJson(reply, last, { ...u, ctx: (lt.input ?? 0) + (lt.cache?.read ?? 0) + (lt.cache?.write ?? 0) });
  }

  // ---------- common
  private settleJson(text: string, raw: unknown, usage?: Usage) {
    const payload = parseJson(text);
    // models that just used tools often answer in prose; ask once for the same content as JSON
    if (payload === undefined && !this.nudged) {
      if (this.opts.cli === "pi") this.resumed = true;
      this.nudged = true;
      this.dispatch("Your previous reply was prose, not JSON, so the room did not see it. Send the same content again as the JSON object the host asked for (put the prose in the text field).");
      return;
    }
    if (payload === undefined) return this.settle({ speaker: this.id, ok: false, error: `non-JSON reply: ${text.slice(0, 200)}`, usage, raw });
    coerce(payload as Record<string, unknown>, this.schema);
    const missing = ((this.schema as any).required ?? []).filter((k: string) => !(k in (payload as any)));
    if (missing.length) return this.settle({ speaker: this.id, ok: false, error: `reply missing ${missing.join(",")}: ${text.slice(0, 200)}`, usage, raw });
    this.settle({ speaker: this.id, ok: true, session_id: this.session_id, resumed: this.resumed, payload, usage, tools: this.work.calls ? this.work : undefined, raw });
  }

  private settle(r: TurnResult) {
    const p = this.pending; this.pending = null; p?.(r);
  }

  /** Send one message; `schema` is the JSON shape the reply must match (put in the prompt, checked locally). */
  /** tools off for this one call (the intention phase): pi gets --no-tools, opencode the tool-less agent; claude and codex are told */
  private noTools = false;
  async send(text: string, schema: object, timeoutMs = 120_000, opts: { noTools?: boolean } = {}): Promise<TurnResult> {
    this.noTools = !!opts.noTools && !!this.opts.tools;
    try { await this.ready; } catch (e) { return { speaker: this.id, ok: false, error: String(e) }; }
    if (this.dead) return { speaker: this.id, ok: false, error: "process exited" };
    if (this.pending) return { speaker: this.id, ok: false, error: "turn already in flight" };
    this.schema = schema;
    // small models copy an example reliably and echo a schema back; the schema stays the host's check
    const ex = (schema as any).examples?.[0];
    const noToolsLine = this.noTools && (this.opts.cli === "claude" || this.opts.cli === "codex") ? "\nNo tools in this phase; just answer." : "";
    const prompt = ex ? `${text}${noToolsLine}\n\nReply with only one JSON object shaped like this, no prose:\n${JSON.stringify(ex)}`
      : `${text}\n\nReply with only JSON matching this schema, no prose:\n${JSON.stringify(schema)}`;
    this.nudged = false; this.work = { calls: 0, chars: 0 };
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.oneShot?.kill(); this.settle({ speaker: this.id, ok: false, error: `timeout ${timeoutMs}ms` }); }, timeoutMs);
      this.pending = (r) => { clearTimeout(t); resolve(r); };
      this.dispatch(prompt);
    });
  }
  private oneShot?: ChildProcess;
  private dispatch(prompt: string) {
    if (this.opts.cli === "pi") {
      this.oneShot = this.piOneShot(prompt);
    } else if (this.opts.cli === "opencode") {
      this.opencodeTurn(prompt);
    } else if (this.opts.cli === "codex") {
      this.lastText = ""; this.lastUsage = undefined; this.codexBase = this.codexTotal;
      this.rpc("turn/start", { threadId: this.session_id, input: [{ type: "text", text: prompt }], ...(this.opts.thinking ? { effort: this.opts.thinking } : {}) })
        .then((res) => { if (res?.error) this.settle({ speaker: this.id, ok: false, error: JSON.stringify(res.error).slice(0, 300) }); });
    } else {
      this.proc!.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
    }
  }

  close() { this.proc?.stdin?.end(); this.proc?.kill(); }
}

// models mix up the two shapes (an intention answered as a response, or the reverse); map what can be mapped
function coerce(p: Record<string, unknown>, schema: object) {
  const want = ((schema as any).required ?? []) as string[];
  if (want.includes("preference") && !("preference" in p) && typeof p.action === "string") {
    p.preference = p.action === "speak" || p.action === "repeat" ? "speak" : p.action === "silent" ? "silent" : "wait";
    p.topic ??= typeof p.text === "string" ? p.text.slice(0, 160) : "";
  }
  if (want.includes("topic") && !("topic" in p)) p.topic = "";
  if (want.includes("action") && !("action" in p) && typeof p.preference === "string") {
    p.action = p.preference === "speak" && typeof p.text === "string" && p.text.trim() ? "speak" : p.preference === "silent" ? "silent" : "wait";
  }
}

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return undefined;
}

// Codex reads ~/.codex (plugins, MCP servers, skills, AGENTS.md) into every thread.
// Speakers get a private home with just the auth file and a config that drops every
// optional prompt section and tool: ~2.3k tokens per call instead of ~12.6k (measured).
// Seats with tools turn the shell back on with -c on their own app-server.
const CODEX_CONFIG = `web_search = "disabled"
include_permissions_instructions = false
include_apps_instructions = false
include_collaboration_mode_instructions = false
include_environment_context = false

[skills]
include_instructions = false

[skills.bundled]
enabled = false

[features]
${["apps", "browser_use", "computer_use", "code_mode_host", "plugins", "multi_agent", "image_generation", "shell_tool", "unified_exec", "view_image", "sleep_tool", "goals", "hooks", "tool_suggest", "skill_search", "in_app_browser"].map((f) => `${f} = false`).join("\n")}
`;
function codexHome(cwd: string) {
  const home = join(cwd, "committee", "codex-home");
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
    const auth = join(homedir(), ".codex", "auth.json");
    if (existsSync(auth)) copyFileSync(auth, join(home, "auth.json"));
  }
  writeFileSync(join(home, "config.toml"), CODEX_CONFIG);
  return home;
}

/** codex's own model list (~/.codex/models_cache.json): slug, context_window, supported_reasoning_levels */
export function codexModels(cwd = process.cwd()): any[] {
  for (const p of [join(cwd, "committee", "codex-home", "models_cache.json"), join(homedir(), ".codex", "models_cache.json")]) {
    try { return JSON.parse(readFileSync(p, "utf8")).models ?? []; } catch {}
  }
  return [];
}

/** context window of a model in tokens: opencode's model list, pi's --list-models, codex's models_cache.json, claude's 200k default; 0 when unknown */
export async function modelWindow(cli: Cli, model: string, cwd: string): Promise<number> {
  if (cli === "claude") return model.includes("[1m]") ? 1_000_000 : 200_000;
  if (cli === "codex") return codexModels(cwd).find((m: any) => m.slug === model)?.context_window ?? 0;
  if (cli === "opencode") {
    try {
      const oc = await opencodeServer(cwd);
      const j: any = await (await fetch(oc.base + "/api/model", { headers: { authorization: oc.auth } })).json();
      const m = (j?.data ?? []).find((x: any) => `${x.providerID}/${x.id}` === model || x.id === model);
      return m?.limit?.context ?? 0;
    } catch { return 0; }
  }
  if (cli === "pi") {
    const out = await new Promise<string>((res) => { const p = spawn("pi", ["--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--list-models"], { stdio: ["ignore", "pipe", "ignore"] }); let o = ""; p.stdout!.on("data", (d) => (o += d)); p.on("exit", () => res(o)); });
    const [prov, ...rest] = model.split("/"); const id = rest.join("/");
    const row = out.split("\n").map((l) => l.trim().split(/\s+/)).find((p) => p[0] === prov && p[1] === id);
    const k = row?.[2] ?? ""; const n = parseFloat(k);
    return /M$/i.test(k) ? Math.round(n * 1_000_000) : /K$/i.test(k) ? Math.round(n * 1_000) : n || 0;
  }
  return 0;
}

/** thinking variants opencode knows for a model ("provider/id"), from the live model list; empty when unknown */
export async function opencodeVariants(cwd: string, model: string): Promise<string[]> {
  try {
    const oc = await opencodeServer(cwd);
    const r = await fetch(oc.base + "/api/model", { headers: { authorization: oc.auth } });
    const j: any = await r.json();
    const m = (j?.data ?? []).find((x: any) => `${x.providerID}/${x.id}` === model || x.id === model);
    return (m?.variants ?? []).map((v: any) => v.id);
  } catch { return []; }
}

// One opencode server per host process, started on first use, killed with the host.
// OPENCODE_CONFIG_CONTENT carries the tool-less speaker agent so nothing is written into cwd.
let ocServer: Promise<{ base: string; auth: string }> | undefined;
function opencodeServer(cwd: string) {
  if (ocServer) return ocServer;
  ocServer = (async () => {
    const port = 41000 + Math.floor(Math.random() * 9000);
    const pw = randomBytes(12).toString("hex");
    const config = JSON.stringify({ agent: {
      speaker: { description: "committee speaker", mode: "primary", permission: { "*": "deny" }, prompt: SPEAKER_PROMPT },
      "speaker-tools": { description: "committee speaker with read-only tools", mode: "primary", permission: OC_TOOLS_PERMISSION, prompt: TOOLS_PROMPT },
      "speaker-all": { description: "committee speaker with every tool", mode: "primary", permission: { "*": "allow" }, prompt: ALL_PROMPT },
    } });
    const configHome = join(cwd, "committee", "opencode-config");
    mkdirSync(join(configHome, "opencode"), { recursive: true });
    const proc = spawn("opencode", ["serve", "--port", String(port)], { cwd, env: { ...process.env, XDG_CONFIG_HOME: configHome, OPENCODE_SERVER_PASSWORD: pw, OPENCODE_CONFIG_CONTENT: config }, stdio: ["ignore", "ignore", "pipe"] });
    let err = ""; proc.stderr!.on("data", (d) => (err += d));
    process.on("exit", () => proc.kill());
    const base = `http://127.0.0.1:${port}`;
    const auth = "Basic " + Buffer.from(`opencode:${pw}`).toString("base64");
    for (let i = 0; i < 60; i++) {
      try { const r = await fetch(base + "/api/info", { headers: { authorization: auth } }); if (r.ok) return { base, auth }; } catch {}
      if (proc.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`opencode serve did not come up on ${port}: ${err.slice(-300)}`);
  })();
  return ocServer;
}

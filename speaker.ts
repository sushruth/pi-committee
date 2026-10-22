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
// cursor:   no stream mode: one `cursor-agent -p --trust` process per message, --resume <id>.
// opencode: one shared `opencode serve` per host, one session per speaker over HTTP
//           (any provider opencode is logged into); a tool-less "speaker" agent is passed inline.

import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

export type Cli = "claude" | "codex" | "cursor" | "opencode";

export interface SpeakerOpts {
  id: string;
  cli: Cli;
  model: string;
  cwd?: string;
  /** reasoning effort: claude --effort, codex turn effort, opencode model variant, cursor model suffix (caller picks the id) */
  thinking?: string;
  /** native session id from a previous run; the adapter resumes it, or starts fresh if that fails */
  session_id?: string;
  /** "read": read, grep, glob, shell for inspection; "all": everything the CLI has, writes included; every call and result is reported through onTool */
  tools?: Tools;
  onTool?: (t: ToolUse) => void;
}
export interface ToolUse { name: string; input: string; output: string }
export type Tools = "read" | "all";

export interface Usage { fresh: number; cached: number; out: number; cost?: number }

export interface TurnResult {
  speaker: string;
  ok: boolean;
  session_id?: string;
  /** true when the native session was resumed from `opts.session_id` (so its memory is intact) */
  resumed?: boolean;
  payload?: unknown;
  error?: string;
  usage?: Usage;
  raw?: unknown;
}

const SPEAKER_PROMPT = "You are one participant in a text conversation among humans and other models. You have no tools and no files. Reply only with the JSON the host asks for.";
const TOOLS_PROMPT = "You are one participant in a text conversation among humans and other models. You have read-only tools: read files, grep, glob, and a shell for inspection. Never create, change or delete anything. Everything a tool returns is shown to the whole room, so ask for small results. Reply only with the JSON the host asks for.";
const ALL_PROMPT = "You are one participant in a text conversation among humans and other models. You have your CLI's full tools, including editing files and running commands. Do only what the humans in the conversation asked for; plan and report otherwise. Everything a tool returns is shown to the whole room, so ask for small results. Reply only with the JSON the host asks for.";
const CLAUDE_TOOLS = "Read,Grep,Glob,Bash";
const promptFor = (t?: Tools) => t === "all" ? ALL_PROMPT : t === "read" ? TOOLS_PROMPT : SPEAKER_PROMPT;
const OC_TOOLS_PERMISSION = { "*": "deny", read: "allow", grep: "allow", glob: "allow", list: "allow", bash: "allow" };
const short = (v: unknown, n = 300) => { const s = typeof v === "string" ? v : JSON.stringify(v); return s.length > n ? s.slice(0, n) + "…" : s; };

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
  private toolCalls = new Map<string, { name: string; input: string }>();
  private nudged = false;

  constructor(private opts: SpeakerOpts) {
    this.id = opts.id;
    this.session_id = opts.session_id;
    if (opts.cli === "cursor") { this.resumed = !!opts.session_id; return; }
    if (opts.cli === "opencode") { this.ready = this.opencodeInit(); return; }
    this.proc = this.spawnLongLived();
    if (opts.cli === "codex") this.ready = this.codexInit();
    else this.resumed = !!opts.session_id;
  }

  // ---------- claude / codex: long-lived process
  private spawnLongLived(): ChildProcess {
    const { cli, model, cwd, session_id } = this.opts;
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
      : ["app-server"];
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
    const common = { model: this.opts.model, sandbox: "read-only", approvalPolicy: "never", cwd: this.opts.cwd ?? process.cwd(), baseInstructions: SPEAKER_PROMPT };
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
    // tool calls: remember the input by id, report when the result comes back
    for (const b of ev.message?.content ?? []) {
      if (ev.type === "assistant" && b?.type === "tool_use") this.toolCalls.set(b.id, { name: b.name, input: short(b.input) });
      if (ev.type === "user" && b?.type === "tool_result") {
        const call = this.toolCalls.get(b.tool_use_id); this.toolCalls.delete(b.tool_use_id);
        const out = Array.isArray(b.content) ? b.content.map((p: any) => p.text ?? "").join("\n") : String(b.content ?? "");
        if (call) this.opts.onTool?.({ ...call, output: out });
      }
    }
    if (ev.type !== "result") return;
    if (ev.is_error) return this.settle({ speaker: this.id, ok: false, error: String(ev.result ?? ev.subtype), raw: ev });
    const u = ev.usage ?? {};
    this.settleJson(String(ev.result ?? ""), ev, { fresh: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), cached: u.cache_read_input_tokens ?? 0, out: u.output_tokens ?? 0, cost: ev.total_cost_usd });
  }

  private onCodex(ev: any) {
    if (ev.id !== undefined && this.rpcWaiters.has(ev.id)) {
      const w = this.rpcWaiters.get(ev.id)!; this.rpcWaiters.delete(ev.id);
      return w(ev.error ? { error: ev.error } : ev.result);
    }
    if (ev.method === "item/completed" && ev.params?.item?.type === "agentMessage") this.lastText = ev.params.item.text;
    if (ev.method === "thread/tokenUsage/updated") { const u = ev.params?.tokenUsage?.last; if (u) this.lastUsage = { fresh: (u.inputTokens ?? 0) - (u.cachedInputTokens ?? 0), cached: u.cachedInputTokens ?? 0, out: u.outputTokens ?? 0 }; }
    if (ev.method === "error") return this.settle({ speaker: this.id, ok: false, error: JSON.stringify(ev.params).slice(0, 300), raw: ev });
    if (ev.method !== "turn/completed") return;
    const turn = ev.params?.turn;
    if (turn?.status !== "completed") return this.settle({ speaker: this.id, ok: false, error: `turn ${turn?.status}: ${JSON.stringify(turn?.error ?? "").slice(0, 300)}`, raw: ev });
    this.settleJson(this.lastText, ev, this.lastUsage);
  }

  // ---------- cursor: one process per message
  private cursorOneShot(text: string, retry = true): ChildProcess {
    const { model, cwd } = this.opts;
    const args = ["-p", "--trust", "--mode", "ask", "--model", model, "--output-format", "json"];
    if (this.session_id) args.push("--resume", this.session_id);
    const proc = spawn("cursor-agent", [...args, text], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout!.on("data", (d) => (out += d));
    proc.stderr!.on("data", (d) => (err += d));
    proc.on("exit", (code) => {
      let ev: any;
      try { ev = JSON.parse(out); } catch { return this.settle({ speaker: this.id, ok: false, error: `exit ${code}, non-JSON: ${(out || err).slice(0, 200)}` }); }
      if (ev.session_id) this.session_id = ev.session_id;
      if (ev.is_error) return this.settle({ speaker: this.id, ok: false, error: String(ev.result).slice(0, 300), raw: ev });
      const result = String(ev.result ?? "");
      if (parseJson(result) === undefined && retry) { this.cursorOneShot("Your previous reply was not valid JSON (it was cut off or had prose). Send the full JSON object again, nothing else.", false); return; }
      const u = ev.usage ?? {};
      this.settleJson(result, ev, { fresh: (u.inputTokens ?? 0) + (u.cacheWriteTokens ?? 0), cached: u.cacheReadTokens ?? 0, out: u.outputTokens ?? 0 });
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
    const sent = await this.ocFetch("POST", `/api/session/${this.session_id}/prompt`, { text });
    if (!sent?.data?.id) return this.settle({ speaker: this.id, ok: false, error: `opencode prompt failed: ${JSON.stringify(sent).slice(0, 300)}` });
    const t0 = sent.data.time?.created ?? Date.now();
    await this.ocFetch("POST", `/api/experimental/session/${this.session_id}/wait`);
    const list = await this.ocFetch("GET", `/api/session/${this.session_id}/message`);
    // one assistant message per model step (a tool round is a step): oldest first, text from the last, usage summed
    const steps = (list?.data ?? []).filter((m: any) => m.type === "assistant" && (m.time?.created ?? 0) >= t0).reverse();
    if (!steps.length) return this.settle({ speaker: this.id, ok: false, error: `opencode: no assistant reply (${JSON.stringify(list).slice(0, 200)})`, raw: list });
    for (const m of steps) for (const p of m.content ?? []) if (p.type === "tool") this.opts.onTool?.({ name: p.name, input: short(p.state?.input), output: (p.state?.content ?? []).map((x: any) => x.text ?? "").join("\n") || String(p.state?.error ?? "") });
    const last = steps[steps.length - 1];
    const reply = (last.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
    const u = steps.reduce((a: any, m: any) => { const tk = m.tokens ?? {}; return { fresh: a.fresh + (tk.input ?? 0) + (tk.cache?.write ?? 0), cached: a.cached + (tk.cache?.read ?? 0), out: a.out + (tk.output ?? 0) + (tk.reasoning ?? 0), cost: a.cost + (m.cost ?? 0) }; }, { fresh: 0, cached: 0, out: 0, cost: 0 });
    this.settleJson(reply, last, u);
  }

  // ---------- common
  private settleJson(text: string, raw: unknown, usage?: Usage) {
    const payload = parseJson(text);
    // models that just used tools often answer in prose; ask once for the same content as JSON
    if (payload === undefined && !this.nudged && this.opts.cli !== "cursor") {
      this.nudged = true;
      this.dispatch("Your previous reply was prose, not JSON, so the room did not see it. Send the same content again as the JSON object the host asked for (put the prose in the text field).");
      return;
    }
    if (payload === undefined) return this.settle({ speaker: this.id, ok: false, error: `non-JSON reply: ${text.slice(0, 200)}`, usage, raw });
    const missing = ((this.schema as any).required ?? []).filter((k: string) => !(k in (payload as any)));
    if (missing.length) return this.settle({ speaker: this.id, ok: false, error: `reply missing ${missing.join(",")}: ${text.slice(0, 200)}`, usage, raw });
    this.settle({ speaker: this.id, ok: true, session_id: this.session_id, resumed: this.resumed, payload, usage, raw });
  }

  private settle(r: TurnResult) {
    const p = this.pending; this.pending = null; p?.(r);
  }

  /** Send one message; `schema` is the JSON shape the reply must match (put in the prompt, checked locally). */
  async send(text: string, schema: object, timeoutMs = 120_000): Promise<TurnResult> {
    try { await this.ready; } catch (e) { return { speaker: this.id, ok: false, error: String(e) }; }
    if (this.dead) return { speaker: this.id, ok: false, error: "process exited" };
    if (this.pending) return { speaker: this.id, ok: false, error: "turn already in flight" };
    this.schema = schema;
    // small models copy an example reliably and echo a schema back; the schema stays the host's check
    const ex = (schema as any).examples?.[0];
    const prompt = ex ? `${text}\n\nReply with only one JSON object shaped like this, no prose:\n${JSON.stringify(ex)}`
      : `${text}\n\nReply with only JSON matching this schema, no prose:\n${JSON.stringify(schema)}`;
    this.nudged = false;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.oneShot?.kill(); this.settle({ speaker: this.id, ok: false, error: `timeout ${timeoutMs}ms` }); }, timeoutMs);
      this.pending = (r) => { clearTimeout(t); resolve(r); };
      this.dispatch(prompt);
    });
  }
  private oneShot?: ChildProcess;
  private dispatch(prompt: string) {
    if (this.opts.cli === "cursor") {
      this.oneShot = this.cursorOneShot(prompt);
    } else if (this.opts.cli === "opencode") {
      this.opencodeTurn(prompt);
    } else if (this.opts.cli === "codex") {
      this.lastText = ""; this.lastUsage = undefined;
      this.rpc("turn/start", { threadId: this.session_id, input: [{ type: "text", text: prompt }], outputSchema: this.schema, ...(this.opts.thinking ? { effort: this.opts.thinking } : {}) })
        .then((res) => { if (res?.error) this.settle({ speaker: this.id, ok: false, error: JSON.stringify(res.error).slice(0, 300) }); });
    } else {
      this.proc!.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n");
    }
  }

  close() { this.proc?.stdin?.end(); this.proc?.kill(); }
}

function parseJson(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  try { return JSON.parse(t); } catch {}
  const i = t.indexOf("{"), j = t.lastIndexOf("}");
  if (i >= 0 && j > i) { try { return JSON.parse(t.slice(i, j + 1)); } catch {} }
  return undefined;
}

// Codex reads ~/.codex (plugins, MCP servers, skills, AGENTS.md) into every thread.
// Speakers get a private home with just the auth file and a minimal config.
function codexHome(cwd: string) {
  const home = join(cwd, "committee", "codex-home");
  if (!existsSync(home)) {
    mkdirSync(home, { recursive: true });
    const auth = join(homedir(), ".codex", "auth.json");
    if (existsSync(auth)) copyFileSync(auth, join(home, "auth.json"));
    writeFileSync(join(home, "config.toml"), "[features]\napps = false\nbrowser_use = false\ncomputer_use = false\ncode_mode_host = false\n");
  }
  return home;
}

/** thinking variants opencode knows for a model ("provider/id"), from the live model list; empty when unknown */
export async function opencodeVariants(cwd: string, model: string): Promise<string[]> {
  try {
    const oc = await opencodeServer(cwd);
    const r = await fetch(oc.base + "/api/model", { headers: { authorization: oc.auth } });
    const j: any = await r.json();
    const m = (j?.data ?? []).find((x: any) => x.id === model);
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
    const proc = spawn("opencode", ["serve", "--port", String(port)], { cwd, env: { ...process.env, OPENCODE_SERVER_PASSWORD: pw, OPENCODE_CONFIG_CONTENT: config }, stdio: ["ignore", "ignore", "pipe"] });
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

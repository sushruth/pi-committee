// bun smoke.ts — every speaker in example.json, two turns, then a resume by session id.
// Checks: schema JSON back, session memory, usage numbers, resume works.
import { Speaker } from "./speaker.ts";
import response from "./schemas/response.schema.json";
import cfg from "./example.json";

const show = (rs: any[]) => JSON.stringify(rs.map(({ raw, payload, ...r }) => ({ ...r, text: (payload as any)?.text })));
const mk = (ids?: Record<string, string | undefined>) => cfg.speakers.map((s) => new Speaker({ id: s.id, cli: s.cli as any, model: s.model, session_id: ids?.[s.id] }));
const t0 = Date.now();

const a = mk();
const r1 = await Promise.all(a.map((s) => s.send(`Pick a secret animal and say it in one word.`, response)));
console.log("turn1", Date.now() - t0, "ms", show(r1));
const r2 = await Promise.all(a.map((s) => s.send(`Which animal did you pick before?`, response)));
console.log("turn2", Date.now() - t0, "ms", show(r2));
const ids = Object.fromEntries(a.map((s) => [s.id, s.session_id]));
a.forEach((s) => s.close());

const b = mk(ids);
const r3 = await Promise.all(b.map((s) => s.send(`Still the same animal? Say it again.`, response)));
console.log("resumed", Date.now() - t0, "ms", show(r3));
b.forEach((s) => s.close());
process.exit(0);

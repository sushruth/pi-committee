/** Room titles: derived from the first human message, no model call. */
export function titleFrom(text: string, max = 40): string {
  const line = text.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const t = line.replace(/@[a-z0-9]+/g, "").replace(/\s+/g, " ").trim();
  if (!t) return "new room";
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
}

/** "Oct 28 · title · 95 msgs" from a room id like 2026-10-28T09-14-16-499Z */
export function roomLabel(id: string, title: string, msgs: number): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T/.exec(id);
  const mon = m ? ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][Number(m[2]) - 1] : "";
  const day = m ? String(Number(m[3])) : "";
  return [m ? `${mon} ${day}` : id, title, `${msgs} msgs`].join(" · ");
}

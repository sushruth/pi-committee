/** Tag routing: which seats a human message addresses. undefined means everyone. */
export interface SeatTag { id: string; tag: string }
const EVERYONE = new Set(["all", "everyone", "others"]);

export function focusFromText(text: string, seats: SeatTag[]): Set<string> | undefined {
  const tags = [...text.matchAll(/@([a-z0-9]+)\b/g)].map((m) => m[1]);
  if (tags.some((t) => EVERYONE.has(t))) return undefined;
  const ids = seats.filter((s) => tags.includes(s.tag)).map((s) => s.id);
  return ids.length ? new Set(ids) : undefined;
}

/** held-back messages are served together: any broadcast among them makes the round a broadcast */
export function focusFromQueue(texts: string[], seats: SeatTag[]): Set<string> | undefined {
  const union = new Set<string>();
  for (const t of texts) {
    const f = focusFromText(t, seats);
    if (!f) return undefined;
    for (const id of f) union.add(id);
  }
  return union.size ? union : undefined;
}

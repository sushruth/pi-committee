export function compactTopic(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 80) : "";
}

export function distinctRecap(value: unknown, text: string): string {
  if (typeof value !== "string") return "";
  const recap = value.trim();
  return recap.replace(/\s+/g, " ") === text.trim().replace(/\s+/g, " ") ? "" : recap.slice(0, 1200);
}

export function discussionWeight(round: number, boostRound?: number): number {
  const bonus = boostRound === undefined ? 0 : 0.25 * Math.pow(2, -(round - boostRound) / 2);
  return Math.min(1, Math.pow(2, -round / 8) + bonus);
}

export class DiscussionBudget {
  private exchange = 1;
  private discoveries = 0;
  private boostedAt?: number;

  get round(): number { return this.exchange; }
  get boosts(): number { return this.discoveries; }
  get weight(): number { return discussionWeight(this.exchange, this.boostedAt); }

  advance(discovery = false): boolean {
    this.exchange++;
    if (!discovery || this.discoveries >= 2 || (this.boostedAt !== undefined && this.exchange - this.boostedAt < 4)) return false;
    this.discoveries++;
    this.boostedAt = this.exchange;
    return true;
  }
}

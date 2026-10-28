/** Claude stream-json result costs accumulate within one CLI process. */
export class CumulativeCost {
  private previous = 0;
  next(total: unknown): number | undefined {
    if (typeof total !== "number" || !Number.isFinite(total) || total < 0) return undefined;
    // A lower counter starts a new accounting epoch.
    const delta = total >= this.previous ? total - this.previous : total;
    this.previous = total;
    return delta;
  }
}

/** Old Claude events have ambiguous cumulative scope; never sum them as call costs. */
export function reportedCost(usage: { cost?: unknown; costScope?: unknown; cli?: unknown } | undefined, cli?: string): number | undefined {
  if ((usage?.cli ?? cli) === "claude" && usage?.costScope !== "call") return undefined;
  return typeof usage?.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : undefined;
}

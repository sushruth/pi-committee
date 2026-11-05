import type { Theme } from "@earendil-works/pi-coding-agent";
import { indexedColor, mixColors, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function speakerBand(theme: Theme, line: string, width: number, color: number): string {
  const text = truncateToWidth(line, Math.max(0, width), "");
  const background = mixColors(theme.colors.userMessageBg, indexedColor(color), 0.07, "srgb");
  return theme.style(text + " ".repeat(Math.max(0, width - visibleWidth(text))), { fg: "text", bg: background });
}

export function recapBox(theme: Theme, text: string, width: number, heading: string): string[] {
  const w = Math.max(1, width);
  const inner = Math.max(1, w - 4);
  const lines = wrapTextWithAnsi(text, inner);
  return [
    theme.fg("dim", truncateToWidth(`╭─ ${heading} ` + "─".repeat(w), w)),
    ...lines.map((line) => theme.bg("customMessageBg", truncateToWidth(`│ ${theme.fg("text", line)} `, w))),
    theme.fg("dim", "╰" + "─".repeat(Math.max(0, w - 1))),
  ];
}

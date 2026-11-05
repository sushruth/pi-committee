import type { Theme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, indexedColor, mixColors, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function speakerBand(theme: Theme, line: string, width: number, color: number): string {
  const text = truncateToWidth(line, Math.max(0, width), "");
  const background = mixColors(theme.colors.userMessageBg, indexedColor(color), 0.07, "srgb");
  const bg = backgroundAnsi(background, theme.getColorMode());
  // Nested ANSI resets must not erase the message's background band.
  const body = text.replace(/\x1b\[(0|49)m/g, (reset, code) => reset + (code === "0" ? theme.getFgAnsi("text") : "") + bg);
  return theme.style(body + " ".repeat(Math.max(0, width - visibleWidth(text))), { fg: "text", bg: background });
}

export function recapBox(theme: Theme, text: string, width: number, heading: string): string[] {
  const w = Math.max(1, width);
  const inner = Math.max(1, w - 4);
  const lines = wrapTextWithAnsi(text, inner);
  return [
    theme.fg("dim", truncateToWidth(`╭─ ${heading} ` + "─".repeat(w), w, "")),
    ...lines.map((line) => theme.bg("customMessageBg", truncateToWidth(`│ ${theme.fg("text", line + " ".repeat(Math.max(0, inner - visibleWidth(line))))} │`, w, ""))),
    theme.fg("dim", truncateToWidth("╰" + "─".repeat(Math.max(0, w - 2)) + "╯", w, "")),
  ];
}

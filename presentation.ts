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
  const border = (value: string) => theme.fg("customMessageLabel", value);
  return [
    border(truncateToWidth(`╭─ ${heading} ` + "─".repeat(w), Math.max(0, w - 1), "")) + border("╮"),
    ...lines.map((line) => truncateToWidth(`${border("│")} ${theme.fg("text", line + " ".repeat(Math.max(0, inner - visibleWidth(line))))} ${border("│")}`, w, "")),
    border(truncateToWidth("╰" + "─".repeat(Math.max(0, w - 2)) + "╯", w, "")),
  ];
}

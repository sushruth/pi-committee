import { expect, test } from "bun:test";
import { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { recapBox, speakerBand } from "./presentation.ts";
import committee from "./committee.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function theme(appearance: "light" | "dark") {
  const light = appearance === "light";
  return new Theme(
    { text: light ? "#151515" : "#eeeeee", dim: "#888888", muted: "#888888", thinkingXhigh: "#888888" } as any,
    { userMessageBg: light ? "#ffffff" : "#151515", customMessageBg: light ? "#f5f5f5" : "#222222", selectedBg: "#888888" } as any,
    "truecolor", { appearance },
  );
}

test("registered renderer shows recap snapshots and expands complete deliberation", () => {
  const cwd = process.cwd();
  const room = mkdtempSync(join(tmpdir(), "committee-render-"));
  let renderer: any;
  try {
    process.chdir(room);
    committee({
      on() {}, registerFlag() {}, registerShortcut() {}, registerCommand() {},
      registerMessageRenderer(_name: string, value: any) { renderer = value; },
    } as any);
    for (const appearance of ["light", "dark"] as const) {
      const render = (kind: string, text: string, expanded = false, status = "concluded", width = 60) => renderer({
        content: text, details: { id: "event-1", author: "seat", kind, text, data: { status, seats: 2, ms: 1000 } },
      }, { outputPad: 1, expanded }, theme(appearance)).render(width) as string[];
      const recap = render("recap", "Kept the reporter; timing remains unsettled.").join("\n");
      expect(recap).toContain("recap when you sent this");
      expect(recap).toContain("timing remains unsettled");
      expect(render("recap", "A provisional outcome.", false, "discussing").join("\n")).toContain("still discussing");
      expect(render("deliberation", "", false, "paused").join("\n")).toContain("paused");
      expect(render("deliberation", "Exchange 1\nseat: first\nExchange 2\nother: second")).toHaveLength(1);
      const expanded = render("deliberation", "Exchange 1\nseat: first\nExchange 2\nother: second", true).join("\n");
      expect(expanded).toContain("first");
      expect(expanded).toContain("second");
      expect(render("speak", "A short answer.").every((line) => visibleWidth(line) === 60)).toBe(true);
      expect(render("phase", "committee speaks")).toEqual([]);
      const header = render("speak", "A short answer.")[1];
      expect(header).toContain("seat");
      expect(header).not.toContain("─");
      expect(header).not.toContain("▏");
      const collapsed = render("deliberation", "Hidden discussion").join("\n");
      expect(collapsed).not.toContain("/committee");
      expect(collapsed).not.toContain("event-");
      for (const width of [1, 8, 24, 80, 180]) {
        const lines = render("speak", "Text with **bold** and a longer paragraph that needs to wrap at narrow widths.", false, "concluded", width);
        expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
        expect(render("deliberation", "A longer discussion to wrap.", true, "concluded", width).every((line) => visibleWidth(line) <= width)).toBe(true);
      }
    }
  } finally {
    process.chdir(cwd);
    rmSync(room, { recursive: true, force: true });
  }
});

for (const appearance of ["light", "dark"] as const) {
  test(`${appearance}: speaker bands retain foreground and fill the terminal width`, () => {
    const band = speakerBand(theme(appearance), "hello \x1b[31mred\x1b[0m plain 界", 35, 39);
    expect(visibleWidth(band)).toBe(35);
    expect(band).toContain("hello");
    expect(band).toContain("plain 界");
    expect(band).toContain("48;2;");
    expect(band).toContain(appearance === "light" ? "38;2;21;21;21" : "38;2;238;238;238");
    const afterReset = band.split("\x1b[0m")[1];
    expect(afterReset).toMatch(/^\x1b\[38;2;[\d;]+m\x1b\[48;2;[\d;]+m plain/);
    expect(speakerBand(theme(appearance), "one\x1b[49mtwo", 12, 39)).toMatch(/\x1b\[49m\x1b\[48;2;[\d;]+mtwo/);
  });
  test(`${appearance}: recap boxes wrap long lines and stay within narrow widths`, () => {
    for (const width of [1, 4, 12, 50]) {
      const lines = recapBox(theme(appearance), "Decision: keep the existing reporter.\nUnresolved: 界界界界界界", width, "recap when you sent this");
      expect(lines.length).toBeGreaterThan(2);
      expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    }
  });
}

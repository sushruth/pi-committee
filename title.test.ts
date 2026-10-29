import { test, expect } from "bun:test";
import { titleFrom, roomLabel } from "./title.ts";
test("first line, tags removed, trimmed", () => expect(titleFrom("@sp  fix the cap\nmore")).toBe("fix the cap"));
test("long titles are cut with an ellipsis", () => expect(titleFrom("x".repeat(80)).length).toBe(40));
test("empty falls back", () => expect(titleFrom("  \n ")).toBe("new room"));
test("label reads date, title, count", () => expect(roomLabel("2026-10-28T09-14-16-499Z", "discuss the README", 95)).toBe("Oct 28 · discuss the README · 95 msgs"));

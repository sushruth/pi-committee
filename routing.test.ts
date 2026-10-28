import { test, expect } from "bun:test";
import { focusFromText, focusFromQueue } from "./routing.ts";
const seats = [{ id: "simply-precise", tag: "sp" }, { id: "wildly-excellent", tag: "we" }, { id: "warmly-skeptical", tag: "ws" }];
test("a tag selects that seat", () => expect([...focusFromText("@sp do it", seats)!]).toEqual(["simply-precise"]));
test("two tags select two seats", () => expect(focusFromText("@sp and @ws", seats)!.size).toBe(2));
test("no tag, unknown tag, or @all means everyone", () => {
  expect(focusFromText("hello", seats)).toBeUndefined();
  expect(focusFromText("@zz hi", seats)).toBeUndefined();
  expect(focusFromText("@sp @all", seats)).toBeUndefined();
  expect(focusFromText("@others", seats)).toBeUndefined();
});
test("a queue unions tagged messages", () => expect(focusFromQueue(["@sp a", "@we b"], seats)!.size).toBe(2));
test("one broadcast in the queue broadcasts", () => expect(focusFromQueue(["@sp a", "hello"], seats)).toBeUndefined());
test("empty queue is everyone", () => expect(focusFromQueue([], seats)).toBeUndefined());

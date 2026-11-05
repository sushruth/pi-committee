import { expect, test } from "bun:test";
import { compactTopic, discussionWeight, DiscussionBudget } from "./conversation.ts";

test("discussion weight halves every eight exchanges", () => {
  expect(discussionWeight(8)).toBe(0.5);
  expect(discussionWeight(16)).toBe(0.25);
});

test("discovery buys temporary time while underlying decay continues", () => {
  expect(discussionWeight(8, 8)).toBe(0.75);
  expect(discussionWeight(10, 8) - discussionWeight(10)).toBeCloseTo(0.125);
  expect(discussionWeight(12, 8) - discussionWeight(12)).toBeCloseTo(0.0625);
  expect(discussionWeight(1, 1)).toBe(1);
});

test("one exchange gets one boost, a cooldown and only two boosts total", () => {
  const budget = new DiscussionBudget();
  expect(budget.advance(true)).toBe(true);
  expect(budget.round).toBe(2);
  expect(budget.boosts).toBe(1);
  for (let i = 0; i < 3; i++) expect(budget.advance(true)).toBe(false);
  expect(budget.advance(true)).toBe(true);
  expect(budget.boosts).toBe(2);
  for (let i = 0; i < 100; i++) expect(budget.advance(true)).toBe(false);
  expect(budget.boosts).toBe(2);
  expect(budget.weight).toBeLessThan(0.001);
});

test("unboosted exchanges preserve the existing curve", () => {
  const budget = new DiscussionBudget();
  for (let i = 0; i < 15; i++) budget.advance();
  expect(budget.round).toBe(16);
  expect(budget.weight).toBe(0.25);
  expect(budget.boosts).toBe(0);
});

test("topic normalization keeps coordination short and on one line", () => {
  expect(compactTopic("  one\n missing\tconstraint  ")).toBe("one missing constraint");
  expect(compactTopic("x".repeat(100))).toHaveLength(80);
  expect(compactTopic({ topic: "not text" })).toBe("");
});

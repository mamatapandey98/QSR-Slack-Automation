import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatDate,
  isWeekend,
  nextWorkingDay,
  reminderDate,
  roundDueOn,
  targetMonthFor,
  todayInNepal,
} from "../src/schedule.ts";

test("rounds land on the 1st, 5th and 10th of the following month", () => {
  // August 2026 is chased in September 2026.
  // 1 Sep is a Tuesday and 10 Sep a Thursday, so those stand; 5 Sep is a Saturday and shifts.
  assert.deepEqual(reminderDate("2026-08", 1), { year: 2026, month: 9, day: 1 });
  assert.deepEqual(reminderDate("2026-08", 2), { year: 2026, month: 9, day: 7 });
  assert.deepEqual(reminderDate("2026-08", 3), { year: 2026, month: 9, day: 10 });
});

test("a round falling on Saturday moves to the following Monday", () => {
  // 1 Aug 2026 is a Saturday -> Monday 3 Aug.
  assert.equal(formatDate(reminderDate("2026-07", 1)), "Mon 2026-08-03");
});

test("a round falling on Sunday moves to the following Monday", () => {
  // 1 Nov 2026 is a Sunday -> Monday 2 Nov.
  assert.equal(formatDate(reminderDate("2026-10", 1)), "Mon 2026-11-02");
  // 5 Sep 2026 is a Saturday -> Monday 7 Sep.
  assert.equal(formatDate(reminderDate("2026-08", 2)), "Mon 2026-09-07");
});

test("weekend shifting never lands on a weekend", () => {
  for (let month = 1; month <= 12; month++) {
    for (const round of [1, 2, 3] as const) {
      const date = reminderDate(`2026-${String(month).padStart(2, "0")}`, round);
      assert.equal(isWeekend(date), false, `${formatDate(date)} is a weekend`);
    }
  }
});

test("rounds stay in chronological order even after shifting", () => {
  for (let month = 1; month <= 12; month++) {
    const key = `2027-${String(month).padStart(2, "0")}`;
    const [a, b, c] = ([1, 2, 3] as const).map((r) => reminderDate(key, r));
    const asNumber = (d: { year: number; month: number; day: number }) =>
      d.year * 10000 + d.month * 100 + d.day;
    assert.ok(asNumber(a!) < asNumber(b!), `round 1 not before round 2 for ${key}`);
    assert.ok(asNumber(b!) < asNumber(c!), `round 2 not before round 3 for ${key}`);
  }
});

test("targetMonthFor chases the previous month", () => {
  assert.equal(targetMonthFor({ year: 2026, month: 9, day: 1 }), "2026-08");
  // Year boundary: January chases the previous December.
  assert.equal(targetMonthFor({ year: 2027, month: 1, day: 3 }), "2026-12");
});

test("December rolls over into the next year correctly", () => {
  const first = reminderDate("2026-12", 1);
  assert.equal(first.year, 2027);
  assert.equal(first.month, 1);
});

test("roundDueOn identifies a scheduled day and its target month", () => {
  const due = roundDueOn({ year: 2026, month: 9, day: 1 });
  assert.deepEqual(due, { round: 1, targetMonth: "2026-08" });

  const third = roundDueOn({ year: 2026, month: 9, day: 10 });
  assert.deepEqual(third, { round: 3, targetMonth: "2026-08" });
});

test("roundDueOn returns null on an unscheduled day", () => {
  assert.equal(roundDueOn({ year: 2026, month: 9, day: 14 }), null);
  assert.equal(roundDueOn({ year: 2026, month: 9, day: 20 }), null);
});

test("roundDueOn finds the shifted round, not the nominal date", () => {
  // July 2026's round 1 shifts from Sat 1 Aug to Mon 3 Aug.
  assert.equal(roundDueOn({ year: 2026, month: 8, day: 1 }), null);
  assert.deepEqual(roundDueOn({ year: 2026, month: 8, day: 3 }), {
    round: 1,
    targetMonth: "2026-07",
  });
});

test("todayInNepal is stable regardless of the machine timezone", () => {
  // 2026-09-14T19:30Z is already 15 Sep in Nepal (UTC+5:45).
  const late = todayInNepal(new Date("2026-09-14T19:30:00Z"));
  assert.deepEqual(late, { year: 2026, month: 9, day: 15 });
  // ...but 2026-09-14T18:00Z is still the 14th there.
  const earlier = todayInNepal(new Date("2026-09-14T18:00:00Z"));
  assert.deepEqual(earlier, { year: 2026, month: 9, day: 14 });
});

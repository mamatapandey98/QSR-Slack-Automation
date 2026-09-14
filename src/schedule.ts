/**
 * Reminder scheduling.
 *
 * A month's QSR is filled during the first days of the following month, so each month gets
 * three rounds, all at 10:00 NPT:
 *
 *   Round 1 — 1st  — channel announcement that the QSR is due
 *   Round 2 — 5th  — DM anyone still outstanding
 *   Round 3 — 10th — DM anyone still outstanding, final call
 *
 * If a date lands on a Saturday or Sunday it moves forward to the next working day, so a round
 * due Sat the 1st goes out Mon the 3rd. Nothing is ever skipped.
 *
 * All date maths uses UTC internally so results never shift with the machine's timezone; these
 * are calendar dates, not instants.
 */

export type ReminderRound = 1 | 2 | 3;

export const ROUNDS: ReminderRound[] = [1, 2, 3];

/** Nominal day of the following month each round targets. */
export const ROUND_DAY: Record<ReminderRound, number> = { 1: 1, 2: 5, 3: 10 };

/** Hour of day, Nepal time, that reminders go out. */
export const SEND_HOUR_NPT = 10;

export type CalendarDate = { year: number; month: number; day: number };

function toUtc({ year, month, day }: CalendarDate): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function fromUtc(date: Date): CalendarDate {
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

/** Saturday or Sunday. */
export function isWeekend(date: CalendarDate): boolean {
  const day = toUtc(date).getUTCDay();
  return day === 0 || day === 6;
}

/** Moves forward to the next Monday–Friday, or returns the date unchanged. */
export function nextWorkingDay(date: CalendarDate): CalendarDate {
  let current = toUtc(date);
  while (current.getUTCDay() === 0 || current.getUTCDay() === 6) {
    current = new Date(current.getTime() + 86_400_000);
  }
  return fromUtc(current);
}

/** "2026-08" -> { year: 2026, month: 8 } */
function parseMonthKey(month: string): { year: number; month: number } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (!match?.[1] || !match[2]) throw new Error(`Invalid month "${month}", expected YYYY-MM`);
  return { year: Number(match[1]), month: Number(match[2]) };
}

function formatMonthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** The month whose QSR is being chased when reminders run in the given month. */
export function targetMonthFor(date: CalendarDate): string {
  const previous = new Date(Date.UTC(date.year, date.month - 2, 1));
  return formatMonthKey(previous.getUTCFullYear(), previous.getUTCMonth() + 1);
}

/**
 * The date a round actually goes out for a given target month, weekend shift applied.
 * `targetMonth` is the month being chased, e.g. "2026-08" -> rounds fall in September.
 */
export function reminderDate(targetMonth: string, round: ReminderRound): CalendarDate {
  const { year, month } = parseMonthKey(targetMonth);
  // Rounds land in the month *after* the one being reported on.
  const following = new Date(Date.UTC(year, month, 1));
  return nextWorkingDay({
    year: following.getUTCFullYear(),
    month: following.getUTCMonth() + 1,
    day: ROUND_DAY[round],
  });
}

function sameDate(a: CalendarDate, b: CalendarDate): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/**
 * Which round, if any, is due on the given date — and for which month.
 * Returns null on days with nothing scheduled.
 */
export function roundDueOn(
  date: CalendarDate,
): { round: ReminderRound; targetMonth: string } | null {
  // A round for month M fires in M+1. Check the month being chased on this date, and also the
  // one before it, so a shifted round landing late still resolves correctly.
  for (const offset of [0, 1]) {
    const base = new Date(Date.UTC(date.year, date.month - 1 - offset, 1));
    const targetMonth = targetMonthFor({
      year: base.getUTCFullYear(),
      month: base.getUTCMonth() + 1,
      day: 1,
    });
    for (const round of ROUNDS) {
      if (sameDate(reminderDate(targetMonth, round), date)) return { round, targetMonth };
    }
  }
  return null;
}

/** Today as a calendar date in Nepal time, regardless of the machine's timezone. */
export function todayInNepal(now: Date = new Date()): CalendarDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kathmandu",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [year, month, day] = parts.split("-").map(Number);
  return { year: year ?? 0, month: month ?? 0, day: day ?? 0 };
}

export function formatDate(date: CalendarDate): string {
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][toUtc(date).getUTCDay()];
  return `${weekday} ${date.year}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

/** How each round is delivered. */
export const ROUND_DELIVERY: Record<ReminderRound, "channel" | "dm"> = {
  1: "channel",
  2: "dm",
  3: "dm",
};

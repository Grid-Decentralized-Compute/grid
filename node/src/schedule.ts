/**
 * When the host offers the machine: hours of the day and days of the week, read off the machine's
 * clock (set TZ to use another time zone).
 */
export type Schedule = {
  /** Minute of the day the window opens, 0 to 1439. */
  from: number;
  /** Minute of the day it closes, 0 to 1440, not included. Below `from` means the window runs past midnight. */
  to: number;
  /** Days of the week a window may start on, 0 = Sunday. */
  days: ReadonlySet<number>;
  /** The settings as written, for the log. */
  label: string;
};

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Parses GRID_HOURS ("23-08", "22:30-07:00") and GRID_DAYS ("mon-fri", "sat,sun", "all"). Null = always. */
export function parseSchedule(hours: string | undefined, days: string | undefined): Schedule | null {
  const hoursText = hours?.trim() ?? "";
  const daysText = days?.trim() ?? "";
  const everyDay = daysText === "" || daysText.toLowerCase() === "all";
  if (hoursText === "" && everyDay) return null;

  const [from, to] = hoursText === "" ? [0, 1440] : parseHours(hoursText);
  return {
    from,
    to,
    days: everyDay ? new Set([0, 1, 2, 3, 4, 5, 6]) : parseDays(daysText),
    label: [hoursText, everyDay ? "" : daysText].filter(Boolean).join(", "),
  };
}

/** Whether the machine is on offer at this moment. */
export function isOpenAt(schedule: Schedule | null, at = new Date()): boolean {
  if (!schedule) return true;
  const minute = at.getHours() * 60 + at.getMinutes();
  const today = at.getDay();
  if (schedule.from < schedule.to) {
    return schedule.days.has(today) && minute >= schedule.from && minute < schedule.to;
  }
  // A window past midnight belongs to the day it starts on: its evening is today's, its morning yesterday's.
  return (minute >= schedule.from && schedule.days.has(today)) || (minute < schedule.to && schedule.days.has((today + 6) % 7));
}

function parseHours(text: string): [number, number] {
  const match = text.match(/^(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?$/);
  const bad = () => new Error(`GRID_HOURS must look like 23-08 or 22:30-07:00 (the machine's local time), got "${text}"`);
  if (!match) throw bad();
  const minutes = (hour: string, minute: string | undefined) => Number(hour) * 60 + Number(minute ?? 0);
  const from = minutes(match[1], match[2]);
  const to = minutes(match[3], match[4]);
  if (Number(match[2] ?? 0) > 59 || Number(match[4] ?? 0) > 59 || from >= 1440 || to > 1440) throw bad();
  if (from === to) throw new Error(`GRID_HOURS "${text}" opens and closes at the same time; leave it unset to be on offer all day`);
  return [from, to];
}

function parseDays(text: string): Set<number> {
  const days = new Set<number>();
  for (const part of text.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part.toLowerCase() === "all") {
      for (let d = 0; d < 7; d++) days.add(d);
      continue;
    }
    const ends = part.split("-").map((s) => s.trim());
    if (ends.length > 2) throw new Error(`GRID_DAYS: "${part}" is not a day or a range like mon-fri`);
    const first = dayIndex(ends[0]);
    const last = ends.length === 2 ? dayIndex(ends[1]) : first;
    // A range may run over the end of the week: fri-mon is Friday, Saturday, Sunday and Monday.
    for (let d = first; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === last) break;
    }
  }
  if (days.size === 0) throw new Error(`GRID_DAYS "${text}" names no day; use mon, tue, wed, thu, fri, sat, sun, ranges like mon-fri, or all`);
  return days;
}

function dayIndex(word: string): number {
  const w = word.toLowerCase();
  const index = w.length >= 3 ? DAY_NAMES.findIndex((name) => name.startsWith(w)) : -1;
  if (index === -1) throw new Error(`GRID_DAYS: "${word}" is not a day; use mon, tue, wed, thu, fri, sat, sun, ranges like mon-fri, or all`);
  return index;
}

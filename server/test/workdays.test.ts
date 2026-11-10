import { describe, expect, it } from 'vitest';
import { addMonths, addWorkdays, isWorkday, trafficLight, workdaysBetween } from '../src/lib/workdays.js';

const none = new Set<string>();

describe('workdays', () => {
  it('skips weekends', () => {
    // 2026-10-09 is a Friday
    expect(addWorkdays('2026-10-09', 1, none)).toBe('2026-10-12');
    expect(addWorkdays('2026-10-12', 10, none)).toBe('2026-10-26');
  });

  it('skips tenant holidays', () => {
    const holidays = new Set(['2026-10-13']);
    expect(addWorkdays('2026-10-12', 1, holidays)).toBe('2026-10-14');
    expect(isWorkday('2026-10-13', holidays)).toBe(false);
    expect(isWorkday('2026-10-17', none)).toBe(false);
  });

  it('counts remaining and overdue working days', () => {
    expect(workdaysBetween('2026-10-12', '2026-10-26', none)).toBe(10);
    expect(workdaysBetween('2026-10-26', '2026-10-12', none)).toBe(-10);
    expect(workdaysBetween('2026-10-16', '2026-10-19', none)).toBe(1);
    expect(workdaysBetween('2026-10-17', '2026-10-18', none)).toBe(0);
    expect(workdaysBetween('2026-10-12', '2026-10-12', none)).toBe(0);
  });

  it('is consistent: workdaysBetween(start, addWorkdays(start, n)) === n', () => {
    const holidays = new Set(['2026-12-25', '2026-12-26', '2027-01-01']);
    for (let n = 0; n < 40; n++) {
      expect(workdaysBetween('2026-12-18', addWorkdays('2026-12-18', n, holidays), holidays)).toBe(n);
    }
  });

  it('adds months for park dates', () => {
    expect(addMonths('2026-10-12', 6)).toBe('2027-04-12');
  });

  it('derives the traffic light', () => {
    expect(trafficLight(5, 2, false)).toBe('green');
    expect(trafficLight(2, 2, false)).toBe('yellow');
    expect(trafficLight(0, 2, false)).toBe('yellow');
    expect(trafficLight(-1, 2, false)).toBe('red');
    expect(trafficLight(-1, 2, true)).toBe('paused');
  });
});

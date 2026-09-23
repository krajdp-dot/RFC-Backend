import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const BUSINESS_TIMEZONE = 'Asia/Kolkata';

/**
 * Get the current business date in Asia/Kolkata timezone.
 * A transaction at 00:18 IST on Aug 14 has business date Aug 13
 * if the business considers the day to end at midnight.
 */
export function getBusinessDate(date?: Date | string): Date {
  const d = date ? dayjs(date).tz(BUSINESS_TIMEZONE) : dayjs().tz(BUSINESS_TIMEZONE);
  return d.startOf('day').toDate();
}

/**
 * Get the current system timestamp in UTC.
 */
export function getSystemTimestamp(): Date {
  return new Date();
}

/**
 * Format a date as YYYY-MM-DD for business date display.
 */
export function formatBusinessDate(date: Date): string {
  return dayjs(date).tz(BUSINESS_TIMEZONE).format('YYYY-MM-DD');
}

/**
 * Parse a YYYY-MM-DD string into a Date in the business timezone.
 */
export function parseBusinessDate(dateStr: string): Date {
  return dayjs.tz(dateStr, BUSINESS_TIMEZONE).startOf('day').toDate();
}

/**
 * Get start and end of a business date range for database queries.
 */
export function getDateRange(
  startDate: string,
  endDate: string,
): { start: Date; end: Date } {
  return {
    start: parseBusinessDate(startDate),
    end: dayjs.tz(endDate, BUSINESS_TIMEZONE).endOf('day').toDate(),
  };
}

/**
 * Get today's date range in business timezone.
 */
export function getTodayRange(): { start: Date; end: Date } {
  const today = dayjs().tz(BUSINESS_TIMEZONE);
  return {
    start: today.startOf('day').toDate(),
    end: today.endOf('day').toDate(),
  };
}

/**
 * Calculate age in days from a given date.
 */
export function getAgeDays(fromDate: Date | string): number {
  const now = dayjs().tz(BUSINESS_TIMEZONE).startOf('day');
  const from = dayjs(fromDate).tz(BUSINESS_TIMEZONE).startOf('day');
  return now.diff(from, 'day');
}

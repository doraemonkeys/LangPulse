import {
  DEFAULT_RUN_LEASE_DURATION_SECONDS,
  ISO_UTC_SUFFIX,
  MAX_PUBLIC_RANGE_DAYS,
} from "./constants";

const UTC_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertUtcDate(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !UTC_DATE_PATTERN.test(value)) {
    throw new Error(`${fieldName} must be a UTC date in YYYY-MM-DD format.`);
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${fieldName} must be a real UTC date.`);
  }

  return value;
}

export function assertUtcTimestamp(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !value.endsWith(ISO_UTC_SUFFIX)) {
    throw new Error(`${fieldName} must be an ISO 8601 UTC timestamp.`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be an ISO 8601 UTC timestamp.`);
  }

  return parsed.toISOString();
}

export function getCurrentUtcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function compareUtcDates(left: string, right: string): number {
  return left.localeCompare(right);
}

export function getInclusiveDaySpan(from: string, to: string): number {
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);
  return Math.floor((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1;
}

export function assertPublicRange(from: string, to: string): void {
  if (compareUtcDates(from, to) > 0) {
    throw new Error("from must be on or before to.");
  }

  if (getInclusiveDaySpan(from, to) > MAX_PUBLIC_RANGE_DAYS) {
    throw new Error(`date range cannot exceed ${MAX_PUBLIC_RANGE_DAYS} days.`);
  }
}

export function parseLeaseDurationSeconds(value: string | undefined): number {
  if (value === undefined) {
    return DEFAULT_RUN_LEASE_DURATION_SECONDS;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("RUN_LEASE_DURATION_SECONDS must be a positive integer.");
  }

  return parsed;
}

export function extendLease(now: Date, leaseDurationSeconds: number): string {
  return new Date(now.getTime() + leaseDurationSeconds * 1_000).toISOString();
}

import { ConflictException } from '@nestjs/common';
import { parseBusinessDate, formatBusinessDate } from './date.util.js';

/**
 * Phase 4 — closed-business-day transaction protection.
 *
 * A business date is "closed" purely by the existence of a DayClose row for
 * (businessId, businessDate) — enforced by the schema's
 * @@unique([businessId, businessDate]) (see DayCloseService.performDayClose).
 * No separate status/isClosed flag anywhere.
 */

function lockNamespace(businessId: string): string {
  return `bizdate:${businessId}`;
}

/**
 * Call inside the SAME Prisma interactive transaction that performs the
 * resulting mutation, before any write in that transaction. Throws
 * ConflictException (409, code BUSINESS_DATE_CLOSED) if `businessDateInput`
 * is already closed for `businessId`; otherwise returns the parsed date
 * (replaces a bare `parseBusinessDate(dto.businessDate)` one-for-one).
 *
 * A thrown error aborts the whole interactive transaction, so a rejection
 * leaves zero financial side effects and never persists an idempotency key
 * for the rejected attempt — every caller in this codebase checks its own
 * idempotency key with a plain findFirst before its first write, so a retry
 * after a closed-date rejection finds nothing and proceeds normally.
 *
 * Concurrency (day-close race): takes a Postgres advisory lock in SHARED
 * mode, transaction-scoped, keyed by (businessId, businessDate).
 * `lockBusinessDateForClose` takes the same key in EXCLUSIVE mode from
 * DayCloseService.performDayClose. Postgres won't grant the exclusive lock
 * while any shared lock on that key is outstanding, and won't grant a new
 * shared lock while the exclusive lock is held — so a close can't finish
 * while a transaction that already passed this check is still committing,
 * and no new transaction can pass this check while a close is in progress.
 * Ordinary transactions on an open day only take the shared lock, so they
 * never block each other — only a concurrent close forces the wait, in
 * both directions. This is real Postgres-enforced mutual exclusion, but can
 * only be exercised (not proven) against the in-memory fake test harness —
 * genuine verification needs real Postgres with two concurrent connections.
 */
export async function assertBusinessDateOpen(
  tx: any,
  businessId: string,
  businessDateInput: string,
): Promise<Date> {
  const bDate = parseBusinessDate(businessDateInput);
  const dateKey = formatBusinessDate(bDate);

  await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtext(${lockNamespace(businessId)}), hashtext(${dateKey}))`;

  const closed = await tx.dayClose.findFirst({
    where: { businessId, businessDate: bDate },
    select: { id: true },
  });

  if (closed) {
    throw new ConflictException({
      message: `Business date ${businessDateInput} is already closed. This transaction cannot be posted to that date.`,
      code: 'BUSINESS_DATE_CLOSED',
      businessDate: businessDateInput,
    });
  }

  return bDate;
}

/**
 * Exclusive counterpart — call once, as the first statement inside
 * DayCloseService.performDayClose's transaction, before its existing
 * find-or-create-DayClose logic.
 */
export async function lockBusinessDateForClose(
  tx: any,
  businessId: string,
  businessDateInput: string,
): Promise<void> {
  const bDate = parseBusinessDate(businessDateInput);
  const dateKey = formatBusinessDate(bDate);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockNamespace(businessId)}), hashtext(${dateKey}))`;
}

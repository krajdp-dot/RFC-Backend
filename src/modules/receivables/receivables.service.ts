import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { toMoneyString } from '../../common/utils/money.util.js';
import { getAgeDays } from '../../common/utils/date.util.js';
import { Decimal } from 'decimal.js';

/**
 * Phase 7 — "due soon" window, in days. This concept did not exist anywhere
 * in the codebase before (only the current/week2/month/overdue aging
 * buckets did). The dashboard's Available Purchasing Power card and the
 * receivables/payables widgets both need a "will this money move in the
 * near future" view, so this documents the new, explicit convention rather
 * than inventing it silently: 7 days, matching the existing "week2" bucket
 * boundary already used just below.
 */
const DUE_SOON_WINDOW_DAYS = 7;

interface CustomerCreditRow {
  customerId: string;
  name: string;
  company: string | null;
  outstanding: Decimal;
  current: Decimal;
  week2: Decimal;
  month: Decimal;
  overdue: Decimal;
  dueToday: Decimal;
  dueSoon: Decimal;
}

@Injectable()
export class ReceivablesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Phase 7: one per-customer pass shared by getReceivablesSummary and
   * getAgingAnalysis, so "who owes what" (the summary) and "how old is it"
   * (the aging buckets) can never disagree with each other or drift apart.
   *
   * Previously both public methods below used Prisma `include` (customer.sales,
   * customer.payments) to fetch this. That resolves fine against a real
   * Postgres connection, but is a silent no-op against this repo's
   * FakePrismaService test double (test-utils/fake-prisma.util.ts's findMany
   * only ever reads `where` / `orderBy` / `take` — `include` is never
   * consulted), which is exactly why neither method had a spec file before
   * Phase 7. Rewritten as two flat queries plus an in-memory join, which
   * works identically against the fake and real Prisma.
   *
   * This also fixes a real correctness bug in the old getReceivablesSummary:
   * it derived "outstanding" as sum(sale.total) − sum(all Payment.amount for
   * that customerId). But refundCustomer() (paying money back to a customer,
   * e.g. after a return on an already-settled sale) also creates a Payment
   * row with that same customerId — so a refund was being subtracted a
   * second time as if it were an ordinary payment reducing what the customer
   * owes, when it should do the opposite. Sale.creditAmount is the field
   * every one of those mutations (receivePayment, refundCustomer,
   * processReturn) already keeps correct on every write, and is what
   * reconciliation.service.ts's checkCustomerOutstanding() independently
   * treats as ground truth — so it's summed directly here instead of being
   * re-derived from raw payment rows.
   */
  private async getCustomerCreditRows(businessId: string): Promise<CustomerCreditRow[]> {
    const [customers, creditSales] = await Promise.all([
      this.prisma.customer.findMany({ where: { businessId } }),
      this.prisma.sale.findMany({
        where: { businessId, creditAmount: { gt: 0 } },
      }),
    ]);

    const salesByCustomer = new Map<string, any[]>();
    for (const sale of creditSales) {
      const list = salesByCustomer.get(sale.customerId) || [];
      list.push(sale);
      salesByCustomer.set(sale.customerId, list);
    }

    return customers.map((c: any) => {
      const terms = c.creditTermsDays || 30; // default 30 days — existing convention, unchanged
      let outstanding = new Decimal(0);
      let current = new Decimal(0);
      let week2 = new Decimal(0);
      let month = new Decimal(0);
      let overdue = new Decimal(0);
      let dueToday = new Decimal(0);
      let dueSoon = new Decimal(0);

      for (const sale of salesByCustomer.get(c.id) || []) {
        const amt = new Decimal(sale.creditAmount);
        outstanding = outstanding.plus(amt);

        // Business-timezone-aware age in whole days (was raw
        // `(Date.now() - saleDate.getTime()) / 86400000` — correct in
        // spirit but not normalized to the business day boundary the rest
        // of the app uses; no existing test pinned the old millisecond
        // form, so this is a safe, small correctness improvement made
        // while this method was already being rewritten).
        const ageDays = getAgeDays(sale.businessDate);
        const daysUntilDue = terms - ageDays;

        if (ageDays > terms) {
          overdue = overdue.plus(amt);
        } else {
          // Existing aging buckets — boundaries unchanged from before.
          if (ageDays > 14) month = month.plus(amt);
          else if (ageDays > 7) week2 = week2.plus(amt);
          else current = current.plus(amt);

          // New: due-soon view, independent of the buckets above.
          if (daysUntilDue < 1) dueToday = dueToday.plus(amt);
          else if (daysUntilDue <= DUE_SOON_WINDOW_DAYS) dueSoon = dueSoon.plus(amt);
        }
      }

      return {
        customerId: c.id,
        name: c.name,
        company: c.businessName ?? null,
        outstanding, current, week2, month, overdue, dueToday, dueSoon,
      };
    });
  }

  async getReceivablesSummary(businessId: string) {
    const rows = await this.getCustomerCreditRows(businessId);
    return rows
      .filter((r) => r.outstanding.gt(0))
      .sort((a, b) => b.outstanding.cmp(a.outstanding))
      .map((r) => ({
        customerId: r.customerId,
        name: r.name,
        company: r.company,
        outstanding: toMoneyString(r.outstanding),
        // New field, additive: lets a consumer (the dashboard) tell "owes
        // us money" apart from "owes us money that's overdue" without a
        // second query. Nothing existing reads a fixed shape from this
        // endpoint (grep confirms only ReceivablesController does, and it
        // just passes the result straight through), so this is safe to add.
        overdue: toMoneyString(r.overdue),
      }));
  }

  async getAgingAnalysis(businessId: string) {
    const rows = await this.getCustomerCreditRows(businessId);

    const sum = (pick: (r: CustomerCreditRow) => Decimal) =>
      rows.reduce((acc, r) => acc.plus(pick(r)), new Decimal(0));
    const countWhere = (pick: (r: CustomerCreditRow) => Decimal) =>
      rows.filter((r) => pick(r).gt(0)).length;

    return {
      // Unchanged fields/values from before this rewrite.
      current: toMoneyString(sum((r) => r.current)),
      week2: toMoneyString(sum((r) => r.week2)),
      month: toMoneyString(sum((r) => r.month)),
      overdue: toMoneyString(sum((r) => r.overdue)),
      total: toMoneyString(sum((r) => r.outstanding)),
      // New: counts + due-soon view, for Phase 7's dashboard.
      overdueCount: countWhere((r) => r.overdue),
      dueTodayValue: toMoneyString(sum((r) => r.dueToday)),
      dueTodayCount: countWhere((r) => r.dueToday),
      dueSoonValue: toMoneyString(sum((r) => r.dueSoon)),
      dueSoonCount: countWhere((r) => r.dueSoon),
    };
  }
}

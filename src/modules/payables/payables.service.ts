import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { toMoneyString } from '../../common/utils/money.util.js';
import { getAgeDays } from '../../common/utils/date.util.js';
import { Decimal } from 'decimal.js';

/**
 * Phase 7 — "due soon" window, in days. Mirrors receivables.service.ts's
 * constant of the same name/value; see that file's comment for the
 * reasoning (this concept didn't exist anywhere in the codebase before
 * Phase 7, so the 7-day window is documented here rather than invented
 * silently).
 */
const DUE_SOON_WINDOW_DAYS = 7;

interface SupplierCreditRow {
  supplierId: string;
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
export class PayablesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Phase 7: one per-supplier pass shared by getPayablesSummary and
   * getAgingAnalysis. See receivables.service.ts's getCustomerCreditRows for
   * the full reasoning — this is the exact same fix, mirrored for suppliers:
   * avoids Prisma `include` (a silent no-op against FakePrismaService, which
   * is why this had no test file before Phase 7) and sums
   * Purchase.creditAmount directly instead of re-deriving outstanding from
   * sum(landedCost) − sum(all Payment.amount for that supplierId) — the
   * latter would double-count a refundSupplier() payment (money the
   * supplier pays back) the same way the receivables side would have
   * double-counted a customer refund.
   */
  private async getSupplierCreditRows(businessId: string): Promise<SupplierCreditRow[]> {
    const [suppliers, creditPurchases] = await Promise.all([
      this.prisma.supplier.findMany({ where: { businessId } }),
      this.prisma.purchase.findMany({
        where: { businessId, creditAmount: { gt: 0 } },
      }),
    ]);

    const purchasesBySupplier = new Map<string, any[]>();
    for (const purchase of creditPurchases) {
      const list = purchasesBySupplier.get(purchase.supplierId) || [];
      list.push(purchase);
      purchasesBySupplier.set(purchase.supplierId, list);
    }

    return suppliers.map((s: any) => {
      const terms = s.paymentTermsDays || 30; // default 30 days — existing convention, unchanged
      let outstanding = new Decimal(0);
      let current = new Decimal(0);
      let week2 = new Decimal(0);
      let month = new Decimal(0);
      let overdue = new Decimal(0);
      let dueToday = new Decimal(0);
      let dueSoon = new Decimal(0);

      for (const purchase of purchasesBySupplier.get(s.id) || []) {
        const amt = new Decimal(purchase.creditAmount);
        outstanding = outstanding.plus(amt);

        const ageDays = getAgeDays(purchase.businessDate);
        const daysUntilDue = terms - ageDays;

        if (ageDays > terms) {
          overdue = overdue.plus(amt);
        } else {
          if (ageDays > 14) month = month.plus(amt);
          else if (ageDays > 7) week2 = week2.plus(amt);
          else current = current.plus(amt);

          if (daysUntilDue < 1) dueToday = dueToday.plus(amt);
          else if (daysUntilDue <= DUE_SOON_WINDOW_DAYS) dueSoon = dueSoon.plus(amt);
        }
      }

      return {
        supplierId: s.id,
        name: s.name,
        company: s.businessName ?? null,
        outstanding, current, week2, month, overdue, dueToday, dueSoon,
      };
    });
  }

  async getPayablesSummary(businessId: string) {
    const rows = await this.getSupplierCreditRows(businessId);
    return rows
      .filter((r) => r.outstanding.gt(0))
      .sort((a, b) => b.outstanding.cmp(a.outstanding))
      .map((r) => ({
        supplierId: r.supplierId,
        name: r.name,
        company: r.company,
        outstanding: toMoneyString(r.outstanding),
        overdue: toMoneyString(r.overdue),
      }));
  }

  async getAgingAnalysis(businessId: string) {
    const rows = await this.getSupplierCreditRows(businessId);

    const sum = (pick: (r: SupplierCreditRow) => Decimal) =>
      rows.reduce((acc, r) => acc.plus(pick(r)), new Decimal(0));
    const countWhere = (pick: (r: SupplierCreditRow) => Decimal) =>
      rows.filter((r) => pick(r).gt(0)).length;

    return {
      current: toMoneyString(sum((r) => r.current)),
      week2: toMoneyString(sum((r) => r.week2)),
      month: toMoneyString(sum((r) => r.month)),
      overdue: toMoneyString(sum((r) => r.overdue)),
      total: toMoneyString(sum((r) => r.outstanding)),
      overdueCount: countWhere((r) => r.overdue),
      dueTodayValue: toMoneyString(sum((r) => r.dueToday)),
      dueTodayCount: countWhere((r) => r.dueToday),
      dueSoonValue: toMoneyString(sum((r) => r.dueSoon)),
      dueSoonCount: countWhere((r) => r.dueSoon),
    };
  }
}

import { AccountType, AuditAction } from '../../common/enums.js';
import { Injectable, ConflictException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { toDecimal, sumDecimal, toMoneyString } from '../../common/utils/money.util.js';
import { parseBusinessDate, formatBusinessDate, getDateRange } from '../../common/utils/date.util.js';
import { lockBusinessDateForClose } from '../../common/utils/business-date-guard.util.js';
import { AuditService } from '../audit/audit.service.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { CreateDayCloseDto } from './dto/day-close.dto.js';

@Injectable()
export class DayCloseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  /**
   * Phase 8: the cash/variance calculation itself, extracted so it can be
   * reused by both the real close (inside its transaction+lock, below) and
   * a new read-only preview endpoint. No behavior change for the existing
   * close flow — same queries, same math, just callable without writing a
   * DayClose row. This is what lets the day-close UI show expected cash,
   * breakdown, and reconciliation warnings *before* the user commits,
   * without re-deriving any of this logic on the frontend.
   */
  private async calculateDayCloseBreakdown(
    client: any,
    businessId: string,
    dateStr: string,
    physicalCash?: number | null,
  ) {
    const { start, end } = getDateRange(dateStr, dateStr);

    const cashAccounts = await client.account.findMany({ where: { businessId, type: AccountType.CASH } });
    const cashAccountIds = cashAccounts.map((a: any) => a.id);

    const cashEntries = cashAccountIds.length > 0
      ? await client.ledgerEntry.findMany({
          where: { businessId, accountId: { in: cashAccountIds }, businessDate: { gte: start, lte: end } },
        })
      : [];

    let cashReceived = toDecimal(0);
    let cashPaidToSuppliers = toDecimal(0);
    let cashExpenses = toDecimal(0);
    let cashDeposits = toDecimal(0);
    let cashWithdrawals = toDecimal(0);
    let cashRefundsIn = toDecimal(0);
    let cashRefundsOut = toDecimal(0);
    let cashOther = toDecimal(0);

    for (const entry of cashEntries) {
      const debit = toDecimal(entry.debit || 0);
      const credit = toDecimal(entry.credit || 0);
      switch (entry.transactionType) {
        case 'CUSTOMER_PAYMENT':
          cashReceived = cashReceived.plus(debit);
          break;
        case 'SUPPLIER_PAYMENT':
          cashPaidToSuppliers = cashPaidToSuppliers.plus(credit);
          break;
        case 'EXPENSE':
          cashExpenses = cashExpenses.plus(credit);
          break;
        case 'TRANSFER':
          cashDeposits = cashDeposits.plus(credit);
          cashWithdrawals = cashWithdrawals.plus(debit);
          break;
        case 'REFUND':
          cashRefundsIn = cashRefundsIn.plus(debit);
          cashRefundsOut = cashRefundsOut.plus(credit);
          break;
        default:
          cashOther = cashOther.plus(debit).minus(credit);
      }
    }

    const openingBalanceTotal = cashAccounts.reduce(
      (sum: any, a: any) => sumDecimal(sum, a.openingBalance), toDecimal(0),
    );
    let priorNet = toDecimal(0);
    if (cashAccountIds.length > 0) {
      const priorAggr = await client.ledgerEntry.aggregate({
        where: { businessId, accountId: { in: cashAccountIds }, businessDate: { lt: start } },
        _sum: { debit: true, credit: true },
      });
      priorNet = toDecimal(priorAggr._sum.debit).minus(toDecimal(priorAggr._sum.credit));
    }
    const openingPhysicalCash = openingBalanceTotal.plus(priorNet);

    const expectedClosingCash = openingPhysicalCash
      .plus(cashReceived)
      .minus(cashPaidToSuppliers)
      .minus(cashExpenses)
      .minus(cashDeposits)
      .plus(cashWithdrawals)
      .plus(cashRefundsIn)
      .minus(cashRefundsOut)
      .plus(cashOther);

    const actualCash = physicalCash != null ? toDecimal(physicalCash) : null;
    const variance = actualCash != null ? actualCash.minus(expectedClosingCash) : null;

    const [salesAggr, purchasesAggr, collectionsAggr, supplierPaymentsAggr, expensesAggr, wastageAggr] = await Promise.all([
      client.sale.aggregate({ where: { businessId, businessDate: { gte: start, lte: end } }, _sum: { total: true } }),
      client.purchase.aggregate({ where: { businessId, businessDate: { gte: start, lte: end } }, _sum: { landedCost: true } }),
      client.payment.aggregate({ where: { businessId, transactionType: 'CUSTOMER_PAYMENT', businessDate: { gte: start, lte: end } }, _sum: { amount: true } }),
      client.payment.aggregate({ where: { businessId, transactionType: 'SUPPLIER_PAYMENT', businessDate: { gte: start, lte: end } }, _sum: { amount: true } }),
      client.expense.aggregate({ where: { businessId, businessDate: { gte: start, lte: end } }, _sum: { amount: true } }),
      client.inventoryMovement.aggregate({ where: { businessId, movementType: 'WASTAGE', businessDate: { gte: start, lte: end } }, _sum: { totalCost: true } }),
    ]);

    const breakdown = {
      openingPhysicalCash: toMoneyString(openingPhysicalCash),
      cashReceived: toMoneyString(cashReceived),
      cashPaidToSuppliers: toMoneyString(cashPaidToSuppliers),
      cashExpenses: toMoneyString(cashExpenses),
      cashDeposits: toMoneyString(cashDeposits),
      cashWithdrawals: toMoneyString(cashWithdrawals),
      cashRefundsIn: toMoneyString(cashRefundsIn),
      cashRefundsOut: toMoneyString(cashRefundsOut),
      expectedClosingCash: toMoneyString(expectedClosingCash),
      actualCash: actualCash ? toMoneyString(actualCash) : null,
      variance: variance ? toMoneyString(variance) : null,
    };

    const totals = {
      salesTotal: toDecimal(salesAggr._sum.total || 0),
      collectionsTotal: toDecimal(collectionsAggr._sum.amount || 0),
      purchasesTotal: toDecimal(purchasesAggr._sum.landedCost || 0),
      supplierPaymentsTotal: toDecimal(supplierPaymentsAggr._sum.amount || 0),
      expensesTotal: toDecimal(expensesAggr._sum.amount || 0),
      wastageTotal: toDecimal(wastageAggr._sum.totalCost || 0),
    };

    return { breakdown, totals, expectedClosingCash, actualCash, variance };
  }

  /**
   * Phase 8: read-only preview for the day-close UI — same math as an
   * actual close, without writing anything, so the person can see expected
   * cash / breakdown / reconciliation warnings and decide whether to
   * actually commit. Also tells the caller if this date is already closed
   * (in which case there's nothing left to preview — just show the
   * existing record).
   */
  async previewDayClose(businessId: string, dateStr: string, physicalCash?: number | null) {
    const businessDateNormalized = parseBusinessDate(dateStr);
    const existing = await this.prisma.dayClose.findFirst({
      where: { businessId, businessDate: businessDateNormalized },
    });
    if (existing) {
      return { alreadyClosed: true, existing };
    }

    const { breakdown, totals } = await this.calculateDayCloseBreakdown(
      this.prisma, businessId, dateStr, physicalCash,
    );
    const verification = await this.reconciliationService.getVerification(businessId);
    const reconciliationWarnings = (verification.integrityChecks || []).filter(
      (c: any) => c.status !== 'PASS',
    );

    return {
      alreadyClosed: false,
      businessDate: dateStr,
      salesTotal: toMoneyString(totals.salesTotal),
      collectionsTotal: toMoneyString(totals.collectionsTotal),
      purchasesTotal: toMoneyString(totals.purchasesTotal),
      supplierPaymentsTotal: toMoneyString(totals.supplierPaymentsTotal),
      expensesTotal: toMoneyString(totals.expensesTotal),
      wastageTotal: toMoneyString(totals.wastageTotal),
      breakdown,
      reconciliationWarnings,
    };
  }

  async performDayClose(businessId: string, dto: CreateDayCloseDto, actingUserId?: string | null) {
    const dateStr = dto.businessDate || formatBusinessDate(new Date());
    // The normalized (midnight, business-timezone) instant is what's stored
    // and what the @@unique([businessId, businessDate]) constraint keys on.
    const businessDateNormalized = parseBusinessDate(dateStr);

    return this.prisma.$transaction(async (tx) => {
      // Phase 4 — day-close race condition: exclusive counterpart to
      // assertBusinessDateOpen (see business-date-guard.util.ts). Waits for
      // any in-flight sale/purchase/payment/expense for this exact date to
      // finish committing, then blocks new ones from starting until this
      // close itself commits or rolls back.
      await lockBusinessDateForClose(tx, businessId, dateStr);

      const { breakdown, totals, expectedClosingCash, actualCash, variance } =
        await this.calculateDayCloseBreakdown(tx, businessId, dateStr, dto.physicalCash);

      // The @@unique([businessId, businessDate]) constraint is the real
      // protection here — it holds even under two genuinely concurrent
      // requests, which an application-level "check then create" cannot. A
      // P2002 here means someone already closed this exact business date.
      let record;
      try {
        record = await tx.dayClose.create({
          data: {
            businessId,
            businessDate: businessDateNormalized,
            salesTotal: totals.salesTotal,
            collectionsTotal: totals.collectionsTotal,
            purchasesTotal: totals.purchasesTotal,
            supplierPaymentsTotal: totals.supplierPaymentsTotal,
            expensesTotal: totals.expensesTotal,
            wastageTotal: totals.wastageTotal,
            expectedCash: expectedClosingCash,
            physicalCash: actualCash,
            difference: variance,
            closedBy: actingUserId ?? null,
            closedAt: new Date(),
          },
        });
      } catch (err: any) {
        if (err?.code === 'P2002') {
          const existing = await tx.dayClose.findFirst({
            where: { businessId, businessDate: businessDateNormalized },
          });
          throw new ConflictException({
            message: `Business date ${dateStr} is already closed`,
            code: 'BUSINESS_DATE_CLOSED',
            existing,
          });
        }
        throw err;
      }

      // Read-only; reuses the existing reconciliation logic rather than
      // duplicating any of its checks here.
      const verification = await this.reconciliationService.getVerification(businessId);
      const reconciliationWarnings = (verification.integrityChecks || []).filter(
        (c: any) => c.status !== 'PASS',
      );

      await this.auditService.record(tx, {
        businessId,
        userId: actingUserId,
        action: AuditAction.CREATE,
        entityType: 'DAY_CLOSE',
        entityId: record.id,
        after: { businessDate: dateStr, ...breakdown, reconciliationWarnings },
        reason: dto.notes,
      });

      return { ...record, breakdown, reconciliationWarnings };
    });
  }

  async getDayClose(businessId: string, date: string) {
    // Same normalization as the write path.
    return this.prisma.dayClose.findFirst({
      where: { businessId, businessDate: parseBusinessDate(date) },
    });
  }
}

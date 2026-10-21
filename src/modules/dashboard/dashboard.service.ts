import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReceivablesService } from '../receivables/receivables.service.js';
import { PayablesService } from '../payables/payables.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { FreshnessService } from '../freshness/freshness.service.js';
import { toDecimal, sumDecimal, toMoneyString, calcMarginPct } from '../../common/utils/money.util.js';
import { getTodayRange, formatBusinessDate, getBusinessDate, parseBusinessDate, getDateRange } from '../../common/utils/date.util.js';
import { Decimal } from 'decimal.js';

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly receivablesService: ReceivablesService,
    private readonly payablesService: PayablesService,
    private readonly expensesService: ExpensesService,
    private readonly reconciliationService: ReconciliationService,
    private readonly freshnessService: FreshnessService,
  ) {}

  async getTodayDashboard(businessId: string) {
    const { start: todayStart, end: todayEnd } = getTodayRange();
    const todayStr = formatBusinessDate(getBusinessDate());

    // Month start, computed off the 'YYYY-MM-DD' business-date STRING rather
    // than mutating a Date with setDate(1) — a Date's getDate()/setDate()
    // read/write the JS runtime's LOCAL calendar fields, which on a
    // UTC-clocked container silently shifts an IST midnight instant onto
    // the wrong calendar day. parseBusinessDate does the same
    // string -> IST-midnight conversion already used everywhere else in
    // this codebase (e.g. day-close, business-date-guard).
    const monthStartStr = `${todayStr.slice(0, 7)}-01`;
    const monthStart = parseBusinessDate(monthStartStr);

    const [
      business,
      todaySales,
      todayPurchases,
      monthSalesAggrRows,
      allAccounts,
      allLedgerEntries,
      activeLots,
      monthWastageMovements,
      todaySaleMovements,
      todayPurchaseMovements,
      receivablesAging,
      receivablesTop,
      payablesAging,
      payablesTop,
      expenseTodaySummary,
      expenseMonthSummary,
      todayExpenseRows,
      reorderRecs,
      reconciliation,
      atRiskStock,
      products,
      customers,
      suppliers,
      todayCustomerPayments,
      todaySupplierPayments,
      todayRefunds,
      todayTransfers,
    ] = await Promise.all([
      this.prisma.business.findUnique({ where: { id: businessId } }),
      this.prisma.sale.findMany({ where: { businessId, businessDate: { gte: todayStart, lte: todayEnd } } }),
      this.prisma.purchase.findMany({ where: { businessId, businessDate: { gte: todayStart, lte: todayEnd } } }),
      this.prisma.sale.findMany({ where: { businessId, businessDate: { gte: monthStart, lte: todayEnd } } }),
      this.prisma.account.findMany({ where: { businessId } }),
      this.prisma.ledgerEntry.findMany({ where: { businessId } }),
      this.prisma.lot.findMany({ where: { businessId, status: 'ACTIVE', remainingBoxes: { gt: 0 } } }),
      this.prisma.inventoryMovement.findMany({
        where: { businessId, movementType: 'WASTAGE', businessDate: { gte: monthStart, lte: todayEnd } },
      }),
      this.prisma.inventoryMovement.findMany({
        where: { businessId, movementType: 'SALE', businessDate: { gte: todayStart, lte: todayEnd } },
      }),
      this.prisma.inventoryMovement.findMany({
        where: { businessId, movementType: 'PURCHASE', businessDate: { gte: todayStart, lte: todayEnd } },
      }),
      this.receivablesService.getAgingAnalysis(businessId),
      this.receivablesService.getReceivablesSummary(businessId),
      this.payablesService.getAgingAnalysis(businessId),
      this.payablesService.getPayablesSummary(businessId),
      this.expensesService.getExpenseSummary(businessId, todayStr, todayStr),
      this.expensesService.getExpenseSummary(businessId, monthStartStr, todayStr),
      this.prisma.expense.findMany({ where: { businessId, businessDate: { gte: todayStart, lte: todayEnd } } }),
      this.getReorderRecommendations(businessId),
      this.reconciliationService.getVerification(businessId),
      this.freshnessService.getAtRiskStock(businessId),
      this.prisma.product.findMany({ where: { businessId, active: true } }),
      this.prisma.customer.findMany({ where: { businessId } }),
      this.prisma.supplier.findMany({ where: { businessId } }),
      this.prisma.payment.findMany({
        where: { businessId, businessDate: { gte: todayStart, lte: todayEnd }, transactionType: 'CUSTOMER_PAYMENT' },
      }),
      this.prisma.payment.findMany({
        where: { businessId, businessDate: { gte: todayStart, lte: todayEnd }, transactionType: 'SUPPLIER_PAYMENT' },
      }),
      this.prisma.payment.findMany({
        where: { businessId, businessDate: { gte: todayStart, lte: todayEnd }, transactionType: 'REFUND' },
      }),
      this.prisma.transfer.findMany({ where: { businessId, businessDate: { gte: todayStart, lte: todayEnd } } }),
    ]);

    const businessName = business?.name || 'Business';
    const customerName = new Map<string, string>(customers.map((c: any) => [c.id, c.name]));
    const supplierName = new Map<string, string>(suppliers.map((s: any) => [s.id, s.name]));
    const productName = new Map<string, string>(products.map((p: any) => [p.id, p.name]));
    const accountName = new Map<string, string>(allAccounts.map((a: any) => [a.id, a.name]));

    // ---- Section 3/4: today's sales & purchases -------------------------
    const todaySaleIds = new Set(todaySales.map((s: any) => s.id));
    const todayPurchaseIds = new Set(todayPurchases.map((p: any) => p.id));

    const sales = this.buildTransactionSummary({
      records: todaySales,
      totalField: 'total',
      receivedOrPaidField: 'received',
      creditField: 'creditAmount',
      payments: todayCustomerPayments.filter((p: any) => p.saleId && todaySaleIds.has(p.saleId)),
      movements: todaySaleMovements,
    });
    const salesCogs = sumDecimal(...todaySales.map((s: any) => s.cogs));
    const salesGrossProfit = sumDecimal(...todaySales.map((s: any) => s.grossProfit));

    const purchases = this.buildTransactionSummary({
      records: todayPurchases,
      totalField: 'landedCost',
      receivedOrPaidField: 'paid',
      creditField: 'creditAmount',
      payments: todaySupplierPayments.filter((p: any) => p.purchaseId && todayPurchaseIds.has(p.purchaseId)),
      movements: todayPurchaseMovements,
    });

    // ---- Section 6/7: cash position & money location ---------------------
    const ledgerByAccount = new Map<string, any[]>();
    for (const entry of allLedgerEntries) {
      const list = ledgerByAccount.get(entry.accountId) || [];
      list.push(entry);
      ledgerByAccount.set(entry.accountId, list);
    }
    const balanceOf = (account: any) => {
      const entries = ledgerByAccount.get(account.id) || [];
      return entries.reduce(
        (bal: Decimal, e: any) => bal.plus(toDecimal(e.debit)).minus(toDecimal(e.credit)),
        toDecimal(account.openingBalance),
      );
    };

    const physicalAccounts = allAccounts.filter((a: any) => ['CASH', 'BANK', 'DIGITAL'].includes(a.type));
    const accountBalances = physicalAccounts.map((a: any) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      balance: toMoneyString(balanceOf(a)),
    }));
    const cashTotal = sumDecimal(...physicalAccounts.filter((a: any) => a.type === 'CASH').map(balanceOf));
    const bankTotal = sumDecimal(...physicalAccounts.filter((a: any) => a.type === 'BANK').map(balanceOf));
    const digitalTotal = sumDecimal(...physicalAccounts.filter((a: any) => a.type === 'DIGITAL').map(balanceOf));
    const availableTotal = sumDecimal(cashTotal, bankTotal, digitalTotal);

    // ---- Section 11: inventory --------------------------------------------
    // costPerBox * remainingBoxes per active lot — NOT lot.landedCost summed
    // (that's the lot's full original cost at purchase time, which
    // overstates value for any lot that's been partly sold since).
    const inventoryValue = sumDecimal(
      ...activeLots.map((l: any) => toDecimal(l.costPerBox).times(l.remainingBoxes)),
    );
    const totalBoxes = activeLots.reduce((sum: number, l: any) => sum + l.remainingBoxes, 0);
    const totalKg = sumDecimal(...activeLots.map((l: any) => l.remainingNetWeightKg));
    const lotCount = activeLots.length;
    const productCount = new Set(activeLots.map((l: any) => l.productId)).size;

    const atRiskLotIds = new Set(atRiskStock.map((s: any) => s.lotId));
    const atRiskBoxes = activeLots
      .filter((l: any) => atRiskLotIds.has(l.id))
      .reduce((sum: number, l: any) => sum + l.remainingBoxes, 0);
    const freshBoxes = totalBoxes - atRiskBoxes;

    // ---- Section 13: wastage -----------------------------------------------
    const wastageValueOf = (rows: any[]) => sumDecimal(...rows.map((m: any) => m.totalCost));
    const wastageBoxesOf = (rows: any[]) => rows.reduce((sum, m: any) => sum + Math.abs(m.quantityBoxes || 0), 0);
    const todayWastageMovements = monthWastageMovements.filter(
      (m: any) => new Date(m.businessDate).getTime() === todayStart.getTime(),
    );
    const wastageByProduct = new Map<string, { value: Decimal; boxes: number }>();
    for (const m of monthWastageMovements) {
      const entry = wastageByProduct.get(m.productId) || { value: new Decimal(0), boxes: 0 };
      entry.value = entry.value.plus(toDecimal(m.totalCost));
      entry.boxes += Math.abs(m.quantityBoxes || 0);
      wastageByProduct.set(m.productId, entry);
    }
    const topWastageProducts = [...wastageByProduct.entries()]
      .map(([productId, v]) => ({
        productId,
        productName: productName.get(productId) || 'Unknown product',
        value: toMoneyString(v.value),
        boxes: v.boxes,
      }))
      .sort((a, b) => Number(b.value) - Number(a.value))
      .slice(0, 5);

    // ---- Section 14: largest expense category ------------------------------
    const largestCategory = expenseTodaySummary.breakdown[0] || null;
    const monthToDateLargestCategory = expenseMonthSummary.breakdown[0] || null;

    // ---- Section 8: Available Purchasing Power ------------------------------
    // Existing, already-shipped formula — PurchasingCapacity.tsx on the
    // frontend already computes and displays this (its tooltip states it
    // verbatim); it was just working off fields that were null/0 before
    // Phase 7. Reused here verbatim rather than inventing a new one, and
    // now computed once, server-side, so the number the person sees is
    // provably derived from real data rather than silently degrading to
    // "cash + bank + UPI" whenever an input happened to be missing.
    const expectedCollections = sumDecimal(receivablesAging.dueTodayValue, receivablesAging.dueSoonValue);
    const supplierCommitments = sumDecimal(payablesAging.dueTodayValue, payablesAging.dueSoonValue);
    // "Essential expenses": the schema has no concept of a scheduled/recurring
    // or credit expense (Expense rows are always fully settled at creation —
    // see expenses.service.ts), so there is no real "upcoming expense"
    // figure to draw on. Today's actual recorded expense total is used as
    // the closest real, non-fabricated proxy, documented here rather than
    // inventing a forward-looking projection with no basis in the data.
    const essentialExpenses = toDecimal(expenseTodaySummary.total);
    const purchasingPowerValue = availableTotal
      .plus(expectedCollections)
      .minus(supplierCommitments)
      .minus(essentialExpenses);

    // ---- Section 16: alerts --------------------------------------------------
    const alerts = this.buildAlerts({
      reconciliation,
      receivablesTop,
      payablesTop,
      reorderRecs,
      atRiskStock,
    });

    // ---- Section 17: recent activity -----------------------------------------
    const recentActivity = this.buildRecentActivity({
      todaySales, todayPurchases, todayCustomerPayments, todaySupplierPayments,
      todayRefunds, todayExpenseRows, todayWastageMovements, todayTransfers,
      customerName, supplierName, productName, accountName,
    });

    // ---- Section 5 (month-to-date framing, matches the "This Month" label
    // BusinessPerformance.tsx already ships with) ------------------------------
    const monthRevenue = sumDecimal(...monthSalesAggrRows.map((s: any) => s.total));
    const monthCogs = sumDecimal(...monthSalesAggrRows.map((s: any) => s.cogs));
    const monthGrossProfit = sumDecimal(...monthSalesAggrRows.map((s: any) => s.grossProfit));
    const monthMarginPct = calcMarginPct(monthRevenue, monthCogs);
    const todayMarginPct = calcMarginPct(sales.total, salesCogs);

    return {
      today: { businessDate: todayStr, date: new Date(), greeting: `Good Evening, ${businessName}` },
      sales: {
        ...sales,
        cogs: toMoneyString(salesCogs),
        grossProfit: toMoneyString(salesGrossProfit),
        marginPct: todayMarginPct.toFixed(2),
      },
      purchases,
      expenses: {
        total: toMoneyString(essentialExpenses),
        count: todayExpenseRows.length,
        largestCategory,
        monthToDateLargestCategory,
      },
      moneyPosition: {
        available: {
          cash: toMoneyString(cashTotal),
          bank: toMoneyString(bankTotal),
          digital: toMoneyString(digitalTotal),
          total: toMoneyString(availableTotal),
        },
        committed: {
          supplierPayables: payablesAging.total,
          // "Committed expenses" has no upcoming/scheduled-expense concept
          // to draw on either (see the Purchasing Power note above) — same
          // real, documented proxy: today's actual expense total.
          expenses: toMoneyString(essentialExpenses),
        },
        working: {
          customerReceivables: receivablesAging.total,
        },
      },
      cashPosition: {
        accounts: accountBalances,
        cash: toMoneyString(cashTotal),
        bank: toMoneyString(bankTotal),
        digital: toMoneyString(digitalTotal),
        total: toMoneyString(availableTotal),
      },
      moneyLocation: {
        cash: toMoneyString(cashTotal),
        bank: toMoneyString(bankTotal),
        digital: toMoneyString(digitalTotal),
        receivables: receivablesAging.total,
        inventory: toMoneyString(inventoryValue),
        payables: payablesAging.total,
      },
      purchasingPower: {
        value: toMoneyString(Decimal.max(0, purchasingPowerValue)),
        raw: toMoneyString(purchasingPowerValue),
        breakdown: {
          available: toMoneyString(availableTotal),
          expectedCollections: toMoneyString(expectedCollections),
          supplierCommitments: toMoneyString(supplierCommitments),
          essentialExpenses: toMoneyString(essentialExpenses),
        },
        formula: 'Available cash/bank/digital + receivables due within 7 days − payables due within 7 days − today\'s recorded expenses',
      },
      receivables: {
        total: receivablesAging.total,
        overdue: receivablesAging.overdue,
        dueSoon: toMoneyString(sumDecimal(receivablesAging.dueTodayValue, receivablesAging.dueSoonValue)),
        current: receivablesAging.current,
        overdueCount: receivablesAging.overdueCount,
        dueSoonCount: receivablesAging.dueTodayCount + receivablesAging.dueSoonCount,
        customersWithOutstanding: receivablesTop.length,
        topOutstanding: receivablesTop.slice(0, 5),
        aging: {
          current: receivablesAging.current,
          week2: receivablesAging.week2,
          month: receivablesAging.month,
          overdue: receivablesAging.overdue,
          total: receivablesAging.total,
        },
      },
      payables: {
        total: payablesAging.total,
        dueToday: payablesAging.dueTodayValue,
        dueThisWeek: payablesAging.dueSoonValue,
        overdue: payablesAging.overdue,
        overdueCount: payablesAging.overdueCount,
        dueSoonCount: payablesAging.dueTodayCount + payablesAging.dueSoonCount,
        suppliersWithOutstanding: payablesTop.length,
        topOutstanding: payablesTop.slice(0, 5),
        aging: {
          current: payablesAging.current,
          week2: payablesAging.week2,
          month: payablesAging.month,
          overdue: payablesAging.overdue,
          total: payablesAging.total,
        },
      },
      inventory: {
        totalValue: toMoneyString(inventoryValue),
        freshStock: freshBoxes,
        atRiskStock: atRiskBoxes,
        totalBoxes,
        totalKg: toMoneyString(totalKg),
        lotCount,
        lowStockCount: reorderRecs.count,
        productCount,
        wastageToday: toMoneyString(wastageValueOf(todayWastageMovements)),
        wastageThisMonth: toMoneyString(wastageValueOf(monthWastageMovements)),
      },
      wastage: {
        today: { value: toMoneyString(wastageValueOf(todayWastageMovements)), boxes: wastageBoxesOf(todayWastageMovements) },
        month: { value: toMoneyString(wastageValueOf(monthWastageMovements)), boxes: wastageBoxesOf(monthWastageMovements) },
        topProducts: topWastageProducts,
      },
      freshness: {
        atRiskLots: atRiskStock.length,
        atRiskValue: toMoneyString(sumDecimal(...atRiskStock.map((s: any) => s.valueAtRisk))),
        clearTodayCount: atRiskStock.filter((s: any) => s.recommendedAction === 'CLEAR_TODAY').length,
      },
      performance: {
        grossRevenue: toMoneyString(monthRevenue),
        cogs: toMoneyString(monthCogs),
        grossProfit: toMoneyString(monthGrossProfit),
        marginPct: monthMarginPct.toFixed(2),
      },
      alerts,
      recentActivity,
    };
  }


  /**
   * Period analytics for the dashboard. All totals are database aggregates;
   * trend points are grouped from the same business-date rows and the recent
   * activity list is bounded independently. No client-side summing of a
   * truncated page is used for financial totals.
   */
  async getAnalytics(
    businessId: string,
    startDate?: string,
    endDate?: string,
    requestedGroupBy?: string,
  ) {
    const today = formatBusinessDate(getBusinessDate());
    const from = startDate || today;
    const to = endDate || today;
    const validDate = (value: string) =>
      /^\\d{4}-\\d{2}-\\d{2}$/.test(value) &&
      !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) &&
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

    if (!validDate(from) || !validDate(to)) {
      throw new BadRequestException('Start date and end date must use YYYY-MM-DD.');
    }

    if (from > to) {
      throw new BadRequestException('Start date must be on or before end date.');
    }

    const { start, end } = getDateRange(from, to);
    const dayMs = 24 * 60 * 60 * 1000;
    const rangeDays = Math.max(
      1,
      Math.floor((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / dayMs) + 1,
    );
    const priorEndDate = new Date(Date.parse(`${from}T00:00:00Z`) - dayMs).toISOString().slice(0, 10);
    const priorStartDate = new Date(Date.parse(`${priorEndDate}T00:00:00Z`) - (rangeDays - 1) * dayMs).toISOString().slice(0, 10);
    const priorRange = getDateRange(priorStartDate, priorEndDate);
    const groupBy: 'day' | 'week' | 'month' =
      requestedGroupBy === 'week' || requestedGroupBy === 'month'
        ? requestedGroupBy
        : 'day';

    const saleWhere = { businessId, businessDate: { gte: start, lte: end } };
    const purchaseWhere = { businessId, businessDate: { gte: start, lte: end } };
    const expenseWhere = { businessId, businessDate: { gte: start, lte: end } };
    const priorSaleWhere = { businessId, businessDate: { gte: priorRange.start, lte: priorRange.end } };
    const priorPurchaseWhere = { businessId, businessDate: { gte: priorRange.start, lte: priorRange.end } };
    const priorExpenseWhere = { businessId, businessDate: { gte: priorRange.start, lte: priorRange.end } };

    const [
      salesAggregate,
      purchasesAggregate,
      expensesAggregate,
      priorSalesAggregate,
      priorPurchasesAggregate,
      priorExpensesAggregate,
      salesByDate,
      purchasesByDate,
      expensesByDate,
      sales,
      purchases,
      payments,
      expenses,
    ] = await Promise.all([
      this.prisma.sale.aggregate({
        where: saleWhere,
        _sum: { total: true, cogs: true, grossProfit: true },
        _count: { _all: true },
      }),
      this.prisma.purchase.aggregate({
        where: purchaseWhere,
        _sum: { landedCost: true },
        _count: { _all: true },
      }),
      this.prisma.expense.aggregate({
        where: expenseWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.sale.aggregate({
        where: priorSaleWhere,
        _sum: { total: true, cogs: true, grossProfit: true },
        _count: { _all: true },
      }),
      this.prisma.purchase.aggregate({
        where: priorPurchaseWhere,
        _sum: { landedCost: true },
        _count: { _all: true },
      }),
      this.prisma.expense.aggregate({
        where: priorExpenseWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.sale.groupBy({
        by: ['businessDate'],
        where: saleWhere,
        _sum: { total: true, grossProfit: true },
        _count: { _all: true },
      }),
      this.prisma.purchase.groupBy({
        by: ['businessDate'],
        where: purchaseWhere,
        _sum: { landedCost: true },
        _count: { _all: true },
      }),
      this.prisma.expense.groupBy({
        by: ['businessDate'],
        where: expenseWhere,
        _sum: { amount: true },
        _count: { _all: true },
      }),
      this.prisma.sale.findMany({
        where: saleWhere,
        orderBy: [{ businessDate: 'desc' }, { systemTimestamp: 'desc' }],
        take: 25,
        include: { customer: { select: { id: true, name: true } } },
      }),
      this.prisma.purchase.findMany({
        where: purchaseWhere,
        orderBy: [{ businessDate: 'desc' }, { systemTimestamp: 'desc' }],
        take: 25,
        include: { supplier: { select: { id: true, name: true } } },
      }),
      this.prisma.payment.findMany({
        where: { businessId, businessDate: { gte: start, lte: end } },
        orderBy: [{ businessDate: 'desc' }, { systemTimestamp: 'desc' }],
        take: 25,
        include: {
          customer: { select: { id: true, name: true } },
          supplier: { select: { id: true, name: true } },
          sale: { select: { saleReference: true } },
          purchase: { select: { purchaseReference: true } },
        },
      }),
      this.prisma.expense.findMany({
        where: expenseWhere,
        orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }],
        take: 25,
        include: { category: { select: { name: true } }, account: { select: { name: true } } },
      }),
    ]);

    const currencyValue = (value: any) => toMoneyString(value ?? 0);
    const aggregateCount = (aggregate: any) => typeof aggregate?._count === 'number' ? aggregate._count : aggregate?._count?._all ?? 0;
    const sumGrossProfit = toDecimal(salesAggregate._sum.grossProfit || 0);
    const salesRevenue = toDecimal(salesAggregate._sum.total || 0);
    const grossMarginPct = salesRevenue.gt(0)
      ? sumGrossProfit.div(salesRevenue).times(100).toDecimalPlaces(2).toFixed(2)
      : null;

    const summary = {
      sales: {
        total: currencyValue(salesAggregate._sum.total),
        grossProfit: currencyValue(salesAggregate._sum.grossProfit),
        cogs: currencyValue(salesAggregate._sum.cogs),
        grossMarginPct,
        count: aggregateCount(salesAggregate),
      },
      purchases: {
        total: currencyValue(purchasesAggregate._sum.landedCost),
        count: aggregateCount(purchasesAggregate),
      },
      expenses: {
        total: currencyValue(expensesAggregate._sum.amount),
        count: aggregateCount(expensesAggregate),
      },
    };

    const previousSales = toDecimal(priorSalesAggregate._sum.total || 0);
    const previousPurchases = toDecimal(priorPurchasesAggregate._sum.landedCost || 0);
    const previousExpenses = toDecimal(priorExpensesAggregate._sum.amount || 0);
    const pctChange = (current: any, prior: any) => {
      const before = toDecimal(prior || 0);
      const now = toDecimal(current || 0);
      if (before.eq(0)) return null;
      return now.minus(before).div(before.abs()).times(100).toDecimalPlaces(1).toNumber();
    };

    const previous = {
      startDate: priorStartDate,
      endDate: priorEndDate,
      sales: currencyValue(priorSalesAggregate._sum.total),
      grossProfit: currencyValue(priorSalesAggregate._sum.grossProfit),
      purchases: currencyValue(priorPurchasesAggregate._sum.landedCost),
      expenses: currencyValue(priorExpensesAggregate._sum.amount),
    };

    const dayKey = (date: Date) => formatBusinessDate(date);
    const bucketKey = (date: Date) => {
      const key = dayKey(date);
      if (groupBy === 'month') return key.slice(0, 7);
      if (groupBy === 'week') {
        const d = new Date(`${key}T00:00:00Z`);
        const daysSinceMonday = (d.getUTCDay() + 6) % 7;
        d.setUTCDate(d.getUTCDate() - daysSinceMonday);
        return d.toISOString().slice(0, 10);
      }
      return key;
    };

    const bucketMap = new Map<string, { sales: Decimal; grossProfit: Decimal; purchases: Decimal; expenses: Decimal; saleCount: number; purchaseCount: number }>();
    const touchBucket = (key: string) => {
      if (!bucketMap.has(key)) {
        bucketMap.set(key, { sales: new Decimal(0), grossProfit: new Decimal(0), purchases: new Decimal(0), expenses: new Decimal(0), saleCount: 0, purchaseCount: 0 });
      }
      return bucketMap.get(key)!;
    };
    // Include quiet dates as real zero-activity buckets so the chart's
    // time axis is continuous rather than silently omitting days with no posts.
    for (
      let cursor = Date.parse(`${from}T00:00:00Z`);
      cursor <= Date.parse(`${to}T00:00:00Z`);
      cursor += dayMs
    ) {
      const dateLabel = new Date(cursor).toISOString().slice(0, 10);
      let key = dateLabel;
      if (groupBy === 'month') {
        key = dateLabel.slice(0, 7);
      } else if (groupBy === 'week') {
        const d = new Date(`${dateLabel}T00:00:00Z`);
        const daysSinceMonday = (d.getUTCDay() + 6) % 7;
        d.setUTCDate(d.getUTCDate() - daysSinceMonday);
        key = d.toISOString().slice(0, 10);
      }
      touchBucket(key);
    }

    for (const row of salesByDate) {
      const b = touchBucket(bucketKey(row.businessDate));
      b.sales = b.sales.plus(toDecimal(row._sum.total || 0));
      b.grossProfit = b.grossProfit.plus(toDecimal(row._sum.grossProfit || 0));
      b.saleCount += row._count?._all ?? 0;
    }
    for (const row of purchasesByDate) {
      const b = touchBucket(bucketKey(row.businessDate));
      b.purchases = b.purchases.plus(toDecimal(row._sum.landedCost || 0));
      b.purchaseCount += row._count?._all ?? 0;
    }
    for (const row of expensesByDate) {
      const b = touchBucket(bucketKey(row.businessDate));
      b.expenses = b.expenses.plus(toDecimal(row._sum.amount || 0));
    }

    const trend = [...bucketMap.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, b]) => ({
        key,
        label: groupBy === 'month' ? key : groupBy === 'week' ? `Week of ${key}` : key,
        sales: toMoneyString(b.sales),
        grossProfit: toMoneyString(b.grossProfit),
        purchases: toMoneyString(b.purchases),
        expenses: toMoneyString(b.expenses),
        saleCount: b.saleCount,
        purchaseCount: b.purchaseCount,
      }));

    const transactions = [
      ...sales.map((sale: any) => ({
        id: sale.id,
        reference: sale.saleReference,
        date: dayKey(sale.businessDate),
        timestamp: sale.systemTimestamp || sale.createdAt,
        party: sale.customer?.name || 'Customer',
        partyId: sale.customer?.id,
        type: 'SALE',
        amount: currencyValue(sale.total),
        status: sale.status || 'COMPLETED',
        paymentStatus: Number(sale.creditAmount || 0) <= 0 ? 'Paid' : Number(sale.received || 0) > 0 ? 'Partially paid' : 'Unpaid',
        href: '/sales',
      })),
      ...purchases.map((purchase: any) => ({
        id: purchase.id,
        reference: purchase.purchaseReference,
        date: dayKey(purchase.businessDate),
        timestamp: purchase.systemTimestamp || purchase.createdAt,
        party: purchase.supplier?.name || 'Supplier',
        partyId: purchase.supplier?.id,
        type: 'PURCHASE',
        amount: currencyValue(purchase.landedCost),
        status: purchase.status || 'COMPLETED',
        paymentStatus: Number(purchase.creditAmount || 0) <= 0 ? 'Paid' : Number(purchase.paid || 0) > 0 ? 'Partially paid' : 'Unpaid',
        href: '/purchases',
      })),
      ...payments.map((payment: any) => {
        const supplierPayment = payment.transactionType === 'SUPPLIER_PAYMENT';
        const refund = payment.transactionType === 'REFUND';
        return {
          id: payment.id,
          reference: payment.sale?.saleReference || payment.purchase?.purchaseReference || '',
          date: dayKey(payment.businessDate),
          timestamp: payment.systemTimestamp || payment.createdAt,
          party: payment.customer?.name || payment.supplier?.name || (refund ? 'Refund' : supplierPayment ? 'Supplier payment' : 'Customer payment'),
          partyId: payment.customer?.id || payment.supplier?.id,
          type: refund ? 'REFUND' : supplierPayment ? 'PAYMENT_OUT' : 'PAYMENT_IN',
          amount: currencyValue(payment.amount),
          status: payment.status || 'COMPLETED',
          paymentStatus: payment.status === 'COMPLETED' ? 'Recorded' : payment.status || 'Recorded',
          href: supplierPayment || (refund && payment.supplierId) ? '/payables' : '/receivables',
        };
      }),
      ...expenses.map((expense: any) => ({
        id: expense.id,
        reference: '',
        date: dayKey(expense.businessDate),
        timestamp: expense.createdAt,
        party: expense.payee || expense.category?.name || 'Expense',
        partyId: undefined,
        type: 'EXPENSE',
        amount: currencyValue(expense.amount),
        status: expense.status || 'COMPLETED',
        paymentStatus: expense.account?.name ? `Paid from ${expense.account.name}` : 'Recorded',
        href: '/expenses',
      })),
    ].sort((a, b) => new Date(b.timestamp || b.date).getTime() - new Date(a.timestamp || a.date).getTime()).slice(0, 25);

    return {
      range: { startDate: from, endDate: to, groupBy },
      summary,
      previous,
      changes: {
        salesPct: pctChange(summary.sales.total, previous.sales),
        purchasesPct: pctChange(summary.purchases.total, previous.purchases),
        expensesPct: pctChange(summary.expenses.total, previous.expenses),
        grossProfitPct: pctChange(summary.sales.grossProfit, previous.grossProfit),
      },
      trend,
      transactions,
      recentLimit: 25,
      comparisonAvailable: !(
        previousSales.eq(0) && previousPurchases.eq(0) && previousExpenses.eq(0) &&
        toDecimal(priorSalesAggregate._sum.grossProfit || 0).eq(0)
      ),
    };
  }

  /**
   * Shared today's-sales / today's-purchases shape: total/count/collected-or-
   * paid/credit (existing fields, values now real), plus boxes/kg (from
   * InventoryMovement — already correct per-lot-allocation weight, no
   * dependency on SaleItem.weightKg ever being populated) and a payment
   * cash/UPI/bank/credit split (from the Payment rows tied to these specific
   * records, grouped by method; CHEQUE is folded into "bank" since a cheque
   * is fundamentally a bank-account movement once it clears — documented
   * here since the frontend only has three payment-method buckets besides
   * credit).
   */
  private buildTransactionSummary(args: {
    records: any[];
    totalField: string;
    receivedOrPaidField: string;
    creditField: string;
    payments: any[];
    movements: any[];
  }) {
    const { records, totalField, receivedOrPaidField, creditField, payments, movements } = args;

    const total = sumDecimal(...records.map((r) => r[totalField]));
    const receivedOrPaid = sumDecimal(...records.map((r) => r[receivedOrPaidField]));
    const credit = sumDecimal(...records.map((r) => r[creditField]));

    let cash = new Decimal(0);
    let upi = new Decimal(0);
    let bank = new Decimal(0);
    for (const p of payments) {
      const amt = toDecimal(p.amount);
      if (p.method === 'CASH') cash = cash.plus(amt);
      else if (p.method === 'UPI') upi = upi.plus(amt);
      else if (p.method === 'BANK_TRANSFER' || p.method === 'CHEQUE') bank = bank.plus(amt);
    }

    const boxes = movements.reduce((sum, m: any) => sum + Math.abs(m.quantityBoxes || 0), 0);
    const kg = sumDecimal(...movements.map((m: any) => toDecimal(m.quantityWeightKg).abs()));

    // Both `collections` and `paid` carry the same value — the caller uses
    // whichever name fits (sales.collections / purchases.paid). Returning a
    // single concrete shape (rather than a computed property key naming
    // only one or the other per call) keeps this statically well-typed
    // instead of a two-branch union callers would need to narrow.
    const receivedOrPaidStr = toMoneyString(receivedOrPaid);
    return {
      total: toMoneyString(total),
      count: records.length,
      collections: receivedOrPaidStr,
      paid: receivedOrPaidStr,
      creditCreated: toMoneyString(credit),
      boxes,
      kg: toMoneyString(kg),
      cash: toMoneyString(cash),
      upi: toMoneyString(upi),
      bank: toMoneyString(bank),
    };
  }

  private buildAlerts(args: {
    reconciliation: any;
    receivablesTop: any[];
    payablesTop: any[];
    reorderRecs: any;
    atRiskStock: any[];
  }) {
    const { reconciliation, receivablesTop, payablesTop, reorderRecs, atRiskStock } = args;
    const alerts: any[] = [];

    for (const check of reconciliation.integrityChecks || []) {
      if (check.status !== 'PASS') {
        for (const d of check.discrepancies) {
          alerts.push({
            type: 'RECONCILIATION_WARNING',
            severity: 'HIGH',
            message: d,
            action: 'Review',
          });
        }
      }
    }

    const overdueReceivables = receivablesTop.filter((r) => Number(r.overdue) > 0).slice(0, 3);
    overdueReceivables.forEach((r, i) => {
      alerts.push({
        type: 'OVERDUE_RECEIVABLE',
        severity: i === 0 ? 'HIGH' : 'MEDIUM',
        message: `${r.name} is \u20b9${Number(r.overdue).toLocaleString('en-IN')} overdue`,
        entityType: 'CUSTOMER',
        entityId: r.customerId,
        action: 'Collect',
      });
    });

    const overduePayables = payablesTop.filter((p) => Number(p.overdue) > 0).slice(0, 3);
    overduePayables.forEach((p, i) => {
      alerts.push({
        type: 'OVERDUE_PAYABLE',
        severity: i === 0 ? 'HIGH' : 'MEDIUM',
        message: `\u20b9${Number(p.overdue).toLocaleString('en-IN')} owed to ${p.name} is overdue`,
        entityType: 'SUPPLIER',
        entityId: p.supplierId,
        action: 'Pay',
      });
    });

    for (const rec of (reorderRecs.recommendations || []).slice(0, 3)) {
      alerts.push({
        type: 'LOW_STOCK',
        severity: rec.availableBoxes === 0 ? 'HIGH' : 'MEDIUM',
        message: `${rec.product.name} is low on stock (${rec.availableBoxes} boxes left, reorder threshold ${rec.reorderThreshold})`,
        entityType: 'PRODUCT',
        entityId: rec.product.id,
        action: 'Reorder',
      });
    }

    const clearToday = atRiskStock.filter((s: any) => s.recommendedAction === 'CLEAR_TODAY');
    if (clearToday.length > 0) {
      const value = clearToday.reduce((sum: Decimal, s: any) => sum.plus(toDecimal(s.valueAtRisk)), new Decimal(0));
      alerts.push({
        type: 'STOCK_AT_RISK',
        severity: 'HIGH',
        message: `${clearToday.length} lot${clearToday.length > 1 ? 's' : ''} need clearing today (\u20b9${toMoneyString(value)} at risk)`,
        action: 'Clear stock',
      });
    }

    return alerts;
  }

  private buildRecentActivity(args: {
    todaySales: any[]; todayPurchases: any[]; todayCustomerPayments: any[]; todaySupplierPayments: any[];
    todayRefunds: any[]; todayExpenseRows: any[]; todayWastageMovements: any[]; todayTransfers: any[];
    customerName: Map<string, string>; supplierName: Map<string, string>; productName: Map<string, string>;
    accountName: Map<string, string>;
  }) {
    const {
      todaySales, todayPurchases, todayCustomerPayments, todaySupplierPayments,
      todayRefunds, todayExpenseRows, todayWastageMovements, todayTransfers,
      customerName, supplierName, productName, accountName,
    } = args;

    const items: Array<{ type: string; description: string; amount: string; time: any }> = [];

    for (const s of todaySales) {
      items.push({
        type: 'SALE',
        description: `Sale to ${customerName.get(s.customerId) || 'customer'} (${s.saleReference})`,
        amount: toMoneyString(s.total),
        time: s.systemTimestamp || s.createdAt,
      });
    }
    for (const p of todayPurchases) {
      items.push({
        type: 'PURCHASE',
        description: `Purchase from ${supplierName.get(p.supplierId) || 'supplier'} (${p.purchaseReference})`,
        amount: toMoneyString(p.landedCost),
        time: p.systemTimestamp || p.createdAt,
      });
    }
    for (const p of todayCustomerPayments) {
      items.push({
        type: 'RECEIPT',
        description: `Payment received from ${customerName.get(p.customerId) || 'customer'}`,
        amount: toMoneyString(p.amount),
        time: p.systemTimestamp || p.createdAt,
      });
    }
    for (const p of todaySupplierPayments) {
      items.push({
        type: 'PAYMENT',
        description: `Payment made to ${supplierName.get(p.supplierId) || 'supplier'}`,
        amount: toMoneyString(p.amount),
        time: p.systemTimestamp || p.createdAt,
      });
    }
    for (const r of todayRefunds) {
      const who = r.customerId ? customerName.get(r.customerId) : supplierName.get(r.supplierId);
      items.push({
        type: 'REFUND',
        description: r.customerId ? `Refund to ${who || 'customer'}` : `Refund from ${who || 'supplier'}`,
        amount: toMoneyString(r.amount),
        time: r.systemTimestamp || r.createdAt,
      });
    }
    for (const e of todayExpenseRows) {
      items.push({
        type: 'EXPENSE',
        description: e.description || 'Expense',
        amount: toMoneyString(e.amount),
        time: e.createdAt,
      });
    }
    for (const m of todayWastageMovements) {
      items.push({
        type: 'WASTAGE',
        description: `Wastage: ${productName.get(m.productId) || 'product'}`,
        amount: toMoneyString(m.totalCost),
        time: m.systemTimestamp || m.createdAt,
      });
    }
    for (const t of todayTransfers) {
      items.push({
        type: 'TRANSFER',
        description: `Transfer: ${accountName.get(t.fromAccountId) || 'account'} \u2192 ${accountName.get(t.toAccountId) || 'account'}`,
        amount: toMoneyString(t.amount),
        time: t.createdAt,
      });
    }

    return items
      .sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime())
      .slice(0, 15);
  }

  /**
   * Phase 5 — real reorder recommendations. Nothing here existed before:
   * lowStockCount above uses a hardcoded "< 10" threshold ignoring
   * reorderThreshold entirely, and there was no per-product recommendation
   * endpoint anywhere in the repo (searched the whole backend for
   * "reorder"/"stock-decision" — this method and its route are new).
   *
   * available stock <= reorderThreshold => eligible. Only counts stock that
   * is actually sellable right now (ACTIVE lots with boxes remaining) — sold,
   * wasted, and depleted lots are excluded by construction, since they're
   * either not ACTIVE or have remainingBoxes 0/excluded by the `gt: 0` filter.
   *
   * Phase 7: unchanged — reused as-is (per spec) both for the dashboard's
   * lowStockCount and for GET /dashboard/reorder, so the two can never
   * disagree.
   */
  async getReorderRecommendations(businessId: string) {
    const products = await this.prisma.product.findMany({
      where: { businessId, active: true },
      include: {
        lots: {
          where: { status: 'ACTIVE', remainingBoxes: { gt: 0 } },
        },
      },
    });

    const recommendations = products
      .map((product: any) => {
        const availableBoxes = product.lots.reduce((sum: number, lot: any) => sum + lot.remainingBoxes, 0);
        const threshold = product.reorderThreshold;
        // No threshold configured => no opinion, not "assume fine" via a
        // hardcoded fallback — excluded from the list entirely rather than
        // silently defaulting to some made-up number.
        if (threshold == null) return null;

        const eligible = availableBoxes <= Number(threshold);
        if (!eligible) return null;

        return {
          product: { id: product.id, name: product.name },
          availableBoxes,
          reorderThreshold: Number(threshold),
          recommendedQty: product.reorderQty != null ? Number(product.reorderQty) : null,
          lotCount: product.lots.length,
        };
      })
      .filter((r: any) => r !== null)
      .sort((a: any, b: any) => a.availableBoxes - b.availableBoxes);

    return { recommendations, count: recommendations.length };
  }
}

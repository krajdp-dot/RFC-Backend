import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { DateRangeDto } from './dto/date-range.dto.js';
import { toDecimal, toMoneyString, sumDecimal } from '../../common/utils/money.util.js';
import { getDateRange } from '../../common/utils/date.util.js';
import { FreshnessService } from '../freshness/freshness.service.js';

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
  ) {}

  private dateRange(q: DateRangeDto) {
    // Phase 8: was `new Date(q.startDate)`/`new Date(q.endDate)` directly —
    // parses as UTC midnight rather than IST business-day midnight, so a
    // same-day report (startDate === endDate) could miss same-day rows
    // entirely, same bug class fixed in expenses.service.ts. getDateRange
    // is the shared business-timezone-aware helper used everywhere else.
    const { start, end } = getDateRange(q.startDate, q.endDate);
    return { gte: start, lte: end };
  }

  async getSales(businessId: string, q: DateRangeDto) {
    const where = { businessId, businessDate: this.dateRange(q) };
    const [aggr, rows] = await Promise.all([
      this.prisma.sale.aggregate({ where, _sum: { total: true, cogs: true, grossProfit: true, creditAmount: true } }),
      this.prisma.sale.findMany({
        where,
        orderBy: { businessDate: 'desc' },
        take: 200,
        include: {
          customer: { select: { name: true } },
          _count: { select: { items: true } },
        },
      }),
    ]);

    return {
      totalSales: (aggr._sum.total || 0).toString(),
      totalCogs: (aggr._sum.cogs || 0).toString(),
      totalGrossProfit: (aggr._sum.grossProfit || 0).toString(),
      totalCredit: (aggr._sum.creditAmount || 0).toString(),
      data: rows.map(s => ({
        id: s.id,
        saleReference: s.saleReference,
        businessDate: s.businessDate,
        customerName: s.customer?.name || 'Unknown',
        itemCount: s._count.items,
        total: s.total.toString(),
        received: s.received.toString(),
        creditAmount: s.creditAmount.toString(),
        cogs: s.cogs.toString(),
        grossProfit: s.grossProfit.toString(),
        status: s.status,
      })),
    };
  }

  async getPurchases(businessId: string, q: DateRangeDto) {
    const where = { businessId, businessDate: this.dateRange(q) };
    const [aggr, rows] = await Promise.all([
      this.prisma.purchase.aggregate({ where, _sum: { landedCost: true, subtotal: true, creditAmount: true } }),
      this.prisma.purchase.findMany({
        where,
        orderBy: { businessDate: 'desc' },
        take: 200,
        include: {
          supplier: { select: { name: true } },
          _count: { select: { items: true } },
        },
      }),
    ]);

    return {
      totalPurchases: (aggr._sum.landedCost || 0).toString(),
      totalSubtotal: (aggr._sum.subtotal || 0).toString(),
      totalCredit: (aggr._sum.creditAmount || 0).toString(),
      data: rows.map(p => ({
        id: p.id,
        purchaseReference: p.purchaseReference,
        businessDate: p.businessDate,
        supplierName: p.supplier?.name || 'Unknown',
        itemCount: p._count.items,
        subtotal: p.subtotal.toString(),
        landedCost: p.landedCost.toString(),
        paid: p.paid.toString(),
        creditAmount: p.creditAmount.toString(),
        status: p.status,
      })),
    };
  }

  async getCashFlow(businessId: string, q: DateRangeDto) {
    const dateFilter = this.dateRange(q);
    // Get all ledger entries for cash/bank/digital accounts in range
    const entries = await this.prisma.ledgerEntry.findMany({
      where: {
        businessId,
        businessDate: dateFilter,
        account: { type: { in: ['CASH', 'BANK', 'DIGITAL'] } },
      },
      include: { account: { select: { name: true, type: true } } },
      orderBy: { businessDate: 'desc' },
      take: 200,
    });

    const totalIn = entries.reduce((sum, e) => sumDecimal(sum, e.debit).toNumber(), 0);
    const totalOut = entries.reduce((sum, e) => sumDecimal(sum, e.credit).toNumber(), 0);

    return {
      in: totalIn.toString(),
      out: totalOut.toString(),
      net: (totalIn - totalOut).toString(),
      data: entries.map(e => ({
        id: e.id,
        date: e.businessDate,
        accountName: e.account?.name,
        accountType: e.account?.type,
        transactionType: e.transactionType,
        description: e.description,
        debit: e.debit.toString(),
        credit: e.credit.toString(),
      })),
    };
  }

  async getMoneyFlow(businessId: string, q: DateRangeDto) {
    const dateFilter = this.dateRange(q);

    // Opening: sum of cash/bank accounts' openingBalance + all ledger entries BEFORE startDate
    const cashAccounts = await this.prisma.account.findMany({
      where: { businessId, type: { in: ['CASH', 'BANK', 'DIGITAL'] } },
    });
    const cashAccountIds = cashAccounts.map(a => a.id);

    let opening = cashAccounts.reduce((sum, a) => sumDecimal(sum, a.openingBalance).toNumber(), 0);
    if (cashAccountIds.length > 0) {
      const priorAggr = await this.prisma.ledgerEntry.aggregate({
        where: { businessId, accountId: { in: cashAccountIds }, businessDate: { lt: new Date(q.startDate) } },
        _sum: { debit: true, credit: true },
      });
      opening += Number(priorAggr._sum.debit || 0) - Number(priorAggr._sum.credit || 0);
    }

    // Collections (customer payments in range)
    const collectionsAggr = await this.prisma.payment.aggregate({
      where: { businessId, transactionType: 'CUSTOMER_PAYMENT', businessDate: dateFilter },
      _sum: { amount: true },
    });
    const collections = Number(collectionsAggr._sum.amount || 0);

    // Purchase payments in range
    const purchasePaymentsAggr = await this.prisma.payment.aggregate({
      where: { businessId, transactionType: 'SUPPLIER_PAYMENT', businessDate: dateFilter },
      _sum: { amount: true },
    });
    const purchases = Number(purchasePaymentsAggr._sum.amount || 0);

    // Expenses in range
    const expensesAggr = await this.prisma.expense.aggregate({
      where: { businessId, businessDate: dateFilter },
      _sum: { amount: true },
    });
    const expenses = Number(expensesAggr._sum.amount || 0);

    const closing = opening + collections - purchases - expenses;

    // Informational only (gross volume of money moved between the
    // business's own accounts) — since `opening`/`closing` above already
    // pool CASH+BANK+DIGITAL together, a transfer between them nets to
    // zero in that total already, so it isn't added into the closing
    // balance calculation.
    const transfersAggr = await this.prisma.transfer.aggregate({
      where: { businessId, businessDate: dateFilter },
      _sum: { amount: true },
    });

    return {
      opening: opening.toString(),
      collections: collections.toString(),
      purchases: purchases.toString(),
      expenses: expenses.toString(),
      transfers: (transfersAggr._sum.amount || 0).toString(),
      closing: closing.toString(),
    };
  }

  async getPnl(businessId: string, q: DateRangeDto) {
    const dateFilter = this.dateRange(q);
    const [salesAggr, expAggr, productMargins] = await Promise.all([
      this.prisma.sale.aggregate({
        where: { businessId, businessDate: dateFilter },
        _sum: { total: true, cogs: true },
      }),
      this.prisma.expense.aggregate({
        where: { businessId, businessDate: dateFilter },
        _sum: { amount: true },
      }),
      // Product-level margin breakdown from sale items
      this.prisma.saleItem.groupBy({
        by: ['productId'],
        where: { sale: { businessId, businessDate: dateFilter } },
        _sum: { total: true, cogs: true, grossProfit: true },
      }),
    ]);

    const rev = Number(salesAggr._sum.total || 0);
    const cogs = Number(salesAggr._sum.cogs || 0);
    const exp = Number(expAggr._sum.amount || 0);

    // Enrich product margins with product names
    const productIds = productMargins.map(p => p.productId);
    const products = productIds.length > 0
      ? await this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } })
      : [];
    const productMap = new Map(products.map(p => [p.id, p.name]));

    return {
      revenue: rev.toString(),
      cogs: cogs.toString(),
      grossProfit: (rev - cogs).toString(),
      expenses: exp.toString(),
      profit: (rev - cogs - exp).toString(),
      data: productMargins.map(pm => ({
        productId: pm.productId,
        productName: productMap.get(pm.productId) || 'Unknown',
        revenue: (pm._sum.total || 0).toString(),
        cogs: (pm._sum.cogs || 0).toString(),
        grossProfit: (pm._sum.grossProfit || 0).toString(),
        margin: Number(pm._sum.total || 0) > 0
          ? ((Number(pm._sum.grossProfit || 0) / Number(pm._sum.total || 1)) * 100).toFixed(2)
          : '0.00',
      })),
    };
  }

  async getInventory(businessId: string, q: DateRangeDto) {
    const lots = await this.prisma.lot.findMany({
      where: { businessId, remainingBoxes: { gt: 0 } },
      include: {
        product: { select: { name: true } },
        supplier: { select: { name: true } },
      },
      orderBy: { receivedDate: 'desc' },
      take: 200,
    });

    const totalValue = lots.reduce(
      (sum, l) => sumDecimal(sum, toDecimal(l.costPerBox).times(l.remainingBoxes)).toNumber(), 0
    );

    return {
      totalValue: totalValue.toString(),
      totalLots: lots.length,
      data: lots.map(l => ({
        lotId: l.id,
        lotReference: l.lotReference,
        productName: l.product?.name || 'Unknown',
        supplierName: l.supplier?.name || 'Unknown',
        receivedDate: l.receivedDate,
        totalBoxes: l.totalBoxes,
        remainingBoxes: l.remainingBoxes,
        costPerBox: l.costPerBox.toString(),
        value: toMoneyString(toDecimal(l.costPerBox).times(l.remainingBoxes)),
        quality: l.quality,
        freshnessStatus: l.freshnessStatus,
        freshnessScore: l.freshnessScore.toString(),
        status: l.status,
      })),
    };
  }

  /**
   * Phase 8: this previously returned { atRiskValue, atRiskLotCount, data: [...] }
   * with per-lot fields (remainingBoxes, freshnessScore, ...) — but
   * freshness/page.tsx expects { summary: {...5 value buckets}, items: [...] }
   * with entirely different field names (quantity, qualityPct, ageDays,
   * riskValue...). Array.isArray(data.items) was always false against the
   * old shape, so the page silently showed all-zero metrics and "no items"
   * regardless of actual data — this is a real rewrite, not a rename.
   *
   * Reuses FreshnessService.getAllLotsFreshness (Phase 7) rather than
   * re-deriving lot freshness here — same live score/status/priceMultiplier
   * computation the dashboard's at-risk-stock figure already uses.
   *
   * FreshnessProfile.status is free text the business configures per
   * product (not a fixed enum — Lot.freshnessStatus is a plain String
   * column), so bucketing by that label isn't reliable across businesses.
   * Bucketing by score instead, consistent with the two thresholds
   * FreshnessService.getAtRiskStock() already established (score < 70 is
   * "at risk", score < 50 is the most urgent / CLEAR_TODAY tier) — the
   * three-way split below (80/65/50/30) is a new, explicit convention
   * documented here rather than invented silently, filling in between
   * those two existing anchor points.
   */
  async getFreshness(businessId: string, _q: DateRangeDto) {
    const lots = await this.freshnessService.getAllLotsFreshness(businessId);
    const now = new Date();

    const buckets = { fresh: toDecimal(0), attention: toDecimal(0), markdown: toDecimal(0), highRisk: toDecimal(0), expectedWaste: toDecimal(0) };
    let totalValue = toDecimal(0);
    let erosionValue = toDecimal(0);
    const items: any[] = [];

    for (const lot of lots) {
      if (!lot.remainingBoxes || lot.remainingBoxes <= 0) continue;

      const value = toDecimal(lot.costPerBox).times(lot.remainingBoxes);
      const score = lot.freshness.score;
      const priceMultiplier = lot.freshness.priceMultiplier ?? 1;
      const riskValue = value.times(Math.max(0, 1 - priceMultiplier));
      const ageDays = lot.receivedDate
        ? Math.floor((now.getTime() - new Date(lot.receivedDate).getTime()) / 86400000)
        : 0;

      totalValue = totalValue.plus(value);

      let bucket: keyof typeof buckets;
      let status: string;
      if (score >= 80) { bucket = 'fresh'; status = 'fresh'; }
      else if (score >= 65) { bucket = 'attention'; status = 'watch'; }
      else if (score >= 50) { bucket = 'markdown'; status = 'markdown'; }
      else if (score >= 30) { bucket = 'highRisk'; status = 'urgent'; }
      else { bucket = 'expectedWaste'; status = 'likely_loss'; }

      buckets[bucket] = buckets[bucket].plus(value);
      if (bucket !== 'fresh') {
        erosionValue = erosionValue.plus(riskValue);
        items.push({
          lotId: lot.id,
          productName: lot.product?.name || 'Unknown product',
          quantity: lot.remainingBoxes,
          unit: 'BOX',
          ageDays,
          qualityPct: Math.round(score),
          value: toMoneyString(value),
          riskValue: toMoneyString(riskValue),
          status,
        });
      }
    }

    items.sort((a, b) => a.qualityPct - b.qualityPct);

    return {
      summary: {
        freshStockValue: toMoneyString(buckets.fresh),
        attentionValue: toMoneyString(buckets.attention),
        markdownValue: toMoneyString(buckets.markdown),
        highRiskValue: toMoneyString(buckets.highRisk),
        expectedWasteValue: toMoneyString(buckets.expectedWaste),
        totalValue: toMoneyString(totalValue),
        erosionValue: toMoneyString(erosionValue),
      },
      items,
    };
  }

  async getWastage(businessId: string, q: DateRangeDto) {
    const dateFilter = this.dateRange(q);
    const [aggr, movements] = await Promise.all([
      this.prisma.inventoryMovement.aggregate({
        where: { businessId, movementType: 'WASTAGE', businessDate: dateFilter },
        _sum: { totalCost: true, quantityBoxes: true },
      }),
      this.prisma.inventoryMovement.findMany({
        where: { businessId, movementType: 'WASTAGE', businessDate: dateFilter },
        include: {
          product: { select: { name: true } },
          lot: { select: { lotReference: true } },
        },
        orderBy: { businessDate: 'desc' },
        take: 200,
      }),
    ]);

    return {
      totalWastageValue: (aggr._sum.totalCost || 0).toString(),
      totalWastedBoxes: Math.abs(aggr._sum.quantityBoxes || 0),
      data: movements.map(m => ({
        id: m.id,
        date: m.businessDate,
        productName: m.product?.name || 'Unknown',
        lotReference: m.lot?.lotReference || 'Unknown',
        boxes: Math.abs(m.quantityBoxes),
        costPerUnit: m.costPerUnit.toString(),
        totalCost: m.totalCost.toString(),
        notes: m.notes,
      })),
    };
  }

  async getMargins(businessId: string, q: DateRangeDto) {
    const dateFilter = this.dateRange(q);

    // Per-product margin from sale items
    const productGroups = await this.prisma.saleItem.groupBy({
      by: ['productId'],
      where: { sale: { businessId, businessDate: dateFilter } },
      _sum: { total: true, cogs: true, grossProfit: true, quantity: true },
    });

    const productIds = productGroups.map(p => p.productId);
    const products = productIds.length > 0
      ? await this.prisma.product.findMany({ where: { id: { in: productIds } }, select: { id: true, name: true } })
      : [];
    const productMap = new Map(products.map(p => [p.id, p.name]));

    const totalRev = productGroups.reduce((s, p) => s + Number(p._sum.total || 0), 0);
    const totalProfit = productGroups.reduce((s, p) => s + Number(p._sum.grossProfit || 0), 0);
    const avgMargin = totalRev > 0 ? (totalProfit / totalRev) * 100 : 0;

    return {
      avgMargin: avgMargin.toFixed(2),
      data: productGroups.map(pg => ({
        productId: pg.productId,
        productName: productMap.get(pg.productId) || 'Unknown',
        unitsSold: Number(pg._sum.quantity || 0),
        revenue: (pg._sum.total || 0).toString(),
        cogs: (pg._sum.cogs || 0).toString(),
        grossProfit: (pg._sum.grossProfit || 0).toString(),
        marginPct: Number(pg._sum.total || 0) > 0
          ? ((Number(pg._sum.grossProfit || 0) / Number(pg._sum.total || 1)) * 100).toFixed(2)
          : '0.00',
      })),
    };
  }
}

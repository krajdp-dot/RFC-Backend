import { Injectable } from '@nestjs/common';
import { Decimal } from 'decimal.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FreshnessService } from '../freshness/freshness.service.js';
import { ReceivablesService } from '../receivables/receivables.service.js';
import { PayablesService } from '../payables/payables.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { toDecimal, sumDecimal, divDecimal, calcPercentage, toMoneyString } from '../../common/utils/money.util.js';
import { getBusinessDate, getAgeDays, formatBusinessDate } from '../../common/utils/date.util.js';

/**
 * Phase 13 — every threshold this module needs that Phase 1-12 doesn't
 * already define somewhere, gathered in one place (spec section 33: "no
 * hardcoded business thresholds without justification... make it
 * explicit, document it, keep it configurable"). None of these override
 * or duplicate an existing threshold:
 *
 *  - Freshness risk reuses reports.service.ts's getFreshness() bands
 *    (80/65/50/30) and their status labels exactly — see
 *    getFreshnessRisk() below. Nothing new is invented there.
 *  - Product.reorderThreshold/reorderQty (an existing *box-count*
 *    signal behind the dashboard's existing reorder-recommendation
 *    feature) is a different metric from the *days-of-coverage* signal
 *    below and is deliberately left untouched.
 *
 * Every number below is a starting point for a small wholesale
 * business, not a business rule RFC has configured anywhere — see
 * PHASE-13-REPORT.md, "Data sufficiency and thresholds", which says so
 * plainly rather than presenting these as backend-derived facts.
 */
export const INTELLIGENCE_THRESHOLDS = {
  /** Trailing window used for every "recent" comparison below. */
  TREND_WINDOW_DAYS: 30,
  /** Distinct days of qualifying history within the window before a
   *  figure is labelled VERIFIED. Below this but above zero: LIMITED.
   *  Zero qualifying days: INSUFFICIENT. */
  MIN_SALE_DAYS_FOR_VERIFIED: 14,
  MIN_SALE_DAYS_FOR_LIMITED: 3,
  /** Stock coverage, in days, at the recent sales pace. */
  LOW_STOCK_COVERAGE_DAYS: 3,
  OVERSTOCK_COVERAGE_DAYS: 14,
  /** Share of total receivables/purchases sitting with the top few
   *  counterparties before concentration is worth naming. */
  CONCENTRATION_WATCH_PCT: 50,
  CONCENTRATION_ATTENTION_PCT: 65,
  CONCENTRATION_TOP_N: 5,
  /** A period-over-period revenue/expense move smaller than this is
   *  ordinary noise for a small wholesale book, not a signal. */
  MATERIAL_CHANGE_PCT: 15,
  /** A gross-margin move smaller than this many percentage points is
   *  not flagged — a different scale from MATERIAL_CHANGE_PCT above,
   *  which is a relative (%) move, not a percentage-point move. */
  MARGIN_POINT_DROP_WATCH: 3,
  /** A wastage-rate move smaller than this many percentage points is
   *  not flagged (spec's own worked example, 1.8% -> 3.1%, is a 1.3pt
   *  move and would clear this). */
  WASTAGE_RATE_WATCH_POINTS: 1,
  /** A day-close cash difference under this is handling/rounding
   *  slack, not a reconciliation problem worth surfacing. */
  CASH_DIFF_NOISE_RUPEES: 50,
  /** How many of the most recent day-closes to look at for a
   *  recurring-difference signal. */
  RECENT_DAY_CLOSES_WINDOW: 14,
  /** Purchase count within the window before supplier concentration is
   *  labelled VERIFIED / LIMITED, same idea as MIN_SALE_DAYS_* but for
   *  purchases, which are naturally much less frequent than sales. */
  MIN_PURCHASES_FOR_VERIFIED: 6,
  MIN_PURCHASES_FOR_LIMITED: 2,
} as const;

export type Sufficiency = 'VERIFIED' | 'LIMITED' | 'INSUFFICIENT';

export interface DataBasis {
  sufficiency: Sufficiency;
  explanation: string;
}

export type Tier = 'ATTENTION' | 'WATCH' | 'HEALTHY';

export interface BriefSignal {
  id: string;
  type: string;
  tier: Tier;
  title: string;
  detail: string;
  href: string;
  basis: DataBasis;
}

@Injectable()
export class IntelligenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
    private readonly receivablesService: ReceivablesService,
    private readonly payablesService: PayablesService,
    private readonly expensesService: ExpensesService,
    private readonly reconciliationService: ReconciliationService,
  ) {}

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  /** Midnight N days before `from` (business timezone) — same shape as
   * the daysAgo() helper every *.service.spec.ts in this repo already
   * uses, so tests seeded "N days ago" line up with what this code
   * actually queries. */
  private daysBefore(days: number, from: Date = getBusinessDate()): Date {
    return new Date(from.getTime() - days * 24 * 60 * 60 * 1000);
  }

  /** A clean, non-overlapping pair of `days`-long windows ending today:
   * current = [today-(days-1), today], previous = the `days` immediately
   * before that. Both ends are inclusive everywhere this is used, so
   * every query below uses gte/lte consistently (never a mixed gte/lt). */
  private trendWindows(days: number = INTELLIGENCE_THRESHOLDS.TREND_WINDOW_DAYS) {
    const now = getBusinessDate();
    return {
      days,
      currentStart: this.daysBefore(days - 1, now),
      currentEnd: now,
      previousStart: this.daysBefore(days * 2 - 1, now),
      previousEnd: this.daysBefore(days, now),
    };
  }

  /** Section 19/20 — data sufficiency from a plain count of qualifying
   * days/records, never a mysterious confidence score. Every insight
   * that depends on history calls this and carries the result with it. */
  private sufficiencyFromCount(count: number, verifiedAt: number, limitedAt: number, basisLabel: string): DataBasis {
    if (count >= verifiedAt) return { sufficiency: 'VERIFIED', explanation: `Based on ${basisLabel}.` };
    if (count >= limitedAt) return { sufficiency: 'LIMITED', explanation: `Based on limited recent history (${basisLabel}).` };
    return { sufficiency: 'INSUFFICIENT', explanation: `Not enough data yet \u2014 ${basisLabel}.` };
  }

  /** Percentage change, or null when the previous period is zero — a
   * change against zero is not a real percentage (not "infinite
   * growth"), so every caller must handle null as "not comparable"
   * rather than a number. */
  private pctChange(current: Decimal, previous: Decimal): number | null {
    if (previous.isZero()) return null;
    return current.minus(previous).dividedBy(previous).times(100).toDecimalPlaces(1).toNumber();
  }

  private async earliestBusinessDate(businessId: string, model: 'sale' | 'purchase' | 'expense' | 'inventoryMovement'): Promise<Date | null> {
    const row = await (this.prisma as any)[model].findFirst({ where: { businessId }, orderBy: { businessDate: 'asc' } });
    return row ? row.businessDate : null;
  }

  // ---------------------------------------------------------------------
  // Section 5 — Freshness intelligence
  // ---------------------------------------------------------------------

  /** Reuses freshnessService.getAllLotsFreshness() — the exact data
   * reports.service.ts's getFreshness() is built on — and its 80/65/50/30
   * bands, so this list is never out of step with what the Freshness
   * page already shows. Adds lot reference, received date and supplier
   * (not present on getFreshness()'s output) because section 5 asks for
   * them by name, plus one honest gap check: a product with zero
   * configured FreshnessProfile rows silently scores 100/FRESH from
   * calculateFreshness()'s own fallback, which would hide real risk
   * rather than flag it. */
  async getFreshnessRisk(businessId: string) {
    const [lots, suppliers] = await Promise.all([
      this.freshnessService.getAllLotsFreshness(businessId),
      this.prisma.supplier.findMany({ where: { businessId } }),
    ]);
    const supplierById = new Map(suppliers.map((s: any) => [s.id, s.name]));
    const productById = new Map(lots.map((l: any) => [l.productId, l.product]));

    const items = lots
      .filter((l: any) => l.remainingBoxes > 0 && l.freshness.score < 80)
      .map((l: any) => {
        const score = l.freshness.score;
        let status: string;
        if (score >= 65) status = 'watch';
        else if (score >= 50) status = 'markdown';
        else if (score >= 30) status = 'urgent';
        else status = 'likely_loss';

        const value = toDecimal(l.costPerBox).times(l.remainingBoxes);
        return {
          lotId: l.id,
          lotReference: l.lotReference,
          productId: l.productId,
          productName: l.product?.name || 'Unknown product',
          remainingBoxes: l.remainingBoxes,
          ageDays: l.receivedDate ? getAgeDays(l.receivedDate) : null,
          receivedDate: l.receivedDate,
          supplierName: l.supplierId ? supplierById.get(l.supplierId) || null : null,
          freshnessScore: Math.round(score),
          status,
          value: toMoneyString(value),
        };
      })
      .sort((a, b) => a.freshnessScore - b.freshnessScore);

    const signals: BriefSignal[] = items.slice(0, INTELLIGENCE_THRESHOLDS.CONCENTRATION_TOP_N).map((it) => ({
      id: `freshness-${it.lotId}`,
      type: 'FRESHNESS_RISK',
      tier: (it.status === 'urgent' || it.status === 'likely_loss' ? 'ATTENTION' : 'WATCH') as Tier,
      title: `${it.productName}: ${it.remainingBoxes} box${it.remainingBoxes === 1 ? '' : 'es'} at ${it.freshnessScore}% freshness`,
      detail: `Lot ${it.lotReference}, received ${it.ageDays ?? '?'} day${it.ageDays === 1 ? '' : 's'} ago${it.supplierName ? ` from ${it.supplierName}` : ''}. Approximately \u20b9${it.value} at risk.`,
      href: '/freshness',
      basis: { sufficiency: 'VERIFIED' as Sufficiency, explanation: 'Based on this product\u2019s configured freshness profile.' },
    }));

    // Honest gap check — see method doc comment above.
    const productIdsWithStock = new Set(lots.filter((l: any) => l.remainingBoxes > 0).map((l: any) => l.productId));
    if (productIdsWithStock.size > 0) {
      const profiles = await this.prisma.freshnessProfile.findMany({ where: { productId: { in: [...productIdsWithStock] } } });
      const configuredIds = new Set(profiles.map((p: any) => p.productId));
      const unconfigured = [...productIdsWithStock]
        .filter((id) => !configuredIds.has(id))
        .map((id) => productById.get(id)?.name)
        .filter((name): name is string => Boolean(name));
      if (unconfigured.length > 0) {
        signals.push({
          id: 'freshness-unconfigured',
          type: 'FRESHNESS_NOT_CONFIGURED',
          tier: 'WATCH',
          title: `${unconfigured.length} product${unconfigured.length === 1 ? '' : 's'} ha${unconfigured.length === 1 ? 's' : 've'} no freshness profile configured`,
          detail: `${unconfigured.join(', ')} \u2014 freshness risk can\u2019t be assessed for these until a profile is set up; they show as fresh by default.`,
          href: '/settings',
          basis: { sufficiency: 'VERIFIED', explanation: 'Based on which products currently have a configured freshness profile.' },
        });
      }
    }

    return {
      items,
      signals,
      basis: { sufficiency: 'VERIFIED' as Sufficiency, explanation: 'Based on current lot freshness scores.' },
    };
  }

  // ---------------------------------------------------------------------
  // Sections 6, 7, 15 — Stock velocity, coverage, and overstock/understock
  // ---------------------------------------------------------------------

  /** Recent sale velocity per product (box-unit sale lines only — a
   * product sold only by weight is reported INSUFFICIENT here rather
   * than a wrong box number, per section 15's "never silently convert
   * units"), remaining stock, and the estimated days of coverage that
   * implies. Labelled "Demand signal" / "Estimated stock coverage"
   * throughout in the frontend copy, never "reorder" — this is a
   * different metric from the existing box-threshold reorder feature
   * (Product.reorderThreshold/reorderQty), which this method does not
   * read or write. */
  async getStockSignals(businessId: string) {
    const windows = this.trendWindows();

    const [activeLots, products, salesInWindow] = await Promise.all([
      this.prisma.lot.findMany({ where: { businessId, status: 'ACTIVE' } }),
      this.prisma.product.findMany({ where: { businessId, active: true } }),
      this.prisma.sale.findMany({ where: { businessId, businessDate: { gte: windows.currentStart, lte: windows.currentEnd } } }),
    ]);

    const saleIds = salesInWindow.map((s) => s.id);
    const saleDateById = new Map(salesInWindow.map((s) => [s.id, s.businessDate]));
    const items = saleIds.length > 0
      ? await this.prisma.saleItem.findMany({ where: { saleId: { in: saleIds }, unit: 'BOX' } })
      : [];

    const qtyByProduct = new Map<string, Decimal>();
    const saleDaysByProduct = new Map<string, Set<string>>();
    for (const item of items) {
      qtyByProduct.set(item.productId, sumDecimal(qtyByProduct.get(item.productId) ?? 0, item.quantity));
      const saleDate = saleDateById.get(item.saleId);
      if (saleDate) {
        const dayKey = formatBusinessDate(saleDate);
        if (!saleDaysByProduct.has(item.productId)) saleDaysByProduct.set(item.productId, new Set());
        saleDaysByProduct.get(item.productId)!.add(dayKey);
      }
    }

    const remainingByProduct = new Map<string, number>();
    for (const lot of activeLots) {
      remainingByProduct.set(lot.productId, (remainingByProduct.get(lot.productId) ?? 0) + lot.remainingBoxes);
    }

    const productById = new Map(products.map((p) => [p.id, p]));
    const relevantProductIds = new Set<string>([...remainingByProduct.keys(), ...qtyByProduct.keys()]);

    const resultItems: any[] = [];
    for (const productId of relevantProductIds) {
      const product = productById.get(productId);
      if (!product) continue; // inactive/deleted product — nothing actionable to show

      const remainingBoxes = remainingByProduct.get(productId) ?? 0;
      const soldBoxes = qtyByProduct.get(productId) ?? toDecimal(0);
      const saleDayCount = saleDaysByProduct.get(productId)?.size ?? 0;
      const velocityPerDay = divDecimal(soldBoxes, windows.days);

      const basis = this.sufficiencyFromCount(
        saleDayCount,
        INTELLIGENCE_THRESHOLDS.MIN_SALE_DAYS_FOR_VERIFIED,
        INTELLIGENCE_THRESHOLDS.MIN_SALE_DAYS_FOR_LIMITED,
        `${saleDayCount} day${saleDayCount === 1 ? '' : 's'} with box sales in the last ${windows.days}`,
      );

      // Division-by-zero guard is deliberate and explicit, not just
      // divDecimal's built-in "0 on zero divisor": 0 recent sales means
      // coverage is unknowable, not "0 days of supply" — those are
      // different claims, and only the first is honest here.
      let coverageDays: number | null = null;
      let signal: 'LOW_STOCK' | 'OVERSTOCK' | 'BALANCED' | null = null;
      // .gt(0), not .isPositive() — decimal.js's isPositive() is a sign
      // check and treats 0 as positive, which would silently turn "no
      // recent sales" into a fabricated "0 days of coverage" below.
      if (basis.sufficiency !== 'INSUFFICIENT' && velocityPerDay.gt(0)) {
        coverageDays = divDecimal(remainingBoxes, velocityPerDay).toDecimalPlaces(1).toNumber();
        if (coverageDays < INTELLIGENCE_THRESHOLDS.LOW_STOCK_COVERAGE_DAYS) signal = 'LOW_STOCK';
        else if (coverageDays > INTELLIGENCE_THRESHOLDS.OVERSTOCK_COVERAGE_DAYS) signal = 'OVERSTOCK';
        else signal = 'BALANCED';
      }

      resultItems.push({
        productId,
        productName: product.name,
        remainingBoxes,
        velocityPerDay: velocityPerDay.toDecimalPlaces(2).toNumber(),
        soldBoxesInWindow: soldBoxes.toDecimalPlaces(0).toNumber(),
        coverageDays,
        signal,
        basis,
      });
    }
    resultItems.sort((a, b) => (a.coverageDays ?? Infinity) - (b.coverageDays ?? Infinity));

    const signals: BriefSignal[] = [];
    for (const it of resultItems) {
      if (it.signal === 'LOW_STOCK') {
        signals.push({
          id: `stock-low-${it.productId}`,
          type: 'LOW_STOCK',
          tier: 'ATTENTION',
          title: `${it.productName} stock covers about ${it.coverageDays} day${it.coverageDays === 1 ? '' : 's'} at the recent pace`,
          detail: `${it.remainingBoxes} box${it.remainingBoxes === 1 ? '' : 'es'} remaining, moving at approximately ${it.velocityPerDay} box/day over the last ${windows.days} days. Estimated stock coverage, not a formal reorder recommendation.`,
          href: '/inventory',
          basis: it.basis,
        });
      } else if (it.signal === 'OVERSTOCK') {
        signals.push({
          id: `stock-over-${it.productId}`,
          type: 'SLOW_STOCK',
          tier: 'WATCH',
          title: `${it.productName} stock represents about ${it.coverageDays} days of supply`,
          detail: `${it.remainingBoxes} box${it.remainingBoxes === 1 ? '' : 'es'} remaining against a recent pace of approximately ${it.velocityPerDay} box/day \u2014 well above typical turnover. Demand signal, worth checking before buying more.`,
          href: '/inventory',
          basis: it.basis,
        });
      }
    }

    return { items: resultItems, signals };
  }

  // ---------------------------------------------------------------------
  // Sections 8, 9 — Margin intelligence and leakage
  // ---------------------------------------------------------------------

  /** Margin from Sale/SaleItem's own cogs/grossProfit fields — the
   * lot-based FEFO/FIFO cost already applied at sale time — never
   * recomputed from purchase price, per section 8. Uses the same
   * businessId+businessDate query shape as reports.service.ts's
   * getSales() (no status filter), so this figure always agrees with
   * what the Reports page already shows for the same range. Leakage
   * language stays factual (price fell / cost rose), never attributes a
   * cause the data doesn't support, per section 9. */
  async getMarginIntelligence(businessId: string) {
    const windows = this.trendWindows();

    const [currentSales, previousAggr, earliest] = await Promise.all([
      this.prisma.sale.findMany({ where: { businessId, businessDate: { gte: windows.currentStart, lte: windows.currentEnd } } }),
      this.prisma.sale.aggregate({
        where: { businessId, businessDate: { gte: windows.previousStart, lte: windows.previousEnd } },
        _sum: { total: true, cogs: true, grossProfit: true },
      }),
      this.earliestBusinessDate(businessId, 'sale'),
    ]);

    const currentRevenue = sumDecimal(...currentSales.map((s) => s.total));
    const currentCogs = sumDecimal(...currentSales.map((s) => s.cogs));
    const currentProfit = sumDecimal(...currentSales.map((s) => s.grossProfit));
    const currentMarginPct = calcPercentage(currentProfit, currentRevenue);

    const previousRevenue = toDecimal(previousAggr._sum.total);
    const previousCogs = toDecimal(previousAggr._sum.cogs);
    const previousProfit = toDecimal(previousAggr._sum.grossProfit);
    const previousMarginPct = calcPercentage(previousProfit, previousRevenue);

    const marginPtChange = previousRevenue.isZero()
      ? null
      : currentMarginPct.minus(previousMarginPct).toDecimalPlaces(1).toNumber();

    const historyDays = earliest ? getAgeDays(earliest) : 0;
    const basis = this.sufficiencyFromCount(historyDays, windows.days, INTELLIGENCE_THRESHOLDS.MIN_SALE_DAYS_FOR_LIMITED, `${historyDays} days of sales history`);

    // Per-product breakdown — flat queries + in-memory grouping, not
    // saleItem.groupBy() with a relational `where: { sale: { ... } }`
    // filter the way reports.service.ts's getMargins() does it: real
    // Postgres resolves both fine, but this repo's FakePrismaService
    // test double implements neither, so neither is used here (see
    // test-utils/fake-prisma.util.ts).
    const currentSaleIds = currentSales.map((s) => s.id);
    const currentItems = currentSaleIds.length > 0
      ? await this.prisma.saleItem.findMany({ where: { saleId: { in: currentSaleIds } } })
      : [];

    const productAgg = new Map<string, { revenue: Decimal; cogs: Decimal; profit: Decimal; qty: Decimal }>();
    for (const item of currentItems) {
      const cur = productAgg.get(item.productId) ?? { revenue: toDecimal(0), cogs: toDecimal(0), profit: toDecimal(0), qty: toDecimal(0) };
      cur.revenue = cur.revenue.plus(toDecimal(item.total));
      cur.cogs = cur.cogs.plus(toDecimal(item.cogs));
      cur.profit = cur.profit.plus(toDecimal(item.grossProfit));
      cur.qty = cur.qty.plus(toDecimal(item.quantity));
      productAgg.set(item.productId, cur);
    }
    const productIds = [...productAgg.keys()];
    const products = productIds.length > 0 ? await this.prisma.product.findMany({ where: { id: { in: productIds } } }) : [];
    const productNameById = new Map(products.map((p) => [p.id, p.name]));

    const byProduct = [...productAgg.entries()]
      .map(([productId, agg]) => ({
        productId,
        productName: productNameById.get(productId) || 'Unknown product',
        revenue: toMoneyString(agg.revenue),
        grossProfit: toMoneyString(agg.profit),
        marginPct: calcPercentage(agg.profit, agg.revenue).toNumber(),
        avgSellingPricePerUnit: divDecimal(agg.revenue, agg.qty).toDecimalPlaces(2).toNumber(),
        avgCostPerUnit: divDecimal(agg.cogs, agg.qty).toDecimalPlaces(2).toNumber(),
      }))
      .sort((a, b) => a.marginPct - b.marginPct);

    const signals: BriefSignal[] = [];
    if (basis.sufficiency !== 'INSUFFICIENT' && marginPtChange !== null && marginPtChange <= -INTELLIGENCE_THRESHOLDS.MARGIN_POINT_DROP_WATCH) {
      // Section 9: name what moved, never a cause the data doesn't
      // support — the lowest-margin product this period, factually,
      // not "why" it's low.
      const explanationParts: string[] = [];
      const worstProduct = byProduct[0];
      if (worstProduct) {
        explanationParts.push(`${worstProduct.productName} has the lowest margin this period at ${worstProduct.marginPct.toFixed(1)}%.`);
      }
      signals.push({
        id: 'margin-drop',
        type: 'MARGIN_DROP',
        tier: 'WATCH',
        title: `Gross margin is down ${Math.abs(marginPtChange).toFixed(1)} points, ${previousMarginPct.toFixed(1)}% to ${currentMarginPct.toFixed(1)}%`,
        detail: `Last ${windows.days} days: \u20b9${toMoneyString(currentProfit)} gross profit on \u20b9${toMoneyString(currentRevenue)} revenue. Previous ${windows.days} days: \u20b9${toMoneyString(previousProfit)} on \u20b9${toMoneyString(previousRevenue)}. ${explanationParts.join(' ')}`.trim(),
        href: '/reports',
        basis,
      });
    }

    return {
      currentPeriod: { label: `Last ${windows.days} days`, revenue: toMoneyString(currentRevenue), cogs: toMoneyString(currentCogs), grossProfit: toMoneyString(currentProfit), marginPct: currentMarginPct.toNumber() },
      previousPeriod: { label: `Previous ${windows.days} days`, revenue: toMoneyString(previousRevenue), cogs: toMoneyString(previousCogs), grossProfit: toMoneyString(previousProfit), marginPct: previousMarginPct.toNumber() },
      marginPtChange,
      byProduct,
      signals,
      basis,
    };
  }

  // ---------------------------------------------------------------------
  // Sections 10, 11 — Customer collection risk and receivable concentration
  // ---------------------------------------------------------------------

  /** Reuses ReceivablesService directly (spec section 10: "reuse
   * them") — both the per-customer outstanding/overdue list and the
   * business-wide aging buckets. getReceivablesSummary() already
   * returns `overdue` per customer (aged past *that customer's own*
   * credit terms), which is exactly section 10's worked example, so no
   * second aging pass is built here. */
  async getCollectionIntelligence(businessId: string) {
    const [summary, aging] = await Promise.all([
      this.receivablesService.getReceivablesSummary(businessId),
      this.receivablesService.getAgingAnalysis(businessId),
    ]);

    const totalOutstanding = sumDecimal(...summary.map((c: any) => c.outstanding));
    const topN = summary.slice(0, INTELLIGENCE_THRESHOLDS.CONCENTRATION_TOP_N);
    const topNOutstanding = sumDecimal(...topN.map((c: any) => c.outstanding));
    const concentrationPct = totalOutstanding.isZero() ? null : calcPercentage(topNOutstanding, totalOutstanding).toNumber();

    const signals: BriefSignal[] = [];

    // .gt(0): decimal.js's isPositive() is true for exactly 0 too, which
    // would raise an "overdue" signal reading "₹0.00 overdue" for a
    // business with no receivables at all.
    if (toDecimal(aging.overdue).gt(0)) {
      signals.push({
        id: 'receivables-overdue',
        type: 'OVERDUE_RECEIVABLE',
        tier: 'ATTENTION',
        title: `\u20b9${aging.overdue} overdue across ${aging.overdueCount} customer${aging.overdueCount === 1 ? '' : 's'}`,
        detail: `Out of \u20b9${aging.total} total outstanding, \u20b9${aging.overdue} is already past the customer\u2019s own credit terms.`,
        href: '/receivables',
        basis: { sufficiency: 'VERIFIED', explanation: 'Based on recorded credit sales and each customer\u2019s configured credit terms.' },
      });
    }

    if (concentrationPct !== null && topN.length > 0 && concentrationPct >= INTELLIGENCE_THRESHOLDS.CONCENTRATION_WATCH_PCT) {
      const tier: Tier = concentrationPct >= INTELLIGENCE_THRESHOLDS.CONCENTRATION_ATTENTION_PCT ? 'ATTENTION' : 'WATCH';
      signals.push({
        id: 'receivables-concentration',
        type: 'RECEIVABLE_CONCENTRATION',
        tier,
        title: `Top ${topN.length} customer${topN.length === 1 ? '' : 's'} represent ${concentrationPct.toFixed(0)}% of outstanding receivables`,
        detail: `\u20b9${toMoneyString(topNOutstanding)} of \u20b9${toMoneyString(totalOutstanding)} total outstanding is concentrated in: ${topN.map((c: any) => c.name).join(', ')}.`,
        href: '/receivables',
        basis: { sufficiency: 'VERIFIED', explanation: `Based on ${summary.length} customer${summary.length === 1 ? '' : 's'} with an outstanding balance.` },
      });
    }

    return {
      totalOutstanding: toMoneyString(totalOutstanding),
      aging,
      topCustomers: topN,
      concentrationPct,
      signals,
    };
  }

  // ---------------------------------------------------------------------
  // Section 12 — Supplier intelligence (purchase concentration)
  // ---------------------------------------------------------------------

  /** No existing endpoint aggregates purchases by supplier over a
   * period, so this is a genuinely new calculation (backend-first rule:
   * missing, so built in the backend, not faked in the frontend).
   * Landed cost, not subtotal, is the purchase value, matching this
   * app's landed-cost architecture. No supplier ranking or quality
   * inference — section 12 rules that out without a defined,
   * transparent metric, and none exists. Also folds in overdue
   * payables from PayablesService (reused, not recomputed) — the
   * supplier-side mirror of section 10/11's receivable risk, using the
   * exact same aging logic PayablesService already provides. */
  async getSupplierIntelligence(businessId: string) {
    const windows = this.trendWindows();
    const [purchases, suppliers, payablesAging] = await Promise.all([
      this.prisma.purchase.findMany({ where: { businessId, businessDate: { gte: windows.currentStart, lte: windows.currentEnd } } }),
      this.prisma.supplier.findMany({ where: { businessId } }),
      this.payablesService.getAgingAnalysis(businessId),
    ]);
    const supplierById = new Map(suppliers.map((s) => [s.id, s.name]));

    const bySupplier = new Map<string, Decimal>();
    for (const p of purchases) {
      bySupplier.set(p.supplierId, sumDecimal(bySupplier.get(p.supplierId) ?? 0, p.landedCost));
    }
    const total = sumDecimal(...[...bySupplier.values()]);
    const ranked = [...bySupplier.entries()]
      .map(([supplierId, amount]) => ({
        supplierId,
        supplierName: supplierById.get(supplierId) || 'Unknown supplier',
        amount: toMoneyString(amount),
        pct: total.isZero() ? 0 : calcPercentage(amount, total).toNumber(),
      }))
      .sort((a, b) => b.pct - a.pct);

    const basis = this.sufficiencyFromCount(
      purchases.length,
      INTELLIGENCE_THRESHOLDS.MIN_PURCHASES_FOR_VERIFIED,
      INTELLIGENCE_THRESHOLDS.MIN_PURCHASES_FOR_LIMITED,
      `${purchases.length} purchase${purchases.length === 1 ? '' : 's'} in the last ${windows.days} days`,
    );

    const signals: BriefSignal[] = [];
    const topFew = ranked.slice(0, 2).filter((r) => r.pct > 0);
    const combinedPct = topFew.reduce((s, r) => s + r.pct, 0);
    if (basis.sufficiency !== 'INSUFFICIENT' && combinedPct >= INTELLIGENCE_THRESHOLDS.CONCENTRATION_WATCH_PCT) {
      const tier: Tier = combinedPct >= INTELLIGENCE_THRESHOLDS.CONCENTRATION_ATTENTION_PCT ? 'ATTENTION' : 'WATCH';
      signals.push({
        id: 'supplier-concentration',
        type: 'SUPPLIER_CONCENTRATION',
        tier,
        title: `${topFew.length === 1 ? topFew[0].supplierName : `${topFew.length} suppliers`} account${topFew.length === 1 ? 's' : ''} for ${combinedPct.toFixed(0)}% of recent purchases`,
        detail: `Last ${windows.days} days: ${topFew.map((r) => `${r.supplierName} (${r.pct.toFixed(0)}%)`).join(', ')} of \u20b9${toMoneyString(total)} total purchases.`,
        href: '/suppliers',
        basis,
      });
    }

    // Same .gt(0) fix as getCollectionIntelligence above.
    if (toDecimal(payablesAging.overdue).gt(0)) {
      signals.push({
        id: 'payables-overdue',
        type: 'OVERDUE_PAYABLE',
        tier: 'ATTENTION',
        title: `\u20b9${payablesAging.overdue} owed to suppliers is overdue`,
        detail: `Out of \u20b9${payablesAging.total} total payable, \u20b9${payablesAging.overdue} is past the agreed payment terms.`,
        href: '/payables',
        basis: { sufficiency: 'VERIFIED', explanation: 'Based on recorded credit purchases and each supplier\u2019s configured payment terms.' },
      });
    }

    return { totalPurchaseValue: toMoneyString(total), bySupplier: ranked, payablesAging, basis, signals };
  }

  // ---------------------------------------------------------------------
  // Section 13 — Wastage intelligence
  // ---------------------------------------------------------------------

  /** Wastage rate = wasted boxes / received boxes, current vs previous
   * window, comparing only equivalent periods and units. Reuses the
   * same InventoryMovement WASTAGE rows reports.service.ts's
   * getWastage() sums for its value figure; adds the received-quantity
   * denominator (PURCHASE movement rows) because a rate needs one and
   * getWastage() doesn't compute a rate. */
  async getWastageIntelligence(businessId: string) {
    const windows = this.trendWindows();
    const currRange = { gte: windows.currentStart, lte: windows.currentEnd };
    const prevRange = { gte: windows.previousStart, lte: windows.previousEnd };

    const [currentWaste, previousWaste, currentReceived, previousReceived] = await Promise.all([
      this.prisma.inventoryMovement.aggregate({ where: { businessId, movementType: 'WASTAGE', businessDate: currRange }, _sum: { totalCost: true, quantityBoxes: true } }),
      this.prisma.inventoryMovement.aggregate({ where: { businessId, movementType: 'WASTAGE', businessDate: prevRange }, _sum: { totalCost: true, quantityBoxes: true } }),
      this.prisma.inventoryMovement.aggregate({ where: { businessId, movementType: 'PURCHASE', businessDate: currRange }, _sum: { quantityBoxes: true } }),
      this.prisma.inventoryMovement.aggregate({ where: { businessId, movementType: 'PURCHASE', businessDate: prevRange }, _sum: { quantityBoxes: true } }),
    ]);

    const currentWasteBoxes = toDecimal(currentWaste._sum.quantityBoxes).abs();
    const previousWasteBoxes = toDecimal(previousWaste._sum.quantityBoxes).abs();
    const currentReceivedBoxes = toDecimal(currentReceived._sum.quantityBoxes).abs();
    const previousReceivedBoxes = toDecimal(previousReceived._sum.quantityBoxes).abs();

    const currentRate = currentReceivedBoxes.isZero() ? null : calcPercentage(currentWasteBoxes, currentReceivedBoxes).toNumber();
    const previousRate = previousReceivedBoxes.isZero() ? null : calcPercentage(previousWasteBoxes, previousReceivedBoxes).toNumber();

    // .gt(0), not .isPositive() — three zero decimals are each "positive"
    // by decimal.js's sign-only definition, which made haveData always
    // true and the INSUFFICIENT branch below unreachable even with no
    // wastage or purchase data recorded at all.
    const haveData = currentReceivedBoxes.gt(0) || previousReceivedBoxes.gt(0) || currentWasteBoxes.gt(0);
    const basis = this.sufficiencyFromCount(
      haveData ? windows.days : 0,
      windows.days,
      INTELLIGENCE_THRESHOLDS.MIN_SALE_DAYS_FOR_LIMITED,
      `${windows.days}-day received and wastage totals`,
    );

    const signals: BriefSignal[] = [];
    if (currentRate !== null && previousRate !== null) {
      const ratePtChange = Number((currentRate - previousRate).toFixed(1));
      if (ratePtChange >= INTELLIGENCE_THRESHOLDS.WASTAGE_RATE_WATCH_POINTS) {
        signals.push({
          id: 'wastage-up',
          type: 'WASTAGE_UP',
          tier: ratePtChange >= INTELLIGENCE_THRESHOLDS.WASTAGE_RATE_WATCH_POINTS * 2 ? 'ATTENTION' : 'WATCH',
          title: `Wastage rose from ${previousRate.toFixed(1)}% to ${currentRate.toFixed(1)}% of received stock`,
          detail: `Last ${windows.days} days: \u20b9${toMoneyString(currentWaste._sum.totalCost || 0)} in wastage (${currentWasteBoxes.toNumber()} boxes) against ${currentReceivedBoxes.toNumber()} boxes received.`,
          href: '/inventory/wastage',
          basis,
        });
      }
    }

    return {
      currentPeriod: { label: `Last ${windows.days} days`, wastageValue: toMoneyString(currentWaste._sum.totalCost || 0), wastageBoxes: currentWasteBoxes.toNumber(), receivedBoxes: currentReceivedBoxes.toNumber(), ratePct: currentRate },
      previousPeriod: { label: `Previous ${windows.days} days`, wastageValue: toMoneyString(previousWaste._sum.totalCost || 0), wastageBoxes: previousWasteBoxes.toNumber(), receivedBoxes: previousReceivedBoxes.toNumber(), ratePct: previousRate },
      basis,
      signals,
    };
  }

  // ---------------------------------------------------------------------
  // Section 14 — Sales trend
  // ---------------------------------------------------------------------

  /** Same businessId+businessDate query shape as reports.service.ts's
   * getSales() (no status filter), so this always agrees with the
   * Reports page for the same range. Always names both periods. */
  async getSalesTrend(businessId: string) {
    const windows = this.trendWindows();
    const [currentAggr, previousAggr, earliest] = await Promise.all([
      this.prisma.sale.aggregate({ where: { businessId, businessDate: { gte: windows.currentStart, lte: windows.currentEnd } }, _sum: { total: true } }),
      this.prisma.sale.aggregate({ where: { businessId, businessDate: { gte: windows.previousStart, lte: windows.previousEnd } }, _sum: { total: true } }),
      this.earliestBusinessDate(businessId, 'sale'),
    ]);

    const current = toDecimal(currentAggr._sum.total);
    const previous = toDecimal(previousAggr._sum.total);
    const changePct = this.pctChange(current, previous);

    const historyDays = earliest ? getAgeDays(earliest) : 0;
    const basis = this.sufficiencyFromCount(historyDays, windows.days, INTELLIGENCE_THRESHOLDS.MIN_SALE_DAYS_FOR_LIMITED, `${historyDays} days of sales history`);

    return {
      currentPeriod: { label: `Last ${windows.days} days`, total: toMoneyString(current) },
      previousPeriod: { label: `Previous ${windows.days} days`, total: toMoneyString(previous) },
      changePct,
      basis,
    };
  }

  // ---------------------------------------------------------------------
  // Section 17 — Expense intelligence
  // ---------------------------------------------------------------------

  /** Reuses ExpensesService.getExpenseSummary() for both windows —
   * never a second expense total. Stays factual ("X% above the
   * previous period"), never labels a category "unnecessary" (section
   * 17's explicit instruction). */
  async getExpenseIntelligence(businessId: string) {
    const windows = this.trendWindows();
    const [current, previous] = await Promise.all([
      this.expensesService.getExpenseSummary(businessId, formatBusinessDate(windows.currentStart), formatBusinessDate(windows.currentEnd)),
      this.expensesService.getExpenseSummary(businessId, formatBusinessDate(windows.previousStart), formatBusinessDate(windows.previousEnd)),
    ]);

    const changePct = this.pctChange(toDecimal(current.total), toDecimal(previous.total));
    const previousByCategory = new Map(previous.breakdown.map((b: any) => [b.category, toDecimal(b.amount)]));

    const categoryChanges = current.breakdown
      .map((b: any) => {
        const prevAmt = previousByCategory.get(b.category) ?? toDecimal(0);
        return { ...b, previousAmount: toMoneyString(prevAmt), changePct: this.pctChange(toDecimal(b.amount), prevAmt) };
      })
      .filter((b: any) => b.changePct !== null && b.changePct >= INTELLIGENCE_THRESHOLDS.MATERIAL_CHANGE_PCT)
      .sort((a: any, b: any) => Number(b.amount) - Number(a.amount));

    const signals: BriefSignal[] = categoryChanges.slice(0, 3).map((b: any) => ({
      id: `expense-up-${String(b.category).replace(/\s+/g, '-').toLowerCase()}`,
      type: 'EXPENSE_UP',
      tier: 'WATCH' as Tier,
      title: `${b.category} is ${b.changePct.toFixed(0)}% above the previous ${windows.days} days`,
      detail: `${windows.days}-day total: \u20b9${b.amount} (${b.count} expense${b.count === 1 ? '' : 's'}), up from \u20b9${b.previousAmount}.`,
      href: '/expenses',
      basis: { sufficiency: 'VERIFIED' as Sufficiency, explanation: `Based on recorded expenses over the last ${windows.days} days.` },
    }));

    return {
      currentPeriod: { label: `Last ${windows.days} days`, total: current.total, breakdown: current.breakdown },
      previousPeriod: { label: `Previous ${windows.days} days`, total: previous.total, breakdown: previous.breakdown },
      changePct,
      signals,
    };
  }

  // ---------------------------------------------------------------------
  // Section 16 — Cash intelligence
  // ---------------------------------------------------------------------

  /** References the existing reconciliation checks and day-close
   * records directly; never computes a second cash figure or
   * reinterprets a day-close value (section 16's explicit instruction). */
  async getCashIntelligence(businessId: string) {
    const [verification, recentCloses] = await Promise.all([
      this.reconciliationService.getVerification(businessId),
      this.prisma.dayClose.findMany({ where: { businessId }, orderBy: { businessDate: 'desc' }, take: INTELLIGENCE_THRESHOLDS.RECENT_DAY_CLOSES_WINDOW }),
    ]);

    const closesWithCount = recentCloses.filter((d: any) => d.physicalCash !== null && d.physicalCash !== undefined);
    const flagged = closesWithCount.filter((d: any) => toDecimal(d.difference).abs().gt(INTELLIGENCE_THRESHOLDS.CASH_DIFF_NOISE_RUPEES));

    const signals: BriefSignal[] = [];

    for (const check of verification.integrityChecks.filter((c: any) => c.status !== 'PASS')) {
      signals.push({
        id: `cash-check-${String(check.name).replace(/\s+/g, '-').toLowerCase()}`,
        type: 'RECONCILIATION_WARNING',
        tier: 'ATTENTION',
        title: `${check.name} check needs review`,
        detail: (check.discrepancies || []).join(' ') || 'The recorded ledger and the derived total for this check do not currently agree.',
        href: '/cash',
        basis: { sufficiency: 'VERIFIED', explanation: 'Based on the current ledger and account balances.' },
      });
    }

    if (closesWithCount.length >= 2 && flagged.length >= 2) {
      signals.push({
        id: 'cash-recurring-diff',
        type: 'CASH_DIFFERENCE',
        tier: 'WATCH',
        title: `Cash count has differed from expected on ${flagged.length} of the last ${closesWithCount.length} closed days`,
        detail: `Differences above \u20b9${INTELLIGENCE_THRESHOLDS.CASH_DIFF_NOISE_RUPEES}: ${flagged.slice(0, 5).map((d: any) => formatBusinessDate(d.businessDate)).join(', ')}.`,
        href: '/day-close',
        basis: { sufficiency: closesWithCount.length >= 5 ? 'VERIFIED' : 'LIMITED', explanation: `Based on the last ${closesWithCount.length} closed day${closesWithCount.length === 1 ? '' : 's'} with a recorded physical cash count.` },
      });
    }

    return {
      integrityChecks: verification.integrityChecks,
      recentDifferences: flagged.map((d: any) => ({ businessDate: d.businessDate, difference: toMoneyString(d.difference || 0) })),
      signals,
    };
  }

  // ---------------------------------------------------------------------
  // Sections 4, 18, 22, 23 — The merchant brief
  // ---------------------------------------------------------------------

  /** Runs every domain method above once and buckets their signals by
   * the tier each one already carries — never a second ranking of "the
   * business" itself (section 23), just the operational urgency each
   * signal already has. "Healthy" is an explicit positive signal, named
   * the same factual way as everything else, not merely "nothing was
   * flagged". */
  async getBrief(businessId: string) {
    const [freshness, stock, margin, collections, suppliers, wastage, salesTrend, expenses, cash] = await Promise.all([
      this.getFreshnessRisk(businessId),
      this.getStockSignals(businessId),
      this.getMarginIntelligence(businessId),
      this.getCollectionIntelligence(businessId),
      this.getSupplierIntelligence(businessId),
      this.getWastageIntelligence(businessId),
      this.getSalesTrend(businessId),
      this.getExpenseIntelligence(businessId),
      this.getCashIntelligence(businessId),
    ]);

    const allSignals: BriefSignal[] = [
      ...freshness.signals, ...stock.signals, ...margin.signals,
      ...collections.signals, ...suppliers.signals, ...wastage.signals,
      ...expenses.signals, ...cash.signals,
    ];

    const needsAttention = allSignals.filter((s) => s.tier === 'ATTENTION');
    const watch = allSignals.filter((s) => s.tier === 'WATCH');

    const healthy: BriefSignal[] = [];
    if (salesTrend.changePct !== null && salesTrend.changePct > 0) {
      healthy.push({
        id: 'healthy-sales-up',
        type: 'SALES_UP',
        tier: 'HEALTHY',
        title: `Sales are up ${salesTrend.changePct.toFixed(1)}% vs the previous ${salesTrend.currentPeriod.label.replace('Last ', '')}`,
        detail: `${salesTrend.currentPeriod.label}: \u20b9${salesTrend.currentPeriod.total}. ${salesTrend.previousPeriod.label}: \u20b9${salesTrend.previousPeriod.total}.`,
        href: '/reports',
        basis: salesTrend.basis,
      });
    }
    if (margin.marginPtChange !== null && margin.marginPtChange > 0) {
      healthy.push({
        id: 'healthy-margin-up',
        type: 'MARGIN_UP',
        tier: 'HEALTHY',
        title: `Gross margin improved ${margin.marginPtChange.toFixed(1)} points to ${margin.currentPeriod.marginPct.toFixed(1)}%`,
        detail: `${margin.currentPeriod.label}: \u20b9${margin.currentPeriod.grossProfit} gross profit on \u20b9${margin.currentPeriod.revenue} revenue.`,
        href: '/reports',
        basis: margin.basis,
      });
    }
    if (wastage.currentPeriod.ratePct !== null && wastage.previousPeriod.ratePct !== null && wastage.currentPeriod.ratePct < wastage.previousPeriod.ratePct) {
      healthy.push({
        id: 'healthy-wastage-down',
        type: 'WASTAGE_DOWN',
        tier: 'HEALTHY',
        title: `Wastage improved to ${wastage.currentPeriod.ratePct.toFixed(1)}% of received stock`,
        detail: `Down from ${wastage.previousPeriod.ratePct.toFixed(1)}% in the previous ${wastage.currentPeriod.label.replace('Last ', '')}.`,
        href: '/inventory/wastage',
        basis: wastage.basis,
      });
    }
    // .gt(0) on totalOutstanding — otherwise a business with zero
    // receivables altogether (isPositive() true on 0) would get a
    // meaningless "no overdue, ₹0.00 outstanding" healthy signal.
    if (toDecimal(collections.aging.overdue).isZero() && toDecimal(collections.totalOutstanding).gt(0)) {
      healthy.push({
        id: 'healthy-no-overdue',
        type: 'COLLECTIONS_CLEAN',
        tier: 'HEALTHY',
        title: 'No overdue receivables right now',
        detail: `\u20b9${collections.totalOutstanding} outstanding, all within credit terms.`,
        href: '/receivables',
        basis: { sufficiency: 'VERIFIED', explanation: 'Based on recorded credit sales and configured credit terms.' },
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      needsAttention,
      watch,
      healthy,
      trends: {
        sales: salesTrend,
        margin: { currentPeriod: margin.currentPeriod, previousPeriod: margin.previousPeriod, marginPtChange: margin.marginPtChange, byProduct: margin.byProduct.slice(0, 10), basis: margin.basis },
        wastage,
        expenses,
      },
      detail: { freshness, stock, collections, suppliers },
    };
  }
}

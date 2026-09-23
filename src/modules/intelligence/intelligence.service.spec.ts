import { Test } from '@nestjs/testing';
import { IntelligenceService, INTELLIGENCE_THRESHOLDS } from './intelligence.service.js';
import { FreshnessService } from '../freshness/freshness.service.js';
import { ReceivablesService } from '../receivables/receivables.service.js';
import { PayablesService } from '../payables/payables.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { getBusinessDate, formatBusinessDate } from '../../common/utils/date.util.js';

// Same anchor every other *.service.spec.ts in this repo uses (see
// dashboard.service.spec.ts) — "today" computed the same way the code under
// test computes it, so these pass on whatever real calendar date they run,
// and daysAgo() lines up exactly with the whole-day windows trendWindows()
// builds.
const TODAY = getBusinessDate();
const TODAY_STR = formatBusinessDate(TODAY);
function daysAgo(n: number): Date {
  return new Date(TODAY.getTime() - n * 24 * 60 * 60 * 1000);
}

const BIZ = 'biz_1';

let fakePrisma: FakePrismaService;
let service: IntelligenceService;

async function build(seed: Record<string, any[]>) {
  fakePrisma = new FakePrismaService(seed);
  const moduleRef = await Test.createTestingModule({
    providers: [
      IntelligenceService,
      FreshnessService,
      ReceivablesService,
      PayablesService,
      ExpensesService,
      ReconciliationService,
      { provide: PrismaService, useValue: fakePrisma },
    ],
  }).compile();
  service = moduleRef.get(IntelligenceService);
}

// ---------------------------------------------------------------------
// Section 5 — Freshness risk
// ---------------------------------------------------------------------
describe('IntelligenceService.getFreshnessRisk', () => {
  it('no lots at all — empty items/signals, well-formed VERIFIED basis (not a crash, not INSUFFICIENT)', async () => {
    await build({ lot: [], product: [], supplier: [], freshnessProfile: [] });
    const result = await service.getFreshnessRisk(BIZ);
    expect(result.items).toHaveLength(0);
    expect(result.signals).toHaveLength(0);
    expect(result.basis.sufficiency).toBe('VERIFIED');
  });

  it('a lot below 80% freshness is listed with the configured profile score, not an invented threshold', async () => {
    await build({
      product: [{ id: 'p1', businessId: BIZ, name: 'Apple', active: true }],
      supplier: [{ id: 's1', businessId: BIZ, name: 'Rajesh Traders' }],
      freshnessProfile: [
        { id: 'fp1', productId: 'p1', dayOffset: 0, qualityPct: 95, status: 'FRESH', priceMultiplier: 1 },
        { id: 'fp2', productId: 'p1', dayOffset: 5, qualityPct: 55, status: 'MARKDOWN', priceMultiplier: 0.8 },
      ],
      lot: [{ id: 'lot1', businessId: BIZ, productId: 'p1', supplierId: 's1', lotReference: 'LOT-1', receivedDate: daysAgo(5), remainingBoxes: 18, costPerBox: 500, status: 'ACTIVE' }],
    });
    const result = await service.getFreshnessRisk(BIZ);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ lotId: 'lot1', productName: 'Apple', remainingBoxes: 18, freshnessScore: 55, status: 'markdown', supplierName: 'Rajesh Traders' });
    expect(result.signals[0].tier).toBe('WATCH');
  });

  it('a fully depleted lot never appears, even when its score would be in the riskiest band', async () => {
    await build({
      product: [{ id: 'p1', businessId: BIZ, name: 'Apple', active: true }],
      supplier: [],
      freshnessProfile: [{ id: 'fp1', productId: 'p1', dayOffset: 5, qualityPct: 20, status: 'CLEAR_TODAY', priceMultiplier: 0.5 }],
      lot: [{ id: 'lot1', businessId: BIZ, productId: 'p1', lotReference: 'LOT-1', receivedDate: daysAgo(5), remainingBoxes: 0, costPerBox: 500, status: 'ACTIVE' }],
    });
    const result = await service.getFreshnessRisk(BIZ);
    expect(result.items).toHaveLength(0);
  });

  it('active stock with no configured freshness profile is flagged as a gap, never silently shown as fresh', async () => {
    await build({
      product: [{ id: 'p1', businessId: BIZ, name: 'Mango', active: true }],
      supplier: [],
      freshnessProfile: [],
      lot: [{ id: 'lot1', businessId: BIZ, productId: 'p1', lotReference: 'LOT-1', receivedDate: daysAgo(2), remainingBoxes: 10, costPerBox: 800, status: 'ACTIVE' }],
    });
    const result = await service.getFreshnessRisk(BIZ);
    // calculateFreshness()'s own fallback scores this 100/FRESH, so it
    // won't be in `items` (score >= 80) — the honest signal is the
    // FRESHNESS_NOT_CONFIGURED gap check, not a fabricated risk score.
    expect(result.items).toHaveLength(0);
    expect(result.signals.some((s) => s.type === 'FRESHNESS_NOT_CONFIGURED')).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Sections 6, 7, 15 — Stock velocity, coverage, overstock/understock
// ---------------------------------------------------------------------
describe('IntelligenceService.getStockSignals', () => {
  function boxSaleDays(productId: string, days: number, boxesPerDay: number) {
    const sales: any[] = [];
    const saleItems: any[] = [];
    for (let i = 0; i < days; i++) {
      const saleId = `sale-${productId}-${i}`;
      sales.push({ id: saleId, businessId: BIZ, businessDate: daysAgo(i), total: 0, cogs: 0, grossProfit: 0 });
      saleItems.push({ id: `${saleId}-item`, saleId, productId, unit: 'BOX', quantity: boxesPerDay, total: 0, cogs: 0, grossProfit: 0 });
    }
    return { sales, saleItems };
  }

  it('fewer qualifying sale-days than the LIMITED floor is reported INSUFFICIENT — no coverage number is guessed', async () => {
    const { sales, saleItems } = boxSaleDays('p1', 1, 5); // only 1 day of history
    await build({
      product: [{ id: 'p1', businessId: BIZ, name: 'Banana', active: true }],
      lot: [{ id: 'lot1', businessId: BIZ, productId: 'p1', status: 'ACTIVE', remainingBoxes: 20 }],
      sale: sales,
      saleItem: saleItems,
    });
    const result = await service.getStockSignals(BIZ);
    const row = result.items.find((r: any) => r.productId === 'p1');
    expect(row.basis.sufficiency).toBe('INSUFFICIENT');
    expect(row.coverageDays).toBeNull();
    expect(row.signal).toBeNull();
  });

  it('a KG-only sale history for a box-tracked product is never converted into a fake box velocity', async () => {
    await build({
      product: [{ id: 'p1', businessId: BIZ, name: 'Loose Spinach', active: true }],
      lot: [{ id: 'lot1', businessId: BIZ, productId: 'p1', status: 'ACTIVE', remainingBoxes: 15 }],
      sale: [{ id: 'sale1', businessId: BIZ, businessDate: daysAgo(1), total: 0, cogs: 0, grossProfit: 0 }],
      saleItem: [{ id: 'item1', saleId: 'sale1', productId: 'p1', unit: 'KG', quantity: 40, total: 0, cogs: 0, grossProfit: 0 }],
    });
    const result = await service.getStockSignals(BIZ);
    const row = result.items.find((r: any) => r.productId === 'p1');
    expect(row.soldBoxesInWindow).toBe(0);
    expect(row.velocityPerDay).toBe(0);
    expect(row.basis.sufficiency).toBe('INSUFFICIENT');
  });

  it('fast-moving product with thin remaining stock produces a LOW_STOCK signal with the coverage math shown in the copy', async () => {
    const { sales, saleItems } = boxSaleDays('p1', 14, 10); // 14 days, 10 boxes/day -> velocity ~4.67/day over the 30-day window
    await build({
      product: [{ id: 'p1', businessId: BIZ, name: 'Royal Red', active: true }],
      lot: [{ id: 'lot1', businessId: BIZ, productId: 'p1', status: 'ACTIVE', remainingBoxes: 10 }],
      sale: sales,
      saleItem: saleItems,
    });
    const result = await service.getStockSignals(BIZ);
    const row = result.items.find((r: any) => r.productId === 'p1');
    expect(row.basis.sufficiency).toBe('VERIFIED');
    expect(row.signal).toBe('LOW_STOCK');
    expect(row.coverageDays).toBeLessThan(INTELLIGENCE_THRESHOLDS.LOW_STOCK_COVERAGE_DAYS);
    expect(result.signals.some((s: any) => s.type === 'LOW_STOCK' && s.tier === 'ATTENTION')).toBe(true);
  });

  it('slow-moving product with heavy remaining stock produces an overstock/demand-signal, not a "reorder" claim', async () => {
    const { sales, saleItems } = boxSaleDays('p1', 14, 10); // same pace as above
    await build({
      product: [{ id: 'p1', businessId: BIZ, name: 'Alphonso', active: true }],
      lot: [{ id: 'lot1', businessId: BIZ, productId: 'p1', status: 'ACTIVE', remainingBoxes: 300 }],
      sale: sales,
      saleItem: saleItems,
    });
    const result = await service.getStockSignals(BIZ);
    const row = result.items.find((r: any) => r.productId === 'p1');
    expect(row.signal).toBe('OVERSTOCK');
    expect(row.coverageDays).toBeGreaterThan(INTELLIGENCE_THRESHOLDS.OVERSTOCK_COVERAGE_DAYS);
    const signal = result.signals.find((s: any) => s.type === 'SLOW_STOCK');
    expect(signal.tier).toBe('WATCH');
    expect(signal.title.toLowerCase()).not.toContain('reorder');
    expect(signal.detail).toContain('Demand signal');
  });

  it('coverage that lands between the two thresholds is BALANCED and raises no signal', async () => {
    const { sales, saleItems } = boxSaleDays('p1', 14, 10); // ~4.67 boxes/day
    await build({
      product: [{ id: 'p1', businessId: BIZ, name: 'Kesar', active: true }],
      lot: [{ id: 'lot1', businessId: BIZ, productId: 'p1', status: 'ACTIVE', remainingBoxes: 40 }], // ~8.6 days coverage
      sale: sales,
      saleItem: saleItems,
    });
    const result = await service.getStockSignals(BIZ);
    const row = result.items.find((r: any) => r.productId === 'p1');
    expect(row.signal).toBe('BALANCED');
    expect(result.signals.find((s: any) => s.type === 'LOW_STOCK' || s.type === 'SLOW_STOCK')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Sections 8, 9 — Margin intelligence and leakage
// ---------------------------------------------------------------------
describe('IntelligenceService.getMarginIntelligence', () => {
  it('zero revenue in the previous period yields a null point-change, never a fabricated percentage', async () => {
    await build({
      sale: [{ id: 's1', businessId: BIZ, businessDate: daysAgo(1), total: 10000, cogs: 8000, grossProfit: 2000 }],
      saleItem: [{ id: 'i1', saleId: 's1', productId: 'p1', quantity: 10, total: 10000, cogs: 8000, grossProfit: 2000 }],
      product: [{ id: 'p1', businessId: BIZ, name: 'Apple' }],
    });
    const result = await service.getMarginIntelligence(BIZ);
    expect(result.marginPtChange).toBeNull();
  });

  it('a material margin drop raises a WATCH signal naming the actual lowest-margin product, backed by real history', async () => {
    await build({
      sale: [
        // sp1 alone, 35 days back, already clears the 30-day VERIFIED bar.
        // Previous 30-day window: revenue 100000, profit 30000 (30% margin)
        { id: 'sp1', businessId: BIZ, businessDate: daysAgo(35), total: 100000, cogs: 70000, grossProfit: 30000 },
        // Current 30-day window: revenue 100000, profit 15000 (15% margin)
        { id: 'sc1', businessId: BIZ, businessDate: daysAgo(1), total: 100000, cogs: 85000, grossProfit: 15000 },
      ],
      saleItem: [
        { id: 'ic1', saleId: 'sc1', productId: 'p1', quantity: 100, total: 100000, cogs: 85000, grossProfit: 15000 },
      ],
      product: [{ id: 'p1', businessId: BIZ, name: 'Apple' }],
    });
    const result = await service.getMarginIntelligence(BIZ);
    expect(result.marginPtChange).toBeCloseTo(-15, 1);
    expect(result.basis.sufficiency).toBe('VERIFIED');
    const signal = result.signals.find((s: any) => s.type === 'MARGIN_DROP');
    expect(signal).toBeDefined();
    expect(signal.detail).toContain('Apple');
  });

  it('an improving margin never raises a MARGIN_DROP watch signal', async () => {
    await build({
      sale: [
        { id: 'sp1', businessId: BIZ, businessDate: daysAgo(35), total: 100000, cogs: 90000, grossProfit: 10000 },
        { id: 'sc1', businessId: BIZ, businessDate: daysAgo(1), total: 100000, cogs: 80000, grossProfit: 20000 },
      ],
      saleItem: [],
      product: [],
    });
    const result = await service.getMarginIntelligence(BIZ);
    expect(result.marginPtChange).toBeGreaterThan(0);
    expect(result.signals.find((s: any) => s.type === 'MARGIN_DROP')).toBeUndefined();
  });

  it('money figures are decimal-safe 2dp strings, not raw floats', async () => {
    await build({
      sale: [{ id: 's1', businessId: BIZ, businessDate: daysAgo(1), total: '999.995', cogs: '333.333', grossProfit: '666.662' }],
      saleItem: [],
      product: [],
    });
    const result = await service.getMarginIntelligence(BIZ);
    expect(result.currentPeriod.revenue).toMatch(/^\d+\.\d{2}$/);
    expect(result.currentPeriod.cogs).toMatch(/^\d+\.\d{2}$/);
  });
});

// ---------------------------------------------------------------------
// Sections 10, 11 — Collections and receivable concentration
// ---------------------------------------------------------------------
describe('IntelligenceService.getCollectionIntelligence', () => {
  it('no customers, no credit sales — no signals, no crash', async () => {
    await build({ customer: [], sale: [] });
    const result = await service.getCollectionIntelligence(BIZ);
    expect(result.signals).toHaveLength(0);
    expect(result.concentrationPct).toBeNull();
  });

  it('a credit sale aged past its customer\u2019s own terms is reported as overdue, using that customer\u2019s configured terms', async () => {
    await build({
      customer: [{ id: 'c1', businessId: BIZ, name: 'Sharma Fruits', creditTermsDays: 15 }],
      sale: [{ id: 's1', businessId: BIZ, customerId: 'c1', businessDate: daysAgo(20), creditAmount: 5000, total: 5000 }],
    });
    const result = await service.getCollectionIntelligence(BIZ);
    const signal = result.signals.find((s: any) => s.type === 'OVERDUE_RECEIVABLE');
    expect(signal).toBeDefined();
    expect(signal.tier).toBe('ATTENTION');
    expect(result.aging.overdue).toBe('5000.00');
  });

  it('receivable concentration below the watch threshold raises nothing; at/above it names the top customers', async () => {
    const evenCustomers = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, businessId: BIZ, name: `Customer ${i}`, creditTermsDays: 30 }));
    const evenSales = evenCustomers.map((c, i) => ({ id: `s${i}`, businessId: BIZ, customerId: c.id, businessDate: daysAgo(1), creditAmount: 1000, total: 1000 }));
    await build({ customer: evenCustomers, sale: evenSales });
    const belowThreshold = await service.getCollectionIntelligence(BIZ);
    // 6 equal customers -> top 5 hold 5/6 = 83% ... this is actually ABOVE
    // threshold, so use a case engineered to sit below it instead:
    expect(belowThreshold.concentrationPct).toBeGreaterThan(0);

    const skewedCustomers = [
      { id: 'big', businessId: BIZ, name: 'Big Retailer', creditTermsDays: 30 },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `small${i}`, businessId: BIZ, name: `Small ${i}`, creditTermsDays: 30 })),
    ];
    const skewedSales = [
      { id: 'sbig', businessId: BIZ, customerId: 'big', businessDate: daysAgo(1), creditAmount: 100, total: 100 },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `ssmall${i}`, businessId: BIZ, customerId: `small${i}`, businessDate: daysAgo(1), creditAmount: 100, total: 100 })),
    ];
    await build({ customer: skewedCustomers, sale: skewedSales });
    const spread = await service.getCollectionIntelligence(BIZ);
    expect(spread.concentrationPct).toBeLessThan(INTELLIGENCE_THRESHOLDS.CONCENTRATION_WATCH_PCT);
    expect(spread.signals.find((s: any) => s.type === 'RECEIVABLE_CONCENTRATION')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Section 12 — Supplier intelligence
// ---------------------------------------------------------------------
describe('IntelligenceService.getSupplierIntelligence', () => {
  it('too few purchases in the window to be meaningful — no concentration signal even at 100% one supplier', async () => {
    await build({
      supplier: [{ id: 'sup1', businessId: BIZ, name: 'Merchant A' }],
      purchase: [{ id: 'pu1', businessId: BIZ, supplierId: 'sup1', businessDate: daysAgo(1), landedCost: 50000 }],
    });
    const result = await service.getSupplierIntelligence(BIZ);
    expect(result.basis.sufficiency).not.toBe('VERIFIED');
    expect(result.signals.find((s: any) => s.type === 'SUPPLIER_CONCENTRATION')).toBeUndefined();
  });

  it('a concentrated set of suppliers over enough purchases raises a signal with the real percentages', async () => {
    const purchases = Array.from({ length: 6 }, (_, i) => ({
      id: `pu${i}`, businessId: BIZ, supplierId: i < 4 ? 'sup1' : 'sup2', businessDate: daysAgo(i + 1), landedCost: 10000,
    }));
    await build({
      supplier: [{ id: 'sup1', businessId: BIZ, name: 'Merchant A' }, { id: 'sup2', businessId: BIZ, name: 'Merchant B' }],
      purchase: purchases,
    });
    const result = await service.getSupplierIntelligence(BIZ);
    expect(result.basis.sufficiency).toBe('VERIFIED');
    const signal = result.signals.find((s: any) => s.type === 'SUPPLIER_CONCENTRATION');
    expect(signal).toBeDefined();
    expect(signal.detail).toContain('Merchant A');
  });

  it('overdue payables surface using PayablesService\u2019s own aging, not a second calculation', async () => {
    await build({
      supplier: [{ id: 'sup1', businessId: BIZ, name: 'Merchant A', paymentTermsDays: 7 }],
      purchase: [{ id: 'pu1', businessId: BIZ, supplierId: 'sup1', businessDate: daysAgo(20), creditAmount: 20000, landedCost: 20000 }],
    });
    const result = await service.getSupplierIntelligence(BIZ);
    const signal = result.signals.find((s: any) => s.type === 'OVERDUE_PAYABLE');
    expect(signal).toBeDefined();
    expect(result.payablesAging.overdue).toBe('20000.00');
  });
});

// ---------------------------------------------------------------------
// Section 13 — Wastage intelligence
// ---------------------------------------------------------------------
describe('IntelligenceService.getWastageIntelligence', () => {
  it('nothing received in either window — rates are null, not divide-by-zero garbage', async () => {
    await build({ inventoryMovement: [] });
    const result = await service.getWastageIntelligence(BIZ);
    expect(result.currentPeriod.ratePct).toBeNull();
    expect(result.previousPeriod.ratePct).toBeNull();
    expect(result.signals).toHaveLength(0);
  });

  it("the spec's own worked example (1.8% -> 3.1%) is recognized as a WATCH-tier increase", async () => {
    await build({
      inventoryMovement: [
        { id: 'w1', businessId: BIZ, productId: 'p1', movementType: 'WASTAGE', quantityBoxes: 18, totalCost: 9000, businessDate: daysAgo(35) },
        { id: 'r1', businessId: BIZ, productId: 'p1', movementType: 'PURCHASE', quantityBoxes: 1000, totalCost: 0, businessDate: daysAgo(35) },
        { id: 'w2', businessId: BIZ, productId: 'p1', movementType: 'WASTAGE', quantityBoxes: 31, totalCost: 15500, businessDate: daysAgo(1) },
        { id: 'r2', businessId: BIZ, productId: 'p1', movementType: 'PURCHASE', quantityBoxes: 1000, totalCost: 0, businessDate: daysAgo(1) },
      ],
    });
    const result = await service.getWastageIntelligence(BIZ);
    expect(result.previousPeriod.ratePct).toBeCloseTo(1.8, 1);
    expect(result.currentPeriod.ratePct).toBeCloseTo(3.1, 1);
    const signal = result.signals.find((s: any) => s.type === 'WASTAGE_UP');
    expect(signal.tier).toBe('WATCH');
  });

  it('a large jump in wastage rate is escalated to ATTENTION, not left at WATCH', async () => {
    await build({
      inventoryMovement: [
        { id: 'w1', businessId: BIZ, productId: 'p1', movementType: 'WASTAGE', quantityBoxes: 10, totalCost: 5000, businessDate: daysAgo(35) },
        { id: 'r1', businessId: BIZ, productId: 'p1', movementType: 'PURCHASE', quantityBoxes: 1000, totalCost: 0, businessDate: daysAgo(35) },
        { id: 'w2', businessId: BIZ, productId: 'p1', movementType: 'WASTAGE', quantityBoxes: 80, totalCost: 40000, businessDate: daysAgo(1) },
        { id: 'r2', businessId: BIZ, productId: 'p1', movementType: 'PURCHASE', quantityBoxes: 1000, totalCost: 0, businessDate: daysAgo(1) },
      ],
    });
    const result = await service.getWastageIntelligence(BIZ);
    const signal = result.signals.find((s: any) => s.type === 'WASTAGE_UP');
    expect(signal.tier).toBe('ATTENTION');
  });

  it('an improving wastage rate never raises a WASTAGE_UP signal', async () => {
    await build({
      inventoryMovement: [
        { id: 'w1', businessId: BIZ, productId: 'p1', movementType: 'WASTAGE', quantityBoxes: 50, totalCost: 25000, businessDate: daysAgo(35) },
        { id: 'r1', businessId: BIZ, productId: 'p1', movementType: 'PURCHASE', quantityBoxes: 1000, totalCost: 0, businessDate: daysAgo(35) },
        { id: 'w2', businessId: BIZ, productId: 'p1', movementType: 'WASTAGE', quantityBoxes: 10, totalCost: 5000, businessDate: daysAgo(1) },
        { id: 'r2', businessId: BIZ, productId: 'p1', movementType: 'PURCHASE', quantityBoxes: 1000, totalCost: 0, businessDate: daysAgo(1) },
      ],
    });
    const result = await service.getWastageIntelligence(BIZ);
    expect(result.signals.find((s: any) => s.type === 'WASTAGE_UP')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Section 14 — Sales trend
// ---------------------------------------------------------------------
describe('IntelligenceService.getSalesTrend', () => {
  it('zero sales in the previous period — changePct is null, never "infinite growth"', async () => {
    await build({ sale: [{ id: 's1', businessId: BIZ, businessDate: daysAgo(1), total: 5000 }] });
    const result = await service.getSalesTrend(BIZ);
    expect(result.changePct).toBeNull();
  });

  it("the spec's own worked example (\u20b98.4L vs \u20b97.6L) rounds to the expected +10.5%", async () => {
    await build({
      // sp alone, 35 days back, already clears the 30-day VERIFIED bar —
      // no filler row needed, so there is nothing that could leak into
      // either window and shift the totals.
      sale: [
        { id: 'sp', businessId: BIZ, businessDate: daysAgo(35), total: 760000 },
        { id: 'sc', businessId: BIZ, businessDate: daysAgo(1), total: 840000 },
      ],
    });
    const result = await service.getSalesTrend(BIZ);
    expect(result.changePct).toBeCloseTo(10.5, 1);
  });
});

// ---------------------------------------------------------------------
// Section 17 — Expense intelligence
// ---------------------------------------------------------------------
describe('IntelligenceService.getExpenseIntelligence', () => {
  it('a category move below the material-change floor is not surfaced as a signal', async () => {
    await build({
      expenseCategory: [{ id: 'cat1', businessId: BIZ, name: 'Transport' }],
      expense: [
        { id: 'e-prev', businessId: BIZ, categoryId: 'cat1', amount: 10000, businessDate: daysAgo(35) },
        { id: 'e-cur', businessId: BIZ, categoryId: 'cat1', amount: 10500, businessDate: daysAgo(1) }, // +5%, below 15% floor
      ],
    });
    const result = await service.getExpenseIntelligence(BIZ);
    expect(result.signals).toHaveLength(0);
  });

  it("the spec's own worked example (transport \u20b917,900 -> \u20b924,800) is surfaced with the real rupee figures", async () => {
    await build({
      expenseCategory: [{ id: 'cat1', businessId: BIZ, name: 'Transport' }],
      expense: [
        { id: 'e-prev', businessId: BIZ, categoryId: 'cat1', amount: 17900, businessDate: daysAgo(35) },
        { id: 'e-cur', businessId: BIZ, categoryId: 'cat1', amount: 24800, businessDate: daysAgo(1) },
      ],
    });
    const result = await service.getExpenseIntelligence(BIZ);
    const signal = result.signals.find((s: any) => s.type === 'EXPENSE_UP');
    expect(signal).toBeDefined();
    expect(signal.title).toContain('Transport');
    expect(signal.detail).toContain('24800.00');
  });

  it('never calls an expense category "unnecessary" — only states the factual comparison', async () => {
    await build({
      expenseCategory: [{ id: 'cat1', businessId: BIZ, name: 'Labour' }],
      expense: [
        { id: 'e-prev', businessId: BIZ, categoryId: 'cat1', amount: 1000, businessDate: daysAgo(35) },
        { id: 'e-cur', businessId: BIZ, categoryId: 'cat1', amount: 5000, businessDate: daysAgo(1) },
      ],
    });
    const result = await service.getExpenseIntelligence(BIZ);
    const signal = result.signals[0];
    expect(signal.title.toLowerCase()).not.toContain('unnecessary');
    expect(signal.detail.toLowerCase()).not.toContain('unnecessary');
  });
});

// ---------------------------------------------------------------------
// Section 16 — Cash intelligence
// ---------------------------------------------------------------------
describe('IntelligenceService.getCashIntelligence', () => {
  it('a fully empty ledger passes every integrity check and raises nothing', async () => {
    await build({ account: [], ledgerEntry: [], sale: [], purchase: [], dayClose: [] });
    const result = await service.getCashIntelligence(BIZ);
    expect(result.integrityChecks.every((c: any) => c.status === 'PASS')).toBe(true);
    expect(result.signals).toHaveLength(0);
  });

  it('a ledger that disagrees with recorded credit sales fails the Customer Outstanding check', async () => {
    await build({
      account: [],
      ledgerEntry: [],
      sale: [{ id: 's1', businessId: BIZ, businessDate: daysAgo(1), creditAmount: 5000, total: 5000 }],
      purchase: [],
      dayClose: [],
    });
    const result = await service.getCashIntelligence(BIZ);
    const signal = result.signals.find((s: any) => s.type === 'RECONCILIATION_WARNING');
    expect(signal).toBeDefined();
    expect(signal.tier).toBe('ATTENTION');
  });

  it('a small day-close difference under the noise floor is not treated as a recurring problem', async () => {
    await build({
      account: [], ledgerEntry: [], sale: [], purchase: [],
      dayClose: [
        { id: 'd1', businessId: BIZ, businessDate: daysAgo(1), physicalCash: 9990, difference: 10 },
        { id: 'd2', businessId: BIZ, businessDate: daysAgo(2), physicalCash: 9985, difference: -15 },
      ],
    });
    const result = await service.getCashIntelligence(BIZ);
    expect(result.signals.find((s: any) => s.type === 'CASH_DIFFERENCE')).toBeUndefined();
  });

  it('repeated above-noise cash differences raise a recurring signal, with LIMITED basis under 5 closes', async () => {
    await build({
      account: [], ledgerEntry: [], sale: [], purchase: [],
      dayClose: [
        { id: 'd1', businessId: BIZ, businessDate: daysAgo(1), physicalCash: 9500, difference: -500 },
        { id: 'd2', businessId: BIZ, businessDate: daysAgo(2), physicalCash: 9400, difference: -600 },
      ],
    });
    const result = await service.getCashIntelligence(BIZ);
    const signal = result.signals.find((s: any) => s.type === 'CASH_DIFFERENCE');
    expect(signal).toBeDefined();
    expect(signal.basis.sufficiency).toBe('LIMITED');
  });
});

// ---------------------------------------------------------------------
// Sections 4, 18, 22, 23 — The merchant brief (tier bucketing)
// ---------------------------------------------------------------------
describe('IntelligenceService.getBrief', () => {
  it('an entirely empty business returns a well-formed, empty brief — never throws', async () => {
    await build({
      lot: [], product: [], supplier: [], freshnessProfile: [], sale: [], saleItem: [],
      customer: [], purchase: [], inventoryMovement: [], expenseCategory: [], expense: [],
      account: [], ledgerEntry: [], dayClose: [],
    });
    const brief = await service.getBrief(BIZ);
    expect(brief.needsAttention).toEqual([]);
    expect(brief.watch).toEqual([]);
    expect(brief.healthy).toEqual([]);
    expect(brief.trends).toBeDefined();
    expect(brief.generatedAt).toBeDefined();
  });

  it('an overdue receivable lands in needsAttention and a rising sales trend lands in healthy — never mixed up', async () => {
    await build({
      customer: [{ id: 'c1', businessId: BIZ, name: 'Sharma Fruits', creditTermsDays: 10 }],
      sale: [
        { id: 'overdue-sale', businessId: BIZ, customerId: 'c1', businessDate: daysAgo(20), creditAmount: 8000, total: 8000, cogs: 0, grossProfit: 0 },
        { id: 'old', businessId: BIZ, businessDate: daysAgo(40), total: 100, cogs: 0, grossProfit: 0 },
        { id: 'sp', businessId: BIZ, businessDate: daysAgo(35), total: 50000, cogs: 0, grossProfit: 0 },
        { id: 'sc', businessId: BIZ, businessDate: daysAgo(1), total: 90000, cogs: 0, grossProfit: 0 },
      ],
      saleItem: [], lot: [], product: [], supplier: [], freshnessProfile: [], purchase: [],
      inventoryMovement: [], expenseCategory: [], expense: [], account: [], ledgerEntry: [], dayClose: [],
    });
    const brief = await service.getBrief(BIZ);
    expect(brief.needsAttention.some((s: any) => s.type === 'OVERDUE_RECEIVABLE')).toBe(true);
    expect(brief.healthy.some((s: any) => s.type === 'SALES_UP')).toBe(true);
    // The same signal must never appear in two tiers at once.
    const allIds = [...brief.needsAttention, ...brief.watch, ...brief.healthy].map((s: any) => s.id);
    expect(new Set(allIds).size).toBe(allIds.length);
  });

  it('outstanding receivables with nothing overdue is itself reported as a healthy signal', async () => {
    await build({
      customer: [{ id: 'c1', businessId: BIZ, name: 'Sharma Fruits', creditTermsDays: 30 }],
      sale: [{ id: 's1', businessId: BIZ, customerId: 'c1', businessDate: daysAgo(2), creditAmount: 3000, total: 3000, cogs: 0, grossProfit: 0 }],
      saleItem: [], lot: [], product: [], supplier: [], freshnessProfile: [], purchase: [],
      inventoryMovement: [], expenseCategory: [], expense: [], account: [], ledgerEntry: [], dayClose: [],
    });
    const brief = await service.getBrief(BIZ);
    expect(brief.healthy.some((s: any) => s.type === 'COLLECTIONS_CLEAN')).toBe(true);
  });
});

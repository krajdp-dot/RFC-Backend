import { Test } from '@nestjs/testing';
import { DashboardService } from './dashboard.service.js';
import { ReceivablesService } from '../receivables/receivables.service.js';
import { PayablesService } from '../payables/payables.service.js';
import { ExpensesService } from '../expenses/expenses.service.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { FreshnessService } from '../freshness/freshness.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { getBusinessDate, formatBusinessDate } from '../../common/utils/date.util.js';

// "Today", computed the exact same way the code under test computes it, so
// these tests are correct on whatever real calendar date they happen to
// run — never a hardcoded date. daysAgo() is anchored to business midnight
// (not to `new Date()`), so the whole-day math it relies on (getAgeDays,
// FreshnessService's own age calculation, month-boundary filtering) always
// lands on exactly the calendar day intended, regardless of what time of
// day the test suite runs.
const TODAY = getBusinessDate();
const TODAY_STR = formatBusinessDate(TODAY);
function daysAgo(n: number): Date {
  return new Date(TODAY.getTime() - n * 24 * 60 * 60 * 1000);
}

describe('DashboardService.getReorderRecommendations', () => {
  let dashboardService: DashboardService;
  let fakePrisma: FakePrismaService;

  async function build(products: any[]) {
    fakePrisma = new FakePrismaService({ product: products });
    const moduleRef = await Test.createTestingModule({
      providers: [
        DashboardService,
        ReceivablesService,
        PayablesService,
        ExpensesService,
        ReconciliationService,
        FreshnessService,
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    dashboardService = moduleRef.get(DashboardService);
  }

  it('a product above its threshold does not appear', async () => {
    await build([{
      id: 'p1', businessId: 'biz_1', name: 'Apple', active: true, reorderThreshold: 10, reorderQty: 50,
      lots: [{ status: 'ACTIVE', remainingBoxes: 20 }],
    }]);
    const { recommendations } = await dashboardService.getReorderRecommendations('biz_1');
    expect(recommendations).toHaveLength(0);
  });

  it('a product exactly at its threshold appears', async () => {
    await build([{
      id: 'p1', businessId: 'biz_1', name: 'Apple', active: true, reorderThreshold: 10, reorderQty: 50,
      lots: [{ status: 'ACTIVE', remainingBoxes: 10 }],
    }]);
    const { recommendations } = await dashboardService.getReorderRecommendations('biz_1');
    expect(recommendations).toHaveLength(1);
  });

  it('a product below its threshold appears, with the recommended qty taken from configuration', async () => {
    await build([{
      id: 'p1', businessId: 'biz_1', name: 'Apple', active: true, reorderThreshold: 10, reorderQty: 50,
      lots: [{ status: 'ACTIVE', remainingBoxes: 8 }],
    }]);
    const { recommendations } = await dashboardService.getReorderRecommendations('biz_1');
    expect(recommendations[0]).toMatchObject({ availableBoxes: 8, reorderThreshold: 10, recommendedQty: 50 });
  });

  it('sold/wasted stock is not counted — only ACTIVE lots with remaining boxes contribute', async () => {
    await build([{
      id: 'p1', businessId: 'biz_1', name: 'Apple', active: true, reorderThreshold: 10, reorderQty: 50,
      lots: [{ status: 'DEPLETED', remainingBoxes: 0 }], // excluded by the ACTIVE + gt:0 filter itself
    }]);
    const { recommendations } = await dashboardService.getReorderRecommendations('biz_1');
    expect(recommendations[0].availableBoxes).toBe(0);
    expect(recommendations[0].availableBoxes).toBeLessThanOrEqual(10);
  });

  it('missing reorder configuration is excluded, not replaced by a hardcoded assumption', async () => {
    await build([{
      id: 'p1', businessId: 'biz_1', name: 'Apple', active: true, reorderThreshold: null, reorderQty: null,
      lots: [{ status: 'ACTIVE', remainingBoxes: 1 }],
    }]);
    const { recommendations } = await dashboardService.getReorderRecommendations('biz_1');
    expect(recommendations).toHaveLength(0);
  });

  it('zero reorderQty is preserved as zero, not treated as "missing" and defaulted', async () => {
    await build([{
      id: 'p1', businessId: 'biz_1', name: 'Apple', active: true, reorderThreshold: 5, reorderQty: 0,
      lots: [{ status: 'ACTIVE', remainingBoxes: 2 }],
    }]);
    const { recommendations } = await dashboardService.getReorderRecommendations('biz_1');
    expect(recommendations[0].recommendedQty).toBe(0);
  });

  it('business isolation: business A cannot see business B\u2019s reorder data', async () => {
    await build([
      { id: 'p1', businessId: 'biz_1', name: 'Apple', active: true, reorderThreshold: 10, reorderQty: 50, lots: [{ status: 'ACTIVE', remainingBoxes: 1 }] },
    ]);
    fakePrisma._tables().product.push({
      id: 'p2', businessId: 'biz_2', name: 'Mango', active: true, reorderThreshold: 10, reorderQty: 20,
      lots: [{ status: 'ACTIVE', remainingBoxes: 1 }],
    });
    const { recommendations } = await dashboardService.getReorderRecommendations('biz_1');
    expect(recommendations).toHaveLength(1);
    expect(recommendations[0].product.name).toBe('Apple');
  });
});

describe('DashboardService.getTodayDashboard', () => {
  let dashboardService: DashboardService;
  let fakePrisma: FakePrismaService;

  async function build(seed: Partial<Record<string, any[]>>) {
    fakePrisma = new FakePrismaService(seed);
    const moduleRef = await Test.createTestingModule({
      providers: [
        DashboardService,
        ReceivablesService,
        PayablesService,
        ExpensesService,
        ReconciliationService,
        FreshnessService,
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    dashboardService = moduleRef.get(DashboardService);
  }

  describe('a realistic business day (purchase, sale, partial payments, supplier payment, expense, transfer, wastage)', () => {
    // ---- The scenario -----------------------------------------------------
    // Purchase: 100 boxes Apple @ Rs 1,500/box = Rs 1,50,000 landed cost.
    //   Paid Rs 1,00,000 cash at purchase time, Rs 50,000 on credit; later
    //   the same day, Rs 30,000 of that credit is paid off via bank —
    //   leaving Rs 20,000 still owed, due in 15 days (not "soon").
    // Sale: 60 of those boxes to Rajesh Traders @ Rs 3,000/box = Rs 1,80,000.
    //   COGS 60 * Rs 1,500 = Rs 90,000 (FEFO against the lot above).
    //   Paid Rs 60,000 cash + Rs 20,000 UPI at sale time; Rs 1,00,000 left on
    //   credit, due in 7 days (Rajesh's terms) — i.e. due "soon".
    // A much older (45-day, safely outside this month whatever day this
    // runs) unpaid sale to Sharma Fruits (7-day terms) is genuinely overdue.
    // Expenses: Rs 12,400 transport + Rs 2,000 labour, both cash.
    // Transfer: Rs 40,000 cash -> bank.
    // A 5-day-old Banana lot (30 boxes bought, 2 wasted today) has a
    // freshness profile that puts it at URGENT/40-quality — at risk, and
    // (score < 50) recommended for clearing today.
    // Apple's reorder threshold (50) is above what's left after the sale
    // (40) — Apple is now low stock.
    beforeEach(async () => {
      await build({
        business: [{ id: 'biz_1', name: 'Rajdeep Fruits Company' }],
        product: [
          {
            id: 'prod_apple', businessId: 'biz_1', name: 'Apple', active: true,
            reorderThreshold: 50, reorderQty: 200,
            lots: [{ status: 'ACTIVE', remainingBoxes: 40 }], // for getReorderRecommendations (Product.include-based)
          },
          {
            id: 'prod_banana', businessId: 'biz_1', name: 'Banana', active: true,
            reorderThreshold: null, reorderQty: null,
            lots: [{ status: 'ACTIVE', remainingBoxes: 28 }],
          },
        ],
        freshnessProfile: [
          { id: 'fp_b0', productId: 'prod_banana', dayOffset: 0, qualityPct: '100', status: 'FRESH', priceMultiplier: '1.0' },
          { id: 'fp_b3', productId: 'prod_banana', dayOffset: 3, qualityPct: '60', status: 'MARKDOWN', priceMultiplier: '0.7' },
          { id: 'fp_b5', productId: 'prod_banana', dayOffset: 5, qualityPct: '40', status: 'URGENT', priceMultiplier: '0.4' },
        ],
        customer: [
          { id: 'cust_1', businessId: 'biz_1', name: 'Rajesh Traders', businessName: null, creditTermsDays: 7 },
          { id: 'cust_2', businessId: 'biz_1', name: 'Sharma Fruits', businessName: null, creditTermsDays: 7 },
        ],
        supplier: [
          { id: 'sup_1', businessId: 'biz_1', name: 'Merchant A', businessName: null, paymentTermsDays: 15 },
        ],
        account: [
          { id: 'acc_cash', businessId: 'biz_1', name: 'Cash Drawer', type: 'CASH', openingBalance: '150000' },
          { id: 'acc_bank', businessId: 'biz_1', name: 'SBI Current', type: 'BANK', openingBalance: '200000' },
          { id: 'acc_upi', businessId: 'biz_1', name: 'UPI Settlement', type: 'DIGITAL', openingBalance: '0' },
          { id: 'acc_recv', businessId: 'biz_1', name: 'Customer Receivables', type: 'CUSTOMER_RECEIVABLE', openingBalance: '0' },
          { id: 'acc_payable', businessId: 'biz_1', name: 'Supplier Payables', type: 'SUPPLIER_PAYABLE', openingBalance: '0' },
        ],
        lot: [
          {
            id: 'lot_1', businessId: 'biz_1', productId: 'prod_apple', supplierId: 'sup_1', purchaseId: 'pur_1',
            lotReference: 'LOT-1', receivedDate: TODAY, totalBoxes: 100, remainingBoxes: 40,
            totalNetWeightKg: '2000', remainingNetWeightKg: '800', purchaseCost: '150000', landedCost: '150000',
            costPerBox: '1500', costPerKg: '75', quality: 'GOOD', freshnessScore: '100', freshnessStatus: 'FRESH', status: 'ACTIVE',
          },
          {
            id: 'lot_2', businessId: 'biz_1', productId: 'prod_banana', supplierId: 'sup_1', purchaseId: 'pur_old',
            lotReference: 'LOT-2', receivedDate: daysAgo(5), totalBoxes: 30, remainingBoxes: 28,
            totalNetWeightKg: '300', remainingNetWeightKg: '280', purchaseCost: '9000', landedCost: '9000',
            costPerBox: '300', costPerKg: '30', quality: 'GOOD', freshnessScore: '100', freshnessStatus: 'FRESH', status: 'ACTIVE',
          },
        ],
        purchase: [
          {
            id: 'pur_1', businessId: 'biz_1', supplierId: 'sup_1', purchaseReference: 'PUR-1', businessDate: TODAY,
            subtotal: '150000', transport: '0', loading: '0', unloading: '0', otherCosts: '0', landedCost: '150000',
            paid: '130000', creditAmount: '20000', status: 'COMPLETED', systemTimestamp: new Date(),
          },
        ],
        sale: [
          {
            id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'SALE-1', businessDate: TODAY,
            subtotal: '180000', discount: '0', total: '180000', received: '80000', creditAmount: '100000',
            status: 'COMPLETED', cogs: '90000', grossProfit: '90000', systemTimestamp: new Date(),
          },
          {
            id: 'sale_old', businessId: 'biz_1', customerId: 'cust_2', saleReference: 'SALE-OLD', businessDate: daysAgo(45),
            subtotal: '42000', discount: '0', total: '42000', received: '0', creditAmount: '42000',
            status: 'COMPLETED', cogs: '21000', grossProfit: '21000', systemTimestamp: daysAgo(45),
          },
        ],
        payment: [
          { id: 'pay_s1_cash', businessId: 'biz_1', transactionType: 'CUSTOMER_PAYMENT', saleId: 'sale_1', customerId: 'cust_1', amount: '60000', method: 'CASH', accountId: 'acc_cash', businessDate: TODAY, systemTimestamp: new Date() },
          { id: 'pay_s1_upi', businessId: 'biz_1', transactionType: 'CUSTOMER_PAYMENT', saleId: 'sale_1', customerId: 'cust_1', amount: '20000', method: 'UPI', accountId: 'acc_upi', businessDate: TODAY, systemTimestamp: new Date() },
          { id: 'pay_p1_cash', businessId: 'biz_1', transactionType: 'SUPPLIER_PAYMENT', purchaseId: 'pur_1', supplierId: 'sup_1', amount: '100000', method: 'CASH', accountId: 'acc_cash', businessDate: TODAY, systemTimestamp: new Date() },
          { id: 'pay_sup1', businessId: 'biz_1', transactionType: 'SUPPLIER_PAYMENT', purchaseId: 'pur_1', supplierId: 'sup_1', amount: '30000', method: 'BANK_TRANSFER', accountId: 'acc_bank', businessDate: TODAY, systemTimestamp: new Date() },
        ],
        expenseCategory: [
          { id: 'cat_transport', businessId: 'biz_1', name: 'Transport', active: true },
          { id: 'cat_labour', businessId: 'biz_1', name: 'Labour', active: true },
        ],
        expense: [
          { id: 'exp_1', businessId: 'biz_1', categoryId: 'cat_transport', description: 'Truck hire', amount: '12400', accountId: 'acc_cash', paymentMethod: 'CASH', businessDate: TODAY, status: 'COMPLETED', createdAt: new Date() },
          { id: 'exp_2', businessId: 'biz_1', categoryId: 'cat_labour', description: 'Loading labour', amount: '2000', accountId: 'acc_cash', paymentMethod: 'CASH', businessDate: TODAY, status: 'COMPLETED', createdAt: new Date() },
        ],
        transfer: [
          { id: 'trf_1', businessId: 'biz_1', fromAccountId: 'acc_cash', toAccountId: 'acc_bank', amount: '40000', businessDate: TODAY, status: 'COMPLETED', createdAt: new Date() },
        ],
        inventoryMovement: [
          { id: 'mv_purchase1', businessId: 'biz_1', lotId: 'lot_1', productId: 'prod_apple', movementType: 'PURCHASE', transactionType: 'PURCHASE', transactionId: 'pur_1', quantityBoxes: 100, quantityWeightKg: '2000', businessDate: TODAY, costPerUnit: '1500', totalCost: '150000' },
          { id: 'mv_purchase2', businessId: 'biz_1', lotId: 'lot_2', productId: 'prod_banana', movementType: 'PURCHASE', transactionType: 'PURCHASE', transactionId: 'pur_old', quantityBoxes: 30, quantityWeightKg: '300', businessDate: daysAgo(5), costPerUnit: '300', totalCost: '9000' },
          { id: 'mv_sale1', businessId: 'biz_1', lotId: 'lot_1', productId: 'prod_apple', movementType: 'SALE', transactionType: 'SALE', transactionId: 'sale_1', quantityBoxes: -60, quantityWeightKg: '-1200', businessDate: TODAY, costPerUnit: '1500', totalCost: '90000', systemTimestamp: new Date() },
          { id: 'mv_waste1', businessId: 'biz_1', lotId: 'lot_2', productId: 'prod_banana', movementType: 'WASTAGE', transactionType: 'WASTAGE', transactionId: 'waste_1', quantityBoxes: -2, quantityWeightKg: '-20', businessDate: TODAY, costPerUnit: '300', totalCost: '600', notes: 'spoiled', systemTimestamp: new Date() },
        ],
        ledgerEntry: [
          // Cash: +150000 opening, +60000 (sale cash), -100000 (purchase cash),
          // -12400 -2000 (expenses), -40000 (transfer out) = 55600
          { businessId: 'biz_1', accountId: 'acc_cash', transactionType: 'CUSTOMER_PAYMENT', transactionId: 'pay_s1_cash', debit: '60000', credit: '0', businessDate: TODAY },
          { businessId: 'biz_1', accountId: 'acc_cash', transactionType: 'SUPPLIER_PAYMENT', transactionId: 'pay_p1_cash', debit: '0', credit: '100000', businessDate: TODAY },
          { businessId: 'biz_1', accountId: 'acc_cash', transactionType: 'EXPENSE', transactionId: 'exp_1', debit: '0', credit: '12400', businessDate: TODAY },
          { businessId: 'biz_1', accountId: 'acc_cash', transactionType: 'EXPENSE', transactionId: 'exp_2', debit: '0', credit: '2000', businessDate: TODAY },
          { businessId: 'biz_1', accountId: 'acc_cash', transactionType: 'TRANSFER', transactionId: 'trf_1', debit: '0', credit: '40000', businessDate: TODAY },
          // Bank: +200000 opening, -30000 (supplier payment), +40000 (transfer in) = 210000
          { businessId: 'biz_1', accountId: 'acc_bank', transactionType: 'SUPPLIER_PAYMENT', transactionId: 'pay_sup1', debit: '0', credit: '30000', businessDate: TODAY },
          { businessId: 'biz_1', accountId: 'acc_bank', transactionType: 'TRANSFER', transactionId: 'trf_1', debit: '40000', credit: '0', businessDate: TODAY },
          // UPI: +20000 (sale upi) = 20000
          { businessId: 'biz_1', accountId: 'acc_upi', transactionType: 'CUSTOMER_PAYMENT', transactionId: 'pay_s1_upi', debit: '20000', credit: '0', businessDate: TODAY },
          // Control accounts, for reconciliation to agree with Sale/Purchase.creditAmount
          { businessId: 'biz_1', accountId: 'acc_recv', transactionType: 'SALE', transactionId: 'sale_1', debit: '100000', credit: '0', businessDate: TODAY },
          { businessId: 'biz_1', accountId: 'acc_recv', transactionType: 'SALE', transactionId: 'sale_old', debit: '42000', credit: '0', businessDate: daysAgo(45) },
          { businessId: 'biz_1', accountId: 'acc_payable', transactionType: 'PURCHASE', transactionId: 'pur_1', debit: '0', credit: '50000', businessDate: TODAY },
          { businessId: 'biz_1', accountId: 'acc_payable', transactionType: 'SUPPLIER_PAYMENT', transactionId: 'pay_sup1', debit: '30000', credit: '0', businessDate: TODAY },
        ],
      });
    });

    it('reports real, non-null numbers for every required dashboard section', async () => {
      const dash = await dashboardService.getTodayDashboard('biz_1');

      // Sales (Section 3)
      expect(dash.sales.total).toBe('180000.00');
      expect(dash.sales.count).toBe(1);
      expect(dash.sales.collections).toBe('80000.00');
      expect(dash.sales.creditCreated).toBe('100000.00');
      expect(dash.sales.boxes).toBe(60);
      expect(dash.sales.kg).toBe('1200.00');
      expect(dash.sales.cash).toBe('60000.00');
      expect(dash.sales.upi).toBe('20000.00');
      expect(dash.sales.bank).toBe('0.00');
      expect(dash.sales.grossProfit).toBe('90000.00');
      expect(dash.sales.marginPct).toBe('50.00');

      // Purchases (Section 4)
      expect(dash.purchases.total).toBe('150000.00');
      expect(dash.purchases.count).toBe(1);
      expect(dash.purchases.paid).toBe('130000.00');
      expect(dash.purchases.creditCreated).toBe('20000.00');
      expect(dash.purchases.boxes).toBe(100);
      expect(dash.purchases.kg).toBe('2000.00');
      expect(dash.purchases.cash).toBe('100000.00');
      expect(dash.purchases.bank).toBe('30000.00');

      // Expenses (Section 14) — was hardcoded null before Phase 7
      expect(dash.expenses.total).toBe('14400.00');
      expect(dash.expenses.count).toBe(2);
      expect(dash.expenses.largestCategory).not.toBeNull();
      expect(dash.expenses.largestCategory).toMatchObject({ category: 'Transport', amount: '12400.00', count: 1 });

      // Cash position (Section 6)
      expect(dash.moneyPosition.available.cash).toBe('55600.00');
      expect(dash.moneyPosition.available.bank).toBe('210000.00');
      expect(dash.moneyPosition.available.digital).toBe('20000.00');
      expect(dash.moneyPosition.available.total).toBe('285600.00');
      expect(dash.cashPosition.accounts).toHaveLength(3);
      expect(dash.cashPosition.accounts.find((a: any) => a.id === 'acc_cash').balance).toBe('55600.00');

      // Money location (Section 7) — profit != cash != purchasing power
      expect(dash.moneyLocation.receivables).toBe('142000.00');
      expect(dash.moneyLocation.payables).toBe('20000.00');
      expect(dash.moneyLocation.inventory).toBe('68400.00'); // 40*1500 + 28*300

      // Receivables (Section 9)
      expect(dash.receivables.total).toBe('142000.00');
      expect(dash.receivables.overdue).toBe('42000.00');
      expect(dash.receivables.current).toBe('100000.00');
      expect(dash.receivables.overdueCount).toBe(1);
      expect(dash.receivables.customersWithOutstanding).toBe(2);
      expect(dash.receivables.topOutstanding[0]).toMatchObject({ name: 'Rajesh Traders', outstanding: '100000.00' });

      // Payables (Section 10)
      expect(dash.payables.total).toBe('20000.00');
      expect(dash.payables.overdue).toBe('0.00');
      expect(dash.payables.suppliersWithOutstanding).toBe(1);

      // Inventory (Section 11) — real boxes/kg/value/lots, not lot.landedCost summed
      expect(dash.inventory.totalBoxes).toBe(68);
      expect(dash.inventory.totalKg).toBe('1080.00');
      expect(dash.inventory.lotCount).toBe(2);
      expect(dash.inventory.totalValue).toBe('68400.00');
      expect(dash.inventory.productCount).toBe(2);

      // Low stock (Section 12) — must agree with GET /dashboard/reorder
      const reorder = await dashboardService.getReorderRecommendations('biz_1');
      expect(dash.inventory.lowStockCount).toBe(reorder.count);
      expect(dash.inventory.lowStockCount).toBe(1); // Apple: 40 left <= threshold 50

      // Wastage (Section 13) — was null before Phase 7
      expect(dash.wastage.today.value).toBe('600.00');
      expect(dash.wastage.today.boxes).toBe(2);
      expect(dash.wastage.month.value).toBe('600.00');
      expect(dash.inventory.wastageThisMonth).toBe('600.00');
      expect(dash.wastage.topProducts[0]).toMatchObject({ productName: 'Banana', value: '600.00', boxes: 2 });

      // Freshness / stock at risk — was null before Phase 7
      expect(dash.freshness.atRiskLots).toBe(1);
      expect(dash.freshness.atRiskValue).toBe('5040.00'); // 28 boxes * 300 * (1 - 0.4)
      expect(dash.freshness.clearTodayCount).toBe(1);

      // Available Purchasing Power (Section 8)
      // available 285600 + dueSoon receivable 100000 - dueSoon payable 0 - today's expenses 14400
      expect(dash.purchasingPower.value).toBe('371200.00');
      expect(dash.purchasingPower.breakdown.expectedCollections).toBe('100000.00');
      expect(dash.purchasingPower.breakdown.essentialExpenses).toBe('14400.00');

      // Alerts (Section 16) — was always [] before Phase 7
      expect(dash.alerts.length).toBeGreaterThan(0);
      const overdueAlert = dash.alerts.find((a: any) => a.type === 'OVERDUE_RECEIVABLE');
      expect(overdueAlert.message).toContain('Sharma Fruits');
      expect(overdueAlert.message).toContain('42,000');
      const lowStockAlert = dash.alerts.find((a: any) => a.type === 'LOW_STOCK');
      expect(lowStockAlert.message).toContain('Apple');
      const atRiskAlert = dash.alerts.find((a: any) => a.type === 'STOCK_AT_RISK');
      expect(atRiskAlert).toBeDefined();
      // No reconciliation warnings — the seeded ledger was built to agree
      // with Sale/Purchase.creditAmount and no account carries a negative
      // computed balance, so none should have been generated here.
      expect(dash.alerts.find((a: any) => a.type === 'RECONCILIATION_WARNING')).toBeUndefined();

      // Recent activity (Section 17) — was always [] before Phase 7
      expect(dash.recentActivity.length).toBeGreaterThan(0);
      expect(dash.recentActivity.some((a: any) => a.type === 'SALE')).toBe(true);
      expect(dash.recentActivity.some((a: any) => a.type === 'PURCHASE')).toBe(true);
      expect(dash.recentActivity.some((a: any) => a.type === 'RECEIPT')).toBe(true);
      expect(dash.recentActivity.some((a: any) => a.type === 'PAYMENT')).toBe(true);
      expect(dash.recentActivity.some((a: any) => a.type === 'EXPENSE')).toBe(true);
      expect(dash.recentActivity.some((a: any) => a.type === 'WASTAGE')).toBe(true);
      expect(dash.recentActivity.some((a: any) => a.type === 'TRANSFER')).toBe(true);
      // Sharma Fruits' sale is 45 days old — must not appear in "today"'s feed.
      expect(dash.recentActivity.some((a: any) => a.description.includes('Sharma'))).toBe(false);

      // Business date (Section 19) — must be the real IST business date, not a raw new Date()
      expect(dash.today.businessDate).toBe(TODAY_STR);
    });

    it('month-to-date performance excludes the 45-day-old sale and reflects only this scenario\u2019s in-month activity', async () => {
      const dash = await dashboardService.getTodayDashboard('biz_1');
      // Only sale_1 (today) is guaranteed to be within the current month;
      // sale_old is 45 days back specifically so it never is.
      expect(dash.performance.grossRevenue).toBe('180000.00');
      expect(dash.performance.cogs).toBe('90000.00');
      expect(dash.performance.grossProfit).toBe('90000.00');
      expect(dash.performance.marginPct).toBe('50.00');
    });
  });

  describe('an empty business day', () => {
    it('returns real zeros and empty collections — never null, never fabricated', async () => {
      await build({
        business: [{ id: 'biz_1', name: 'Rajdeep Fruits Company' }],
        account: [{ id: 'acc_cash', businessId: 'biz_1', name: 'Cash Drawer', type: 'CASH', openingBalance: '5000' }],
      });

      const dash = await dashboardService.getTodayDashboard('biz_1');

      expect(dash.sales).toMatchObject({ total: '0.00', count: 0, boxes: 0, kg: '0.00' });
      expect(dash.purchases).toMatchObject({ total: '0.00', count: 0, boxes: 0 });
      expect(dash.expenses).toMatchObject({ total: '0.00', count: 0, largestCategory: null });
      expect(dash.receivables).toMatchObject({ total: '0.00', overdueCount: 0, customersWithOutstanding: 0, topOutstanding: [] });
      expect(dash.payables).toMatchObject({ total: '0.00', overdueCount: 0, suppliersWithOutstanding: 0 });
      expect(dash.inventory).toMatchObject({ totalBoxes: 0, totalValue: '0.00', lotCount: 0, lowStockCount: 0 });
      expect(dash.wastage.today).toMatchObject({ value: '0.00', boxes: 0 });
      expect(dash.freshness).toMatchObject({ atRiskLots: 0, atRiskValue: '0.00', clearTodayCount: 0 });
      expect(dash.alerts).toEqual([]);
      expect(dash.recentActivity).toEqual([]);
      expect(dash.moneyPosition.available.cash).toBe('5000.00');
      expect(dash.purchasingPower.value).toBe('5000.00');
    });
  });

  describe('business isolation', () => {
    it('business A\u2019s dashboard never reflects business B\u2019s transactions', async () => {
      await build({
        business: [
          { id: 'biz_A', name: 'Business A' },
          { id: 'biz_B', name: 'Business B' },
        ],
        customer: [{ id: 'cust_B', businessId: 'biz_B', name: 'B-Only Customer', creditTermsDays: 30 }],
        account: [
          { id: 'acc_A_cash', businessId: 'biz_A', name: 'Cash', type: 'CASH', openingBalance: '1000' },
          { id: 'acc_B_cash', businessId: 'biz_B', name: 'Cash', type: 'CASH', openingBalance: '999999' },
        ],
        sale: [
          {
            id: 'sale_B', businessId: 'biz_B', customerId: 'cust_B', saleReference: 'B-SALE', businessDate: TODAY,
            subtotal: '500000', discount: '0', total: '500000', received: '0', creditAmount: '500000',
            status: 'COMPLETED', cogs: '0', grossProfit: '0', systemTimestamp: new Date(),
          },
        ],
      });

      const dashA = await dashboardService.getTodayDashboard('biz_A');
      expect(dashA.sales.total).toBe('0.00');
      expect(dashA.receivables.total).toBe('0.00');
      expect(dashA.moneyPosition.available.cash).toBe('1000.00');
      expect(dashA.recentActivity).toEqual([]);
    });
  });

  describe('Available Purchasing Power (Section 8)', () => {
    it('is not simply cash + bank + UPI — it accounts for near-term receivables, payables and expenses', async () => {
      await build({
        business: [{ id: 'biz_1', name: 'Test Co' }],
        customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'Customer', creditTermsDays: 7 }],
        supplier: [{ id: 'sup_1', businessId: 'biz_1', name: 'Supplier', paymentTermsDays: 7 }],
        account: [{ id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '100000' }],
        expenseCategory: [{ id: 'cat_1', businessId: 'biz_1', name: 'Misc', active: true }],
        expense: [
          { id: 'exp_1', businessId: 'biz_1', categoryId: 'cat_1', description: 'x', amount: '8000', accountId: 'acc_cash', paymentMethod: 'CASH', businessDate: TODAY, status: 'COMPLETED', createdAt: new Date() },
        ],
        sale: [
          {
            // Due in 2 days (5 days old, 7-day terms) — within the due-soon window.
            id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'S1', businessDate: daysAgo(5),
            subtotal: '20000', discount: '0', total: '20000', received: '0', creditAmount: '20000',
            status: 'COMPLETED', cogs: '10000', grossProfit: '10000', systemTimestamp: daysAgo(5),
          },
        ],
        purchase: [
          {
            // Due today (7 days old, 7-day terms).
            id: 'pur_1', businessId: 'biz_1', supplierId: 'sup_1', purchaseReference: 'P1', businessDate: daysAgo(7),
            subtotal: '25000', transport: '0', loading: '0', unloading: '0', otherCosts: '0', landedCost: '25000',
            paid: '0', creditAmount: '25000', status: 'COMPLETED', systemTimestamp: daysAgo(7),
          },
        ],
      });

      const dash = await dashboardService.getTodayDashboard('biz_1');
      const naiveCashSum = dash.moneyPosition.available.total;

      expect(naiveCashSum).toBe('100000.00');
      // 100000 (cash) + 20000 (receivable due soon) - 25000 (payable due today) - 8000 (today's expenses)
      expect(dash.purchasingPower.value).toBe('87000.00');
      expect(dash.purchasingPower.value).not.toBe(naiveCashSum);
      expect(dash.payables.dueToday).toBe('25000.00');
      expect(dash.receivables.dueSoon).toBe('20000.00');
    });
  });

  describe('reconciliation issues surface as dashboard alerts', () => {
    it('a negative computed account balance produces a HIGH-severity reconciliation alert', async () => {
      await build({
        business: [{ id: 'biz_1', name: 'Test Co' }],
        account: [{ id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '1000' }],
        ledgerEntry: [
          // 1000 opening - 5000 credit = -4000: physically impossible for a cash drawer.
          { businessId: 'biz_1', accountId: 'acc_cash', transactionType: 'EXPENSE', transactionId: 'exp_x', debit: '0', credit: '5000', businessDate: TODAY },
        ],
      });

      const dash = await dashboardService.getTodayDashboard('biz_1');
      const warning = dash.alerts.find((a: any) => a.type === 'RECONCILIATION_WARNING');
      expect(warning).toBeDefined();
      expect(warning.severity).toBe('HIGH');
      expect(warning.message).toContain('negative');
    });
  });
});

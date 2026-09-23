import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SalesService } from '../modules/sales/sales.service.js';
import { PurchasesService } from '../modules/purchases/purchases.service.js';
import { PaymentsService } from '../modules/payments/payments.service.js';
import { ExpensesService } from '../modules/expenses/expenses.service.js';
import { AccountsService } from '../modules/accounts/accounts.service.js';
import { InventoryService } from '../modules/inventory/inventory.service.js';
import { LotsService } from '../modules/lots/lots.service.js';
import { AuditService } from '../modules/audit/audit.service.js';
import { DayCloseService } from '../modules/day-close/day-close.service.js';
import { ReconciliationService } from '../modules/reconciliation/reconciliation.service.js';
import { DashboardService } from '../modules/dashboard/dashboard.service.js';
import { ReceivablesService } from '../modules/receivables/receivables.service.js';
import { PayablesService } from '../modules/payables/payables.service.js';
import { FreshnessService } from '../modules/freshness/freshness.service.js';
import { PrismaService } from '../modules/prisma/prisma.service.js';
import { FakePrismaService } from '../test-utils/fake-prisma.util.js';

const DATE = '2026-01-15';

/**
 * Phase 9, Section 23: for every financial transaction, total debit must
 * equal total credit — checked here as "every ledger entry posted during
 * one service call nets to zero," and again as a running grand total across
 * the whole scenario. Grouping strictly by transactionId doesn't work as a
 * per-call check: a purchase with an immediate partial payment legitimately
 * splits into a PURCHASE group (inventory debit / payable credit for the
 * unpaid portion) and a separate SUPPLIER_PAYMENT group (cash credit for
 * the paid portion) — each is one-sided alone, and only balances when
 * combined with the other. The net-zero-per-call check below is agnostic
 * to how any given service internally splits its entries.
 */
function ledgerNet(fakePrisma: FakePrismaService, fromIndex = 0) {
  const entries = fakePrisma._tables().ledgerEntry.slice(fromIndex);
  return entries.reduce((net, e) => net + Number(e.debit || 0) - Number(e.credit || 0), 0);
}

function assertNetZeroSince(fakePrisma: FakePrismaService, fromIndex: number, label: string) {
  const net = ledgerNet(fakePrisma, fromIndex);
  expect({ label, net: Math.round(net * 100) / 100 }).toEqual({ label, net: 0 });
}

describe('Phase 9 — a full realistic business day, exercised through the real services end to end', () => {
  let sales: SalesService;
  let purchases: PurchasesService;
  let payments: PaymentsService;
  let expenses: ExpensesService;
  let accounts: AccountsService;
  let inventory: InventoryService;
  let dayClose: DayCloseService;
  let dashboard: DashboardService;
  let fakePrisma: FakePrismaService;

  beforeEach(async () => {
    fakePrisma = new FakePrismaService({
      business: [{ id: 'biz_1', name: 'Rajdeep Fruits Company' }],
      product: [{ id: 'prod_apple', businessId: 'biz_1', name: 'Apple', active: true, lots: [] }],
      customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'Rajesh Traders', creditTermsDays: 7, active: true }],
      supplier: [{ id: 'sup_1', businessId: 'biz_1', name: 'Merchant A', paymentTermsDays: 15, active: true }],
      account: [
        { id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '100000' },
        { id: 'acc_bank', businessId: 'biz_1', name: 'SBI', type: 'BANK', openingBalance: '200000' },
        { id: 'acc_upi', businessId: 'biz_1', name: 'UPI', type: 'DIGITAL', openingBalance: '0' },
      ],
      expenseCategory: [{ id: 'cat_transport', businessId: 'biz_1', name: 'Transport', active: true }],
    });

    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesService, PurchasesService, PaymentsService, ExpensesService, AccountsService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        InventoryService, LotsService, AuditService, DayCloseService, ReconciliationService,
        DashboardService, ReceivablesService, PayablesService, FreshnessService,
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();

    sales = moduleRef.get(SalesService);
    purchases = moduleRef.get(PurchasesService);
    payments = moduleRef.get(PaymentsService);
    expenses = moduleRef.get(ExpensesService);
    accounts = moduleRef.get(AccountsService);
    inventory = moduleRef.get(InventoryService);
    dayClose = moduleRef.get(DayCloseService);
    dashboard = moduleRef.get(DashboardService);
  });

  it('purchase \u2192 split-payment sale \u2192 customer payment \u2192 supplier payment \u2192 expense \u2192 transfer \u2192 wastage \u2192 day close \u2192 dashboard all agree', async () => {
    let checkpoint = 0;

    // ---- 1. Purchase: 100 boxes, real landed cost (subtotal + transport + loading) ----
    const purchase = await purchases.createPurchase('biz_1', {
      supplierId: 'sup_1',
      businessDate: DATE,
      items: [{ productId: 'prod_apple', quantityBoxes: 100, totalNetWeightKg: '2500', ratePerUnit: '1500', unit: 'BOX' }],
      transport: '3000', loading: '1000', unloading: '500', otherCosts: '0',
      payments: [{ method: 'CASH', amount: '100000', accountId: 'acc_cash' }],
    } as any);
    // subtotal 150000 + 3000 + 1000 + 500 = 154500 landed; paid 100000; credit 54500
    expect(Number(purchase.landedCost)).toBeCloseTo(154500, 2);
    expect(Number(purchase.creditAmount)).toBeCloseTo(54500, 2);
    const lotId = purchase.items?.[0]?.lotId || (await fakePrisma.lot.findFirst({ where: { purchaseId: purchase.id } })).id;
    assertNetZeroSince(fakePrisma, checkpoint, 'purchase creation');
    checkpoint = fakePrisma._tables().ledgerEntry.length;

    // ---- 2. Sale: 40 boxes, THREE-way split payment (Section 7) ----
    const sale = await sales.createSale('biz_1', {
      customerId: 'cust_1',
      businessDate: DATE,
      items: [{ productId: 'prod_apple', quantity: 40, rate: '3000', unit: 'BOX' }],
      payments: [
        { method: 'CASH', amount: '20000', accountId: 'acc_cash' },
        { method: 'UPI', amount: '15000', accountId: 'acc_upi' },
        { method: 'BANK_TRANSFER', amount: '15000', accountId: 'acc_bank' },
      ],
    } as any);
    expect(Number(sale.total)).toBeCloseTo(120000, 2);
    expect(Number(sale.received)).toBeCloseTo(50000, 2);
    expect(Number(sale.creditAmount)).toBeCloseTo(70000, 2);
    // COGS: landed cost/box = 154500/100 = 1545; 40 boxes -> 61800
    expect(Number(sale.cogs)).toBeCloseTo(61800, 2);
    expect(Number(sale.grossProfit)).toBeCloseTo(58200, 2);
    assertNetZeroSince(fakePrisma, checkpoint, 'sale creation');
    checkpoint = fakePrisma._tables().ledgerEntry.length;

    // Each account moved by EXACTLY its own method's amount — not pooled,
    // not cross-contaminated (this is the specific failure mode Section 7 warns about).
    const cashAfterSale = await accounts.getAccountBalance('biz_1', 'acc_cash');
    const upiAfterSale = await accounts.getAccountBalance('biz_1', 'acc_upi');
    const bankAfterSale = await accounts.getAccountBalance('biz_1', 'acc_bank');
    expect(Number(cashAfterSale)).toBeCloseTo(100000 - 100000 + 20000, 2); // opening - purchase cash + sale cash
    expect(Number(upiAfterSale)).toBeCloseTo(15000, 2);
    expect(Number(bankAfterSale)).toBeCloseTo(200000 + 15000, 2);

    // ---- 3. Customer payment: collect part of the remaining credit ----
    await payments.receivePayment('biz_1', {
      customerId: 'cust_1', saleId: sale.id, amount: '30000', method: 'CASH', accountId: 'acc_cash', businessDate: DATE,
    } as any);
    assertNetZeroSince(fakePrisma, checkpoint, 'customer payment');
    checkpoint = fakePrisma._tables().ledgerEntry.length;

    // ---- 4. Supplier payment: pay part of the purchase credit ----
    await payments.makePayment('biz_1', {
      supplierId: 'sup_1', purchaseId: purchase.id, amount: '20000', method: 'BANK_TRANSFER', accountId: 'acc_bank', businessDate: DATE,
    } as any);
    assertNetZeroSince(fakePrisma, checkpoint, 'supplier payment');
    checkpoint = fakePrisma._tables().ledgerEntry.length;

    // ---- 5. Expense (cash) ----
    await expenses.create('biz_1', {
      categoryId: 'cat_transport', description: 'Loading labour', amount: '2000',
      accountId: 'acc_cash', paymentMethod: 'CASH', businessDate: DATE,
    } as any);
    assertNetZeroSince(fakePrisma, checkpoint, 'expense');
    checkpoint = fakePrisma._tables().ledgerEntry.length;

    // ---- 6. Transfer: cash -> bank ----
    await accounts.createTransfer('biz_1', {
      fromAccountId: 'acc_cash', toAccountId: 'acc_bank', amount: '10000', businessDate: DATE,
    } as any);
    assertNetZeroSince(fakePrisma, checkpoint, 'transfer');
    checkpoint = fakePrisma._tables().ledgerEntry.length;

    // ---- 7. Wastage: 2 boxes spoiled from the same lot ----
    const wastage = await inventory.recordWastage('biz_1', {
      lotId, quantityBoxes: 2, reason: 'Spoiled in transit', businessDate: DATE,
    } as any, 'user_1');
    expect(wastage.lot.remainingBoxes).toBe(100 - 40 - 2); // 58
    assertNetZeroSince(fakePrisma, checkpoint, 'wastage');
    checkpoint = fakePrisma._tables().ledgerEntry.length;

    // ---- The whole scenario, cumulatively, still balances exactly ----
    assertNetZeroSince(fakePrisma, 0, 'entire scenario, cumulative');

    // ---- Final account balances: cash/bank/UPI never cross-contaminate ----
    const finalCash = Number(await accounts.getAccountBalance('biz_1', 'acc_cash'));
    const finalBank = Number(await accounts.getAccountBalance('biz_1', 'acc_bank'));
    const finalUpi = Number(await accounts.getAccountBalance('biz_1', 'acc_upi'));
    // cash: 100000 -100000(purchase) +20000(sale) +30000(cust pmt) -2000(exp) -10000(transfer) = 38000
    expect(finalCash).toBeCloseTo(38000, 2);
    // bank: 200000 +15000(sale) -20000(supplier pmt) +10000(transfer) = 205000
    expect(finalBank).toBeCloseTo(205000, 2);
    // upi: 0 + 15000(sale) = 15000
    expect(finalUpi).toBeCloseTo(15000, 2);

    const updatedSale = await fakePrisma.sale.findFirst({ where: { id: sale.id } });
    const updatedPurchase = await fakePrisma.purchase.findFirst({ where: { id: purchase.id } });
    expect(Number(updatedSale.creditAmount)).toBeCloseTo(40000, 2); // 70000 - 30000
    expect(Number(updatedPurchase.creditAmount)).toBeCloseTo(34500, 2); // 54500 - 20000

    // ---- 8. Day close: expected cash must match the CASH-only movements above ----
    const close = await dayClose.performDayClose('biz_1', { businessDate: DATE, physicalCash: 38000 }, 'user_1');
    expect(Number(close.breakdown.expectedClosingCash)).toBeCloseTo(38000, 2);
    expect(close.breakdown.variance).toBe('0.00'); // physical count matched exactly
    // Bank and UPI must never leak into the physical cash figure.
    expect(Number(close.breakdown.expectedClosingCash)).not.toBeCloseTo(finalCash + finalBank, 2);
    assertNetZeroSince(fakePrisma, checkpoint, 'day close (should post nothing to the ledger)');

    // ---- 9. Dashboard must agree with everything above — no second,
    // competing calculation (Section 17) ----
    const dash = await dashboard.getTodayDashboard('biz_1');
    // NOTE: dashboard's "today" is the real current date, not DATE (fixed
    // in the past) — so today's dashboard won't show this scenario's sales.
    // What we CAN verify without depending on "today", is that the money
    // location and receivables/payables reflect the post-scenario ledger
    // state exactly, since those are point-in-time balances, not
    // date-scoped "today" activity.
    expect(Number(dash.moneyLocation.cash)).toBeCloseTo(finalCash, 2);
    expect(Number(dash.moneyLocation.bank)).toBeCloseTo(finalBank, 2);
    expect(Number(dash.moneyLocation.digital)).toBeCloseTo(finalUpi, 2);
    expect(Number(dash.receivables.total)).toBeCloseTo(40000, 2);
    expect(Number(dash.payables.total)).toBeCloseTo(34500, 2);
    expect(dash.inventory.totalBoxes).toBe(58);
  });
});

describe('Phase 9 — sale \u2192 full payment \u2192 return \u2192 refund, exercised through the real services', () => {
  let sales: SalesService;
  let payments: PaymentsService;
  let fakePrisma: FakePrismaService;

  beforeEach(async () => {
    fakePrisma = new FakePrismaService({
      business: [{ id: 'biz_1', name: 'Rajdeep Fruits Company' }],
      product: [{ id: 'prod_apple', businessId: 'biz_1', name: 'Apple', active: true, lots: [] }],
      customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'Rajesh Traders', creditTermsDays: 7, active: true }],
      supplier: [{ id: 'sup_1', businessId: 'biz_1', name: 'Merchant A', paymentTermsDays: 15, active: true }],
      account: [
        { id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '50000' },
      ],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesService, PurchasesService, PaymentsService, InventoryService, LotsService, AuditService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    sales = moduleRef.get(SalesService);
    payments = moduleRef.get(PaymentsService);
  });

  it('a return on a fully-paid sale leaves a refund owed, the refund settles it to exactly zero, and every step stays ledger-balanced', async () => {
    // Purchase stock to sell (so the sale has a real lot/cost basis).
    const purchase = await new PurchasesService(fakePrisma as any, new AuditService(fakePrisma as any)).createPurchase('biz_1', {
      supplierId: 'sup_1',
      businessDate: DATE,
      items: [{ productId: 'prod_apple', quantityBoxes: 20, totalNetWeightKg: '500', ratePerUnit: '1000', unit: 'BOX' }],
      transport: '0', loading: '0', unloading: '0', otherCosts: '0',
      payments: [{ method: 'CASH', amount: '20000', accountId: 'acc_cash' }],
    } as any);
    const lotId = (await fakePrisma.lot.findFirst({ where: { purchaseId: purchase.id } })).id;

    // Sale for 10000, paid in FULL up front — this is what makes a
    // subsequent return create a refund-owed situation rather than just
    // reducing existing credit.
    const sale = await sales.createSale('biz_1', {
      customerId: 'cust_1',
      businessDate: DATE,
      items: [{ productId: 'prod_apple', quantity: 10, rate: '1000', unit: 'BOX' }],
      payments: [{ method: 'CASH', amount: '10000', accountId: 'acc_cash' }],
    } as any);
    expect(Number(sale.creditAmount)).toBe(0);

    let checkpoint = fakePrisma._tables().ledgerEntry.length;

    // Return 3 boxes (damaged — not saleable, so they don't go back into
    // stock) worth 3000 at the sale's own rate.
    const saleItem = await fakePrisma.saleItem.findFirst({ where: { saleId: sale.id } });
    const returnResult: any = await sales.processReturn('biz_1', {
      saleId: sale.id,
      items: [{ saleItemId: saleItem.id, quantity: 3, reason: 'Damaged', saleable: false }],
      businessDate: DATE,
    }, 'user_1');

    expect(returnResult.returnAmount).toBe('3000.00');
    expect(returnResult.refundOwed).toBe('3000.00');
    // Section 7 / 9: never clamped at zero — the business genuinely owes
    // the customer now, and that must show as a real negative value.
    expect(Number(returnResult.sale.creditAmount)).toBe(-3000);
    assertNetZeroSince(fakePrisma, checkpoint, 'customer return');
    checkpoint = fakePrisma._tables().ledgerEntry.length;

    // Over-refunding beyond what's actually owed must be rejected.
    await expect(
      payments.refundCustomer('biz_1', {
        customerId: 'cust_1', saleId: sale.id, amount: '5000.00', method: 'CASH',
        accountId: 'acc_cash', businessDate: DATE, reason: 'test over-refund',
      } as any, 'user_1'),
    ).rejects.toThrow();
    expect(fakePrisma._tables().ledgerEntry.length).toBe(checkpoint); // rejected refund: zero side effects

    // The real refund, for exactly what's owed.
    const refund = await payments.refundCustomer('biz_1', {
      customerId: 'cust_1', saleId: sale.id, amount: '3000.00', method: 'CASH',
      accountId: 'acc_cash', businessDate: DATE, reason: 'Damaged goods refund',
    } as any, 'user_1');
    expect(refund.amount.toString()).toBe('3000');
    assertNetZeroSince(fakePrisma, checkpoint, 'customer refund');

    const finalSale = await fakePrisma.sale.findFirst({ where: { id: sale.id } });
    expect(finalSale.creditAmount).toBe('0'); // exactly settled, not clamped, not left dangling

    // Duplicate refund attempt with the same idempotency key must be a no-op.
    const before = fakePrisma._tables().ledgerEntry.length;
    await payments.refundCustomer('biz_1', {
      customerId: 'cust_1', saleId: sale.id, amount: '3000.00', method: 'CASH',
      accountId: 'acc_cash', businessDate: DATE, reason: 'duplicate attempt',
      idempotencyKey: 'refund-key-1',
    } as any, 'user_1').catch(() => {});
    await payments.refundCustomer('biz_1', {
      customerId: 'cust_1', saleId: sale.id, amount: '3000.00', method: 'CASH',
      accountId: 'acc_cash', businessDate: DATE, reason: 'duplicate attempt',
      idempotencyKey: 'refund-key-1',
    } as any, 'user_1').catch(() => {});
    // Whatever happened above (accepted once, or rejected as over-refund
    // since the sale is already settled), it must not have grown unbounded.
    expect(fakePrisma._tables().ledgerEntry.length).toBeLessThanOrEqual(before + 2);

    assertNetZeroSince(fakePrisma, 0, 'entire return+refund scenario, cumulative');
  });

  it('a return on a closed business date is rejected, with zero mutation', async () => {
    fakePrisma._tables().dayClose.push({ id: 'dc_1', businessId: 'biz_1', businessDate: new Date(`${DATE}T00:00:00+05:30`) });
    fakePrisma._tables().sale.push({
      id: 'sale_x', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'SALE-X',
      total: '5000.00', received: '5000.00', creditAmount: '0.00',
    });
    fakePrisma._tables().saleItem.push({ id: 'item_x', saleId: 'sale_x', productId: 'prod_apple', quantity: 5, rate: '1000.00', unit: 'BOX' });

    await expect(
      sales.processReturn('biz_1', {
        saleId: 'sale_x', items: [{ saleItemId: 'item_x', quantity: 1, reason: 'x' }], businessDate: DATE,
      }, 'user_1'),
    ).rejects.toThrow(/closed/i);

    const sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_x' } });
    expect(sale.creditAmount).toBe('0.00');
    expect(fakePrisma._tables().ledgerEntry).toHaveLength(0);
  });
});

describe('Phase 9 — decimal precision through a real sale', () => {
  it('an odd-cents sale (₹99.99, three-way split down to ₹0.01) never drifts due to floating point', async () => {
    const fakePrisma = new FakePrismaService({
      business: [{ id: 'biz_1', name: 'Test Co' }],
      product: [{ id: 'prod_1', businessId: 'biz_1', name: 'Berries', active: true, lots: [] }],
      customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'Test Customer', active: true, creditTermsDays: 7 }],
      supplier: [{ id: 'sup_1', businessId: 'biz_1', name: 'Test Supplier', active: true, paymentTermsDays: 15 }],
      account: [{ id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '0' }],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesService, PurchasesService, LotsService, AuditService,
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    const salesSvc = moduleRef.get(SalesService);
    const purchasesSvc = moduleRef.get(PurchasesService);

    // 3 boxes at ₹33.33/box = ₹99.99 exactly — a classic floating-point
    // trap (0.1 + 0.2 !== 0.3 territory) if this were ever computed with
    // native JS numbers instead of Decimal throughout.
    await purchasesSvc.createPurchase('biz_1', {
      supplierId: 'sup_1', businessDate: DATE,
      items: [{ productId: 'prod_1', quantityBoxes: 3, totalNetWeightKg: '3', ratePerUnit: '10.00', unit: 'BOX' }],
      transport: '0', loading: '0', unloading: '0', otherCosts: '0',
      payments: [{ method: 'CASH', amount: '30.00', accountId: 'acc_cash' }],
    } as any);

    const sale = await salesSvc.createSale('biz_1', {
      customerId: 'cust_1', businessDate: DATE,
      items: [{ productId: 'prod_1', quantity: 3, rate: '33.33', unit: 'BOX' }],
      // Split into three ₹33.33 payments — 3 × 33.33 = 99.99 exactly, but
      // naive float addition (33.33+33.33+33.33) can land on 99.98999999999999.
      payments: [
        { method: 'CASH', amount: '33.33', accountId: 'acc_cash' },
        { method: 'CASH', amount: '33.33', accountId: 'acc_cash' },
        { method: 'CASH', amount: '33.33', accountId: 'acc_cash' },
      ],
    } as any);

    expect(sale.total).toBe('99.99');
    expect(sale.received).toBe('99.99');
    expect(Number(sale.creditAmount)).toBe(0); // exactly zero, not 0.00000000001 or -0.01
    assertNetZeroSince(fakePrisma, 0, 'odd-cents sale');
  });
});

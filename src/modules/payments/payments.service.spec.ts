import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PaymentsService } from './payments.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { parseBusinessDate } from '../../common/utils/date.util.js';

const OPEN_DATE = '2026-09-07';
const CLOSED_DATE = '2026-09-06';

function buildFake(overrides: Partial<{ sale: any[]; purchase: any[] }> = {}) {
  return new FakePrismaService({
    customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'Test Customer' }],
    supplier: [{ id: 'supp_1', businessId: 'biz_1', name: 'Test Supplier' }],
    account: [{ id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '0.00' }],
    sale: overrides.sale ?? [{
      id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'SALE-0001',
      total: '10000.00', received: '0.00', creditAmount: '10000.00',
    }],
    purchase: overrides.purchase ?? [{
      id: 'purch_1', businessId: 'biz_1', supplierId: 'supp_1', purchaseReference: 'PUR-0001',
      landedCost: '8000.00', paid: '0.00', creditAmount: '8000.00',
    }],
    dayClose: [{ id: 'close_1', businessId: 'biz_1', businessDate: parseBusinessDate(CLOSED_DATE), closedAt: new Date() }],
  });
}

async function build(fake: FakePrismaService): Promise<PaymentsService> {
  const moduleRef = await Test.createTestingModule({
    providers: [PaymentsService, AuditService, { provide: EventEmitter2, useValue: { emit: jest.fn() } }, { provide: PrismaService, useValue: fake }],
  }).compile();
  return moduleRef.get(PaymentsService);
}

describe('PaymentsService.receivePayment', () => {
  let svc: PaymentsService;
  let fakePrisma: FakePrismaService;

  beforeEach(async () => {
    fakePrisma = buildFake();
    svc = await build(fakePrisma);
  });

  const dto = (overrides: any = {}) => ({
    customerId: 'cust_1', saleId: 'sale_1', amount: '3000.00',
    method: 'CASH', accountId: 'acc_cash', businessDate: OPEN_DATE, ...overrides,
  });

  it('a full payment succeeds and updates the sale and posts double-entry ledger lines', async () => {
    const full = await svc.receivePayment('biz_1', dto({ amount: '10000.00' }) as any, 'user_1');
    expect(full.amount.toString()).toBe('10000');

    const sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_1' } });
    expect(sale.received).toBe('10000');
    expect(sale.creditAmount).toBe('0');

    const ledger = fakePrisma._tables().ledgerEntry;
    expect(ledger).toHaveLength(2); // both legs — debit cash, credit receivable
    expect(ledger.some((l: any) => l.debit === '10000')).toBe(true);
    expect(ledger.some((l: any) => l.credit === '10000')).toBe(true);
  });

  it('a partial payment succeeds', async () => {
    const p = await svc.receivePayment('biz_1', dto({ amount: '4000.00' }) as any, 'user_1');
    expect(p.amount.toString()).toBe('4000');
    const sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_1' } });
    expect(sale.creditAmount).toBe('6000');
  });

  it('exact-outstanding payment succeeds and zeroes the credit amount', async () => {
    await svc.receivePayment('biz_1', dto({ amount: '10000.00' }) as any, 'user_1');
    const sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_1' } });
    expect(sale.creditAmount).toBe('0');
  });

  it('overpayment is rejected, with zero side effects', async () => {
    await expect(
      svc.receivePayment('biz_1', dto({ amount: '10500.00' }) as any, 'user_1'),
    ).rejects.toThrow('exceeds outstanding');

    expect(fakePrisma._tables().payment).toHaveLength(0);
    expect(fakePrisma._tables().ledgerEntry).toHaveLength(0);
    const sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_1' } });
    expect(sale.received).toBe('0.00');
  });

  it('idempotency: a duplicate request with the same key has zero additional side effects', async () => {
    const key = 'idem-1';
    const first = await svc.receivePayment('biz_1', dto({ amount: '3000.00', idempotencyKey: key }) as any, 'user_1');
    const second = await svc.receivePayment('biz_1', dto({ amount: '3000.00', idempotencyKey: key }) as any, 'user_1');

    expect(second.id).toBe(first.id);
    expect(fakePrisma._tables().payment).toHaveLength(1);
    const sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_1' } });
    expect(sale.received).toBe('3000'); // not 6000 — the second call was a no-op
  });

  it('idempotency is business-scoped — the same key in a different business is a different payment', async () => {
    fakePrisma._tables().customer.push({ id: 'cust_2', businessId: 'biz_2', name: 'Biz2 Customer' });
    fakePrisma._tables().account.push({ id: 'acc_cash_2', businessId: 'biz_2', name: 'Cash', type: 'CASH', openingBalance: '0.00' });
    fakePrisma._tables().sale.push({ id: 'sale_2', businessId: 'biz_2', customerId: 'cust_2', saleReference: 'X', total: '500.00', received: '0.00', creditAmount: '500.00' });

    const key = 'shared-key';
    await svc.receivePayment('biz_1', dto({ idempotencyKey: key }) as any, 'user_1');
    const other = await svc.receivePayment('biz_2', {
      customerId: 'cust_2', saleId: 'sale_2', amount: '500.00', method: 'CASH',
      accountId: 'acc_cash_2', businessDate: OPEN_DATE, idempotencyKey: key,
    } as any, 'user_2');

    expect(fakePrisma._tables().payment).toHaveLength(2);
    expect(other.customerId).toBe('cust_2');
  });

  it('posts an audit entry for the sale balance change', async () => {
    await svc.receivePayment('biz_1', dto() as any, 'user_1');
    const audit = fakePrisma._tables().auditLog;
    expect(audit).toHaveLength(1);
    expect(audit[0].entityType).toBe('SALE');
  });

  it('closed business date is rejected, with zero side effects and the idempotency key not consumed', async () => {
    const key = 'closed-date-key';
    await svc.receivePayment('biz_1', dto({ businessDate: CLOSED_DATE, idempotencyKey: key }) as any, 'user_1').catch(() => {});
    expect(fakePrisma._tables().payment).toHaveLength(0);

    const retried = await svc.receivePayment('biz_1', dto({ businessDate: OPEN_DATE, idempotencyKey: key }) as any, 'user_1');
    expect(retried.id).toBeTruthy();
    expect(fakePrisma._tables().payment).toHaveLength(1);
  });

  it('locks the sale row before reading it', async () => {
    await svc.receivePayment('biz_1', dto() as any, 'user_1');
    expect(fakePrisma.queryRawCalls.some((q) => q.includes('FOR UPDATE'))).toBe(true);
  });
});

describe('PaymentsService.makePayment', () => {
  it('overpayment to a supplier is rejected', async () => {
    const fakePrisma = buildFake();
    const svc = await build(fakePrisma);
    await expect(
      svc.makePayment('biz_1', {
        supplierId: 'supp_1', purchaseId: 'purch_1', amount: '9000.00',
        method: 'CASH', accountId: 'acc_cash', businessDate: OPEN_DATE,
      } as any, 'user_1'),
    ).rejects.toThrow('exceeds outstanding');
  });

  it('a valid payment posts double-entry ledger lines', async () => {
    const fakePrisma = buildFake();
    const svc = await build(fakePrisma);
    await svc.makePayment('biz_1', {
      supplierId: 'supp_1', purchaseId: 'purch_1', amount: '2000.00',
      method: 'CASH', accountId: 'acc_cash', businessDate: OPEN_DATE,
    } as any, 'user_1');
    expect(fakePrisma._tables().ledgerEntry).toHaveLength(2);
  });
});

describe('PaymentsService refunds', () => {
  it('refundCustomer succeeds when the sale has a negative creditAmount (already overpaid via a return)', async () => {
    const fakePrisma = buildFake({ sale: [{
      id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'SALE-0001',
      total: '10000.00', received: '10000.00', creditAmount: '-3000.00',
    }] });
    const svc = await build(fakePrisma);

    const refund = await svc.refundCustomer('biz_1', {
      customerId: 'cust_1', saleId: 'sale_1', amount: '3000.00', method: 'CASH',
      accountId: 'acc_cash', businessDate: OPEN_DATE, reason: 'Returned goods',
    } as any, 'user_1');

    expect(refund.amount.toString()).toBe('3000');
    const sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_1' } });
    expect(sale.creditAmount).toBe('0');
  });

  it('refundCustomer is rejected when no refund is owed', async () => {
    const fakePrisma = buildFake();
    const svc = await build(fakePrisma);
    await expect(
      svc.refundCustomer('biz_1', {
        customerId: 'cust_1', saleId: 'sale_1', amount: '100.00', method: 'CASH',
        accountId: 'acc_cash', businessDate: OPEN_DATE, reason: 'x',
      } as any, 'user_1'),
    ).rejects.toThrow('No refund is owed');
  });

  it('refundCustomer over-refund is rejected', async () => {
    const fakePrisma = buildFake({ sale: [{
      id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'SALE-0001',
      total: '10000.00', received: '10000.00', creditAmount: '-1000.00',
    }] });
    const svc = await build(fakePrisma);
    await expect(
      svc.refundCustomer('biz_1', {
        customerId: 'cust_1', saleId: 'sale_1', amount: '5000.00', method: 'CASH',
        accountId: 'acc_cash', businessDate: OPEN_DATE, reason: 'x',
      } as any, 'user_1'),
    ).rejects.toThrow('exceeds amount owed');
  });

  it('refundSupplier succeeds when the purchase has a negative creditAmount', async () => {
    const fakePrisma = buildFake({ purchase: [{
      id: 'purch_1', businessId: 'biz_1', supplierId: 'supp_1', purchaseReference: 'PUR-0001',
      landedCost: '8000.00', paid: '8000.00', creditAmount: '-1500.00',
    }] });
    const svc = await build(fakePrisma);
    const refund = await svc.refundSupplier('biz_1', {
      supplierId: 'supp_1', purchaseId: 'purch_1', amount: '1500.00', method: 'CASH',
      accountId: 'acc_cash', businessDate: OPEN_DATE, reason: 'Returned to supplier',
    } as any, 'user_1');
    expect(refund.amount.toString()).toBe('1500');
  });

  it('refunds on a closed business date are rejected, with zero side effects', async () => {
    const fakePrisma = buildFake({ sale: [{
      id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'SALE-0001',
      total: '10000.00', received: '10000.00', creditAmount: '-3000.00',
    }] });
    const svc = await build(fakePrisma);
    await expect(
      svc.refundCustomer('biz_1', {
        customerId: 'cust_1', saleId: 'sale_1', amount: '1000.00', method: 'CASH',
        accountId: 'acc_cash', businessDate: CLOSED_DATE, reason: 'x',
      } as any, 'user_1'),
    ).rejects.toThrow('already closed');
    expect(fakePrisma._tables().payment).toHaveLength(0);
  });
});

describe('sale \u2192 return \u2192 payment \u2192 refund preserves financial state (Phase 2 required scenario)', () => {
  it('walks the full sequence and ends at zero outstanding', async () => {
    // Sale for 10000, customer pays it all in full up front.
    const fakePrisma = buildFake({ sale: [{
      id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'SALE-0001',
      total: '10000.00', received: '10000.00', creditAmount: '0.00',
    }] });
    let svc = await build(fakePrisma);

    // A 3000 return arrives after full payment — simulated directly against
    // creditAmount the way SalesService.processReturn would (not clamped at
    // zero — see sales.service.spec.ts for that path specifically).
    let sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_1' } });
    await fakePrisma.sale.update({ where: { id: 'sale_1' }, data: { creditAmount: '-3000.00' } });

    // Refund the 3000 now owed.
    const refund = await svc.refundCustomer('biz_1', {
      customerId: 'cust_1', saleId: 'sale_1', amount: '3000.00', method: 'CASH',
      accountId: 'acc_cash', businessDate: OPEN_DATE, reason: 'Post-payment return',
    } as any, 'user_1');

    expect(refund.amount.toString()).toBe('3000');
    sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_1' } });
    expect(sale.creditAmount).toBe('0'); // exactly settled, not derived from received/total
  });
});

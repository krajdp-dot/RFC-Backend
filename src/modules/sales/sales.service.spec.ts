import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SalesService } from './sales.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { LotsService } from '../lots/lots.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { parseBusinessDate } from '../../common/utils/date.util.js';

const OPEN_DATE = '2026-09-07';
const CLOSED_DATE = '2026-09-06';

/**
 * Phase 11 — createSale is the flagship offline mutation (architecture doc,
 * "Sales — primary offline workflow"). These tests exist to prove, directly
 * against createSale itself, the two guarantees the offline sync engine is
 * built to rely on:
 *   1. a retried mutationId (sent as idempotencyKey) never creates a second
 *      sale or double-decrements stock — same guarantee already proven for
 *      receivePayment in payments.service.spec.ts, proven here too because
 *      createSale is the one queued while literally standing in the mandi;
 *   2. running out of stock between "saved offline" and "synced" surfaces
 *      as a `code` the client can switch on, not just a message string.
 */
describe('SalesService.createSale — Phase 11 idempotency & conflict codes', () => {
  let salesService: SalesService;
  let fakePrisma: FakePrismaService;

  function buildFake(lotOverrides: any[] = []) {
    return new FakePrismaService({
      customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'ABC Fruits', active: true }],
      account: [{ id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '0' }],
      lot: lotOverrides.length ? lotOverrides : [{
        id: 'lot_1', businessId: 'biz_1', productId: 'prod_1', status: 'ACTIVE',
        remainingBoxes: 20, totalBoxes: 20, remainingNetWeightKg: '200', totalNetWeightKg: '200',
        costPerBox: '1200.00', costPerKg: '120.00', freshnessScore: 90, receivedDate: new Date('2026-09-01'),
      }],
    });
  }

  async function build(fake: FakePrismaService) {
    fakePrisma = fake;
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesService, AuditService, { provide: EventEmitter2, useValue: { emit: jest.fn() } }, LotsService,
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    salesService = moduleRef.get(SalesService);
  }

  const dto = (overrides: any = {}) => ({
    customerId: 'cust_1',
    businessDate: OPEN_DATE,
    items: [{ productId: 'prod_1', quantity: 3, unit: 'BOX', rate: '2050.00' }],
    payments: [{ method: 'CASH', amount: '6150.00', accountId: 'acc_cash' }],
    ...overrides,
  });

  it('a retried mutationId returns the original sale — no duplicate, no double stock deduction', async () => {
    await build(buildFake());
    const key = 'mutation-abc-123';

    const first = await salesService.createSale('biz_1', dto({ idempotencyKey: key }) as any);
    const second = await salesService.createSale('biz_1', dto({ idempotencyKey: key }) as any);

    expect(second.id).toBe(first.id);
    expect(fakePrisma._tables().sale).toHaveLength(1);

    const lot = await fakePrisma.lot.findFirst({ where: { id: 'lot_1' } });
    expect(lot.remainingBoxes).toBe(17); // 20 - 3, deducted exactly once
  });

  it('a retry with the same key ignores a changed payload — the original result wins, per Section 9', async () => {
    await build(buildFake());
    const key = 'mutation-xyz';

    const first = await salesService.createSale('biz_1', dto({ idempotencyKey: key, notes: 'first attempt' }) as any);
    const second = await salesService.createSale(
      'biz_1',
      dto({ idempotencyKey: key, notes: 'a completely different note' }) as any,
    );

    expect(second.id).toBe(first.id);
    expect(second.notes).toBe('first attempt');
  });

  it('running out of stock surfaces code INSUFFICIENT_STOCK, not just a message', async () => {
    await build(buildFake([{
      id: 'lot_1', businessId: 'biz_1', productId: 'prod_1', status: 'ACTIVE',
      remainingBoxes: 1, totalBoxes: 20, remainingNetWeightKg: '10', totalNetWeightKg: '200',
      costPerBox: '1200.00', costPerKg: '120.00', freshnessScore: 90, receivedDate: new Date('2026-09-01'),
    }]));

    await expect(salesService.createSale('biz_1', dto({ items: [{ productId: 'prod_1', quantity: 3, unit: 'BOX', rate: '2050.00' }] }) as any))
      .rejects.toMatchObject({ response: { code: 'INSUFFICIENT_STOCK' } });

    // Zero side effects — the one lot's stock was not touched.
    const lot = await fakePrisma.lot.findFirst({ where: { id: 'lot_1' } });
    expect(lot.remainingBoxes).toBe(1);
    expect(fakePrisma._tables().sale).toHaveLength(0);
  });

  it('an unrelated validation failure (bad customer) is untouched by the code change — still a plain 400', async () => {
    await build(buildFake());
    await expect(salesService.createSale('biz_1', dto({ customerId: 'no-such-customer' }) as any))
      .rejects.toThrow('Invalid customer');
  });
});

describe('SalesService.processReturn', () => {
  let salesService: SalesService;
  let fakePrisma: FakePrismaService;

  async function build(saleOverrides: any = {}) {
    fakePrisma = new FakePrismaService({
      sale: [{
        id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'SALE-0001',
        total: '10000.00', received: '10000.00', creditAmount: '0.00',
        ...saleOverrides,
      }],
      saleItem: [{ id: 'item_1', saleId: 'sale_1', productId: 'prod_1', quantity: 10, rate: '500.00', unit: 'BOX' }],
      account: [{ id: 'acc_receivable', businessId: 'biz_1', name: 'Receivables', type: 'CUSTOMER_RECEIVABLE', openingBalance: '0' }],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesService, AuditService, { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: PrismaService, useValue: fakePrisma },
        { provide: LotsService, useValue: {} },
      ],
    }).compile();
    salesService = moduleRef.get(SalesService);
  }

  beforeEach(async () => { await build(); });

  it('a return on an already-fully-paid sale leaves a negative creditAmount (refund owed), not clamped to zero', async () => {
    const result = await salesService.processReturn('biz_1', {
      saleId: 'sale_1',
      items: [{ saleItemId: 'item_1', quantity: 6, reason: 'Quality issue', saleable: false }],
    } as any, 'user_1');

    const sale = await fakePrisma.sale.findFirst({ where: { id: 'sale_1' } });
    expect(sale.creditAmount).toBe('-3000'); // 6 * 500, negative — money now owed back
    expect((result as any).refundOwed).toBe('3000.00');
  });

  it('locks the sale row before reading it', async () => {
    await salesService.processReturn('biz_1', {
      saleId: 'sale_1',
      items: [{ saleItemId: 'item_1', quantity: 1, reason: 'x', saleable: false }],
    } as any, 'user_1');
    expect(fakePrisma.queryRawCalls.some((q) => q.includes('FOR UPDATE'))).toBe(true);
  });

  it('writes an audit entry for the creditAmount change', async () => {
    await salesService.processReturn('biz_1', {
      saleId: 'sale_1',
      items: [{ saleItemId: 'item_1', quantity: 2, reason: 'x', saleable: false }],
    } as any, 'user_1');
    const audit = fakePrisma._tables().auditLog;
    expect(audit).toHaveLength(1);
    expect(audit[0].entityType).toBe('SALE');
  });
});

describe('SalesService — closed business date (Phase 4)', () => {
  let salesService: SalesService;
  let fakePrisma: FakePrismaService;

  const seedLot = {
    id: 'lot_1', businessId: 'biz_1', productId: 'prod_1',
    remainingBoxes: 20, totalNetWeightKg: '200.00', remainingNetWeightKg: '200.00',
    costPerBox: '300.00', status: 'ACTIVE',
  };
  const lotsServiceStub = { getFEFOLots: jest.fn().mockResolvedValue([{ ...seedLot }]) };

  async function build() {
    fakePrisma = new FakePrismaService({
      customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'Test Customer', active: true }],
      lot: [{ ...seedLot }],
      dayClose: [{ id: 'close_1', businessId: 'biz_1', businessDate: parseBusinessDate(CLOSED_DATE), closedAt: new Date() }],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        SalesService, AuditService, { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: PrismaService, useValue: fakePrisma },
        { provide: LotsService, useValue: lotsServiceStub },
      ],
    }).compile();
    salesService = moduleRef.get(SalesService);
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    lotsServiceStub.getFEFOLots.mockResolvedValue([{ ...seedLot }]);
    await build();
  });

  const saleDto = (businessDate: string) => ({
    customerId: 'cust_1', businessDate,
    items: [{ productId: 'prod_1', quantity: 5, rate: '500.00', unit: 'BOX' }],
    payments: [],
  });

  it('a sale on an open date succeeds', async () => {
    const sale = await salesService.createSale('biz_1', saleDto(OPEN_DATE) as any);
    expect(fakePrisma._tables().sale).toHaveLength(1);
  });

  it('a sale on a closed date is rejected with zero side effects', async () => {
    await expect(salesService.createSale('biz_1', saleDto(CLOSED_DATE) as any))
      .rejects.toThrow(`Business date ${CLOSED_DATE} is already closed`);
    expect(fakePrisma._tables().sale).toHaveLength(0);
    expect(fakePrisma._tables().inventoryMovement).toHaveLength(0);
  });

  it('bulkLotSale on a closed date is rejected with zero lot mutation', async () => {
    fakePrisma._tables().lot = [{ ...seedLot, product: { primaryUnit: 'BOX' } }];
    await expect(
      salesService.bulkLotSale('biz_1', { lotId: 'lot_1', businessDate: CLOSED_DATE, allocations: [{ customerId: 'cust_1', quantity: 3, rate: '500.00' }] } as any),
    ).rejects.toThrow('already closed');
    expect(fakePrisma._tables().lot[0].remainingBoxes).toBe(20);
  });
});

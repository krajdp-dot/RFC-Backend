import { Test } from '@nestjs/testing';
import { PurchasesService } from './purchases.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { parseBusinessDate } from '../../common/utils/date.util.js';

const OPEN_DATE = '2026-09-07';
const CLOSED_DATE = '2026-09-06';

describe('PurchasesService.processPurchaseReturn', () => {
  let purchasesService: PurchasesService;
  let fakePrisma: FakePrismaService;

  beforeEach(async () => {
    fakePrisma = new FakePrismaService({
      purchase: [{
        id: 'purch_1', businessId: 'biz_1', supplierId: 'supp_1', purchaseReference: 'PUR-0001',
        landedCost: '8000.00', paid: '8000.00', creditAmount: '0.00',
        items: [{ id: 'item_1', productId: 'prod_1', quantityBoxes: 10, ratePerUnit: '80.00' }],
      }],
      account: [{ id: 'acc_payable', businessId: 'biz_1', name: 'Payables', type: 'SUPPLIER_PAYABLE', openingBalance: '0' }],
      lot: [{ id: 'lot_1', businessId: 'biz_1', purchaseId: 'purch_1', productId: 'prod_1', costPerBox: '80.00', remainingBoxes: 10, status: 'ACTIVE' }],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [PurchasesService, AuditService, { provide: PrismaService, useValue: fakePrisma }],
    }).compile();
    purchasesService = moduleRef.get(PurchasesService);
  });

  it('a return on an already-fully-paid purchase leaves a negative creditAmount (refund owed)', async () => {
    const result = await purchasesService.processPurchaseReturn('biz_1', {
      purchaseId: 'purch_1',
      items: [{ purchaseItemId: 'item_1', productId: 'prod_1', quantity: 3, reason: 'Damaged in transit' }],
    } as any, 'user_1');

    const purchase = await fakePrisma.purchase.findFirst({ where: { id: 'purch_1' } });
    expect(purchase.creditAmount).toBe('-240'); // 3 * 80, negative
    expect((result as any).refundOwed).toBe('240.00');
  });

  it('locks the purchase row and writes an audit entry', async () => {
    await purchasesService.processPurchaseReturn('biz_1', {
      purchaseId: 'purch_1',
      items: [{ purchaseItemId: 'item_1', productId: 'prod_1', quantity: 1, reason: 'x' }],
    } as any, 'user_1');
    expect(fakePrisma.queryRawCalls.some((q) => q.includes('FOR UPDATE'))).toBe(true);
    expect(fakePrisma._tables().auditLog).toHaveLength(1);
  });
});

describe('PurchasesService.createPurchase — closed business date (Phase 4)', () => {
  let purchasesService: PurchasesService;
  let fakePrisma: FakePrismaService;

  beforeEach(async () => {
    fakePrisma = new FakePrismaService({
      supplier: [{ id: 'supp_1', businessId: 'biz_1', name: 'Test Supplier', active: true }],
      product: [{ id: 'prod_1', businessId: 'biz_1', name: 'Apple' }],
      dayClose: [{ id: 'close_1', businessId: 'biz_1', businessDate: parseBusinessDate(CLOSED_DATE), closedAt: new Date() }],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [PurchasesService, AuditService, { provide: PrismaService, useValue: fakePrisma }],
    }).compile();
    purchasesService = moduleRef.get(PurchasesService);
  });

  const dto = (businessDate: string) => ({
    supplierId: 'supp_1', businessDate,
    items: [{ productId: 'prod_1', quantityBoxes: 10, ratePerUnit: '100.00', totalNetWeightKg: 100, unit: 'BOX' }],
    payments: [],
  });

  it('a purchase on an open date succeeds', async () => {
    await purchasesService.createPurchase('biz_1', dto(OPEN_DATE) as any);
    expect(fakePrisma._tables().purchase).toHaveLength(1);
  });

  it('a purchase on a closed date is rejected with zero side effects', async () => {
    await expect(purchasesService.createPurchase('biz_1', dto(CLOSED_DATE) as any))
      .rejects.toThrow(`Business date ${CLOSED_DATE} is already closed`);
    expect(fakePrisma._tables().purchase).toHaveLength(0);
    expect(fakePrisma._tables().lot).toHaveLength(0);
  });
});

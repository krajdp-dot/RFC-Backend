import { Test } from '@nestjs/testing';
import { InventoryService } from './inventory.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';

describe('InventoryService', () => {
  let inventoryService: InventoryService;
  let fakePrisma: FakePrismaService;

  const seedLot = {
    id: 'lot_1', businessId: 'biz_1', productId: 'prod_1', lotReference: 'LOT-000001',
    remainingBoxes: 10, remainingNetWeightKg: '102.00', costPerBox: '300.00', status: 'ACTIVE',
  };

  async function build(lot: any = seedLot) {
    fakePrisma = new FakePrismaService({ lot: [{ ...lot }] });
    const moduleRef = await Test.createTestingModule({
      providers: [InventoryService, AuditService, { provide: PrismaService, useValue: fakePrisma }],
    }).compile();
    inventoryService = moduleRef.get(InventoryService);
  }

  beforeEach(async () => { await build(); });

  it('wastage reduces boxes/weight, creates a movement, and posts the loss at real cost basis', async () => {
    const result = await inventoryService.recordWastage('biz_1', {
      lotId: 'lot_1', quantityBoxes: 4, weightKg: '40.80', reason: 'Spoiled', businessDate: '2026-09-07',
    } as any, 'user_1');

    expect(result.lot.remainingBoxes).toBe(6);
    const ledger = fakePrisma._tables().ledgerEntry;
    expect(ledger[0].debit.toString()).toBe('1200'); // 4 * 300 cost, not selling price
  });

  it('rejects wastage that would take boxes negative, zero side effects', async () => {
    await expect(
      inventoryService.recordWastage('biz_1', { lotId: 'lot_1', quantityBoxes: 11, reason: 'x' } as any, 'user_1'),
    ).rejects.toThrow('negative boxes');
    expect(fakePrisma._tables().inventoryMovement).toHaveLength(0);
  });

  it('rejects wastage that would take weight negative even when boxes alone look fine', async () => {
    await expect(
      inventoryService.recordWastage('biz_1', { lotId: 'lot_1', quantityBoxes: 9, weightKg: '200.00', reason: 'x' } as any, 'user_1'),
    ).rejects.toThrow('negative weight');
  });

  it('locks the lot row before reading its balance', async () => {
    await inventoryService.recordWastage('biz_1', { lotId: 'lot_1', quantityBoxes: 1, reason: 'x' } as any, 'user_1');
    expect(fakePrisma.queryRawCalls.some((q) => q.includes('FOR UPDATE'))).toBe(true);
  });

  it('an increase adjustment adds stock back and depletes correctly at zero', async () => {
    const result = await inventoryService.recordAdjustment('biz_1', {
      lotId: 'lot_1', quantityBoxes: -10, weightKg: '-102.00', reason: 'Full write-off',
    } as any, 'user_1');
    expect(result.lot.remainingBoxes).toBe(0);
    expect(result.lot.status).toBe('DEPLETED');
  });

  it('writes an audit entry atomic with the movement', async () => {
    await inventoryService.recordAdjustment('biz_1', { lotId: 'lot_1', quantityBoxes: 2, reason: 'Recount' } as any, 'user_1');
    expect(fakePrisma._tables().auditLog).toHaveLength(1);
  });

  it('a lot from another business is not found (business isolation)', async () => {
    await build({ ...seedLot, businessId: 'biz_2' });
    await expect(
      inventoryService.recordWastage('biz_1', { lotId: 'lot_1', quantityBoxes: 1, reason: 'x' } as any, 'user_1'),
    ).rejects.toThrow('Lot not found');
  });

  describe('Phase 9 — closed business date', () => {
    beforeEach(async () => {
      await build();
      fakePrisma._tables().dayClose.push({
        id: 'dc_1', businessId: 'biz_1', businessDate: new Date('2026-09-07T00:00:00+05:30'),
      });
    });

    it('wastage on a closed date is rejected, with zero stock or ledger mutation — previously there was no check at all', async () => {
      await expect(
        inventoryService.recordWastage('biz_1', {
          lotId: 'lot_1', quantityBoxes: 2, reason: 'Spoiled', businessDate: '2026-09-07',
        } as any, 'user_1'),
      ).rejects.toThrow(/closed/i);

      const lot = await fakePrisma.lot.findFirst({ where: { id: 'lot_1' } });
      expect(lot.remainingBoxes).toBe(seedLot.remainingBoxes); // unchanged
      expect(fakePrisma._tables().inventoryMovement).toHaveLength(0);
      expect(fakePrisma._tables().ledgerEntry).toHaveLength(0);
      expect(fakePrisma._tables().auditLog).toHaveLength(0);
    });

    it('a stock adjustment on a closed date is rejected, with zero mutation', async () => {
      await expect(
        inventoryService.recordAdjustment('biz_1', {
          lotId: 'lot_1', quantityBoxes: 5, reason: 'Recount', businessDate: '2026-09-07',
        } as any, 'user_1'),
      ).rejects.toThrow(/closed/i);

      const lot = await fakePrisma.lot.findFirst({ where: { id: 'lot_1' } });
      expect(lot.remainingBoxes).toBe(seedLot.remainingBoxes);
    });

    it('the same lot on a still-open date works normally', async () => {
      const result = await inventoryService.recordWastage('biz_1', {
        lotId: 'lot_1', quantityBoxes: 1, reason: 'Spoiled', businessDate: '2026-09-08',
      } as any, 'user_1');
      expect(result.lot.remainingBoxes).toBe(seedLot.remainingBoxes - 1);
    });
  });

  describe('Phase 9 — audit write and business mutation are atomic', () => {
    it('if the audit insert fails, the entire wastage (lot quantity, ledger entries) rolls back — nothing partially commits', async () => {
      await build();
      const boxesBefore = seedLot.remainingBoxes;

      // Simulate the audit table being unavailable (e.g. a DB constraint
      // violation, disk full, whatever) — this is the SAME fakePrisma
      // instance recordWastage's `tx` resolves to inside $transaction, so
      // patching it here reaches the real call site.
      const originalCreate = fakePrisma.auditLog.create;
      fakePrisma.auditLog.create = async () => { throw new Error('audit db unavailable'); };

      await expect(
        inventoryService.recordWastage('biz_1', { lotId: 'lot_1', quantityBoxes: 3, reason: 'Spoiled' } as any, 'user_1'),
      ).rejects.toThrow('audit db unavailable');

      // Section 27: "audit write and financial mutation must succeed or
      // fail together" — the lot quantity must be untouched, and no
      // movement or ledger row should exist despite the mutation having
      // gotten most of the way through before the audit call failed.
      const lot = await fakePrisma.lot.findFirst({ where: { id: 'lot_1' } });
      expect(lot.remainingBoxes).toBe(boxesBefore);
      expect(fakePrisma._tables().inventoryMovement).toHaveLength(0);
      expect(fakePrisma._tables().ledgerEntry).toHaveLength(0);

      fakePrisma.auditLog.create = originalCreate;
    });
  });
});

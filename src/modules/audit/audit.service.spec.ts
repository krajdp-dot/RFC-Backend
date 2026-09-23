import { Test } from '@nestjs/testing';
import { AuditService } from './audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';

describe('AuditService', () => {
  let auditService: AuditService;
  let fakePrisma: FakePrismaService;

  beforeEach(async () => {
    fakePrisma = new FakePrismaService();
    const moduleRef = await Test.createTestingModule({
      providers: [AuditService, { provide: PrismaService, useValue: fakePrisma }],
    }).compile();
    auditService = moduleRef.get(AuditService);
  });

  it('writes before/after/reason as real columns, not a combined blob', async () => {
    await auditService.record(fakePrisma, {
      businessId: 'biz_1', userId: 'user_1', action: 'UPDATE',
      entityType: 'ACCOUNT', entityId: 'acc_1',
      before: { x: 1 }, after: { x: 2 }, reason: 'test',
    });
    const row = fakePrisma._tables().auditLog[0];
    expect(row.before).toEqual({ x: 1 });
    expect(row.after).toEqual({ x: 2 });
    expect(row.reason).toBe('test');
  });

  it('record() called with a tx makes the write atomic with the caller\u2019s transaction', async () => {
    await expect(
      fakePrisma.$transaction(async (tx: any) => {
        await auditService.record(tx, {
          businessId: 'biz_1', action: 'CREATE', entityType: 'X', entityId: '1',
        });
        throw new Error('simulated failure after the audit write');
      }),
    ).rejects.toThrow('simulated failure');

    expect(fakePrisma._tables().auditLog).toHaveLength(0); // rolled back together
  });

  it('findAll orders by timestamp (the real column) and is business-scoped', async () => {
    fakePrisma._tables().auditLog.push(
      { id: 'a1', businessId: 'biz_1', entityType: 'X', entityId: '1', timestamp: new Date('2026-01-01') },
      { id: 'a2', businessId: 'biz_1', entityType: 'X', entityId: '1', timestamp: new Date('2026-02-01') },
      { id: 'a3', businessId: 'biz_2', entityType: 'X', entityId: '1', timestamp: new Date('2026-03-01') },
    );
    const result = await auditService.findAll('biz_1');
    expect(result.data).toHaveLength(2);
    expect(result.data[0].id).toBe('a2'); // most recent first
  });
});

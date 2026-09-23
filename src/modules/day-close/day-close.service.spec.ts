import { Test } from '@nestjs/testing';
import { DayCloseService } from './day-close.service.js';
import { AuditService } from '../audit/audit.service.js';
import { ReconciliationService } from '../reconciliation/reconciliation.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { parseBusinessDate } from '../../common/utils/date.util.js';

const DATE = '2026-09-07';

describe('DayCloseService.performDayClose', () => {
  let dayCloseService: DayCloseService;
  let fakePrisma: FakePrismaService;

  beforeEach(async () => {
    fakePrisma = new FakePrismaService({
      account: [{ id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '1000.00' }],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        DayCloseService, AuditService, ReconciliationService,
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    dayCloseService = moduleRef.get(DayCloseService);
  });

  it('computes expected cash from CASH-account ledger movements only — a bank payment does not affect it', async () => {
    fakePrisma._tables().account.push({ id: 'acc_bank', businessId: 'biz_1', name: 'Bank', type: 'BANK', openingBalance: '0' });
    fakePrisma._tables().ledgerEntry.push(
      { id: 'l1', businessId: 'biz_1', accountId: 'acc_cash', transactionType: 'CUSTOMER_PAYMENT', debit: '500.00', credit: '0', businessDate: parseBusinessDate(DATE) },
      { id: 'l2', businessId: 'biz_1', accountId: 'acc_bank', transactionType: 'CUSTOMER_PAYMENT', debit: '2000.00', credit: '0', businessDate: parseBusinessDate(DATE) },
    );
    const result = await dayCloseService.performDayClose('biz_1', { businessDate: DATE }, 'user_1');
    expect((result as any).breakdown.expectedClosingCash).toBe('1500.00'); // 1000 opening + 500 cash-only, NOT +2000 bank
  });

  it('one close per business date — a second close for the same date is rejected', async () => {
    await dayCloseService.performDayClose('biz_1', { businessDate: DATE }, 'user_1');
    await expect(dayCloseService.performDayClose('biz_1', { businessDate: DATE }, 'user_1'))
      .rejects.toThrow('already closed');
  });

  it('business isolation: business B can close the same calendar date independently', async () => {
    fakePrisma._tables().account.push({ id: 'acc_cash_2', businessId: 'biz_2', name: 'Cash', type: 'CASH', openingBalance: '0' });
    await dayCloseService.performDayClose('biz_1', { businessDate: DATE }, 'user_1');
    await expect(dayCloseService.performDayClose('biz_2', { businessDate: DATE }, 'user_2')).resolves.toBeDefined();
  });

  it('writes an audit entry atomically with the close', async () => {
    await dayCloseService.performDayClose('biz_1', { businessDate: DATE }, 'user_1');
    const audit = fakePrisma._tables().auditLog;
    expect(audit).toHaveLength(1);
    expect(audit[0].entityType).toBe('DAY_CLOSE');
  });

  it('surfaces reconciliation warnings for a negative account balance', async () => {
    fakePrisma._tables().account.push({ id: 'acc_neg', businessId: 'biz_1', name: 'Weird', type: 'BANK', openingBalance: '-500' });
    const result = await dayCloseService.performDayClose('biz_1', { businessDate: DATE }, 'user_1');
    expect((result as any).reconciliationWarnings.some((w: any) => w.name === 'Account Balances')).toBe(true);
  });

  it('takes the EXCLUSIVE advisory lock, not the shared variant', async () => {
    await dayCloseService.performDayClose('biz_1', { businessDate: DATE }, 'user_1');
    expect(fakePrisma.queryRawCalls.some((q) => q.includes('pg_advisory_xact_lock('))).toBe(true);
    expect(fakePrisma.queryRawCalls.some((q) => q.includes('pg_advisory_xact_lock_shared('))).toBe(false);
  });
});

describe('DayCloseService.previewDayClose', () => {
  let dayCloseService: DayCloseService;
  let fakePrisma: FakePrismaService;

  beforeEach(async () => {
    fakePrisma = new FakePrismaService({
      account: [{ id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '1000.00' }],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        DayCloseService, AuditService, ReconciliationService,
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    dayCloseService = moduleRef.get(DayCloseService);
  });

  it('matches what an actual close would produce, and writes nothing', async () => {
    fakePrisma._tables().ledgerEntry.push(
      { id: 'l1', businessId: 'biz_1', accountId: 'acc_cash', transactionType: 'CUSTOMER_PAYMENT', debit: '500.00', credit: '0', businessDate: parseBusinessDate(DATE) },
    );

    const preview: any = await dayCloseService.previewDayClose('biz_1', DATE, null);
    expect(preview.alreadyClosed).toBe(false);
    expect(preview.breakdown.expectedClosingCash).toBe('1500.00');
    expect(fakePrisma._tables().dayClose).toHaveLength(0);

    const actual: any = await dayCloseService.performDayClose('biz_1', { businessDate: DATE }, 'user_1');
    expect(actual.breakdown.expectedClosingCash).toBe(preview.breakdown.expectedClosingCash);
    // actual.salesTotal is a Decimal instance (as stored via tx.dayClose.create),
    // preview.salesTotal is a formatted string (toMoneyString) — compare by value.
    expect(Number(actual.salesTotal)).toBe(Number(preview.salesTotal));
  });

  it('an already-closed date reports alreadyClosed with the existing record, not a fresh calculation', async () => {
    await dayCloseService.performDayClose('biz_1', { businessDate: DATE, physicalCash: 1500 }, 'user_1');
    const preview: any = await dayCloseService.previewDayClose('biz_1', DATE, null);
    expect(preview.alreadyClosed).toBe(true);
    expect(preview.existing).toBeDefined();
    expect(preview.breakdown).toBeUndefined();
  });

  it('includes reconciliation warnings, same as an actual close would', async () => {
    fakePrisma._tables().account.push({ id: 'acc_neg', businessId: 'biz_1', name: 'Weird', type: 'BANK', openingBalance: '-500' });
    const preview: any = await dayCloseService.previewDayClose('biz_1', DATE, null);
    expect(preview.reconciliationWarnings.some((w: any) => w.name === 'Account Balances')).toBe(true);
  });
});

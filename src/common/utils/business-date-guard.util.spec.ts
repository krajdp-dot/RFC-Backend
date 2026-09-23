import { ConflictException } from '@nestjs/common';
import { assertBusinessDateOpen, lockBusinessDateForClose } from './business-date-guard.util.js';
import { parseBusinessDate } from './date.util.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';

describe('assertBusinessDateOpen', () => {
  let fakePrisma: FakePrismaService;
  const DATE = '2026-09-07';

  function seedClosed(businessId: string, date: string) {
    (fakePrisma as any)._tables().dayClose.push({
      id: `close_${businessId}_${date}`,
      businessId,
      businessDate: parseBusinessDate(date),
      closedAt: new Date(),
    });
  }

  beforeEach(() => {
    fakePrisma = new FakePrismaService();
  });

  it('does nothing and returns the parsed date when open', async () => {
    const result = await assertBusinessDateOpen(fakePrisma, 'biz_1', DATE);
    expect(result.getTime()).toBe(parseBusinessDate(DATE).getTime());
  });

  it('rejects with a 409 ConflictException carrying code BUSINESS_DATE_CLOSED', async () => {
    seedClosed('biz_1', DATE);
    let caught: any;
    try {
      await assertBusinessDateOpen(fakePrisma, 'biz_1', DATE);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConflictException);
    expect(caught.getStatus()).toBe(409);
    expect(caught.getResponse()).toMatchObject({ code: 'BUSINESS_DATE_CLOSED', businessDate: DATE });
  });

  it('the message names the date', async () => {
    seedClosed('biz_1', DATE);
    await expect(assertBusinessDateOpen(fakePrisma, 'biz_1', DATE)).rejects.toThrow(
      `Business date ${DATE} is already closed`,
    );
  });

  it('business isolation: closing for business A does not block business B on the same date', async () => {
    seedClosed('biz_A', DATE);
    await expect(assertBusinessDateOpen(fakePrisma, 'biz_B', DATE)).resolves.toBeInstanceOf(Date);
  });

  it('a backdated but never-closed date is unaffected', async () => {
    await expect(assertBusinessDateOpen(fakePrisma, 'biz_1', '2026-08-01')).resolves.toBeInstanceOf(Date);
  });

  it('takes a SHARED advisory lock before checking', async () => {
    await assertBusinessDateOpen(fakePrisma, 'biz_1', DATE);
    expect(fakePrisma.queryRawCalls.some((q) => q.includes('pg_advisory_xact_lock_shared('))).toBe(true);
  });
});

describe('lockBusinessDateForClose', () => {
  it('takes an EXCLUSIVE lock, not the shared variant', async () => {
    const fakePrisma = new FakePrismaService();
    await lockBusinessDateForClose(fakePrisma, 'biz_1', '2026-09-07');
    expect(fakePrisma.queryRawCalls.some((q) => q.includes('pg_advisory_xact_lock('))).toBe(true);
    expect(fakePrisma.queryRawCalls.some((q) => q.includes('pg_advisory_xact_lock_shared('))).toBe(false);
  });
});

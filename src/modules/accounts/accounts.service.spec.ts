import { Test } from '@nestjs/testing';
import { AccountsService } from './accounts.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';

describe('AccountsService — Phase 1 opening balance', () => {
  let accountsService: AccountsService;
  let fakePrisma: FakePrismaService;

  async function build() {
    fakePrisma = new FakePrismaService({
      account: [{ id: 'acc_1', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '5000.00' }],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [AccountsService, AuditService, { provide: PrismaService, useValue: fakePrisma }],
    }).compile();
    accountsService = moduleRef.get(AccountsService);
  }

  beforeEach(async () => {
    await build();
  });

  it('the generic update endpoint cannot change openingBalance, even if it is present in the body', async () => {
    await accountsService.update('biz_1', 'acc_1', { name: 'Cash Drawer', openingBalance: '999999.00' } as any);
    const account = await fakePrisma.account.findFirst({ where: { id: 'acc_1' } });
    expect(account.name).toBe('Cash Drawer'); // other fields still update
    expect(account.openingBalance).toBe('5000.00'); // opening balance untouched
  });

  it('adjustOpeningBalance changes the balance and requires a reason', async () => {
    const updated = await accountsService.adjustOpeningBalance(
      'biz_1', 'acc_1', { amount: '7500.00', reason: 'Correcting a data-entry error from setup' }, 'user_1',
    );
    expect(updated.openingBalance).toBe('7500.00');
  });

  it('adjustOpeningBalance is atomic with its audit entry', async () => {
    await accountsService.adjustOpeningBalance(
      'biz_1', 'acc_1', { amount: '7500.00', reason: 'Correction' }, 'user_1',
    );
    const audit = fakePrisma._tables().auditLog;
    expect(audit).toHaveLength(1);
    expect(audit[0].entityType).toBe('ACCOUNT');
    expect(audit[0].before.openingBalance).toBe('5000.00');
    expect(audit[0].after.openingBalance).toBe('7500.00');
    expect(audit[0].reason).toBe('Correction');
  });

  it('rejects an invalid amount format', async () => {
    await expect(
      accountsService.adjustOpeningBalance('biz_1', 'acc_1', { amount: 'not-a-number', reason: 'x' } as any, 'user_1'),
    ).rejects.toThrow('Invalid amount');
  });

  it('a nonexistent account is rejected, business-scoped', async () => {
    await expect(
      accountsService.adjustOpeningBalance('biz_2', 'acc_1', { amount: '1.00', reason: 'x' }, 'user_1'),
    ).rejects.toThrow('Account not found');
  });
});

describe('AccountsService.createTransfer — Phase 9', () => {
  let accountsService: AccountsService;
  let fakePrisma: FakePrismaService;
  const TODAY = '2026-09-11';

  async function build() {
    fakePrisma = new FakePrismaService({
      account: [
        { id: 'acc_cash', businessId: 'biz_1', name: 'Cash', type: 'CASH', openingBalance: '10000.00' },
        { id: 'acc_bank', businessId: 'biz_1', name: 'SBI', type: 'BANK', openingBalance: '0.00' },
      ],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [AccountsService, AuditService, { provide: PrismaService, useValue: fakePrisma }],
    }).compile();
    accountsService = moduleRef.get(AccountsService);
  }

  beforeEach(async () => {
    await build();
  });

  it('posts balanced double-entry ledger lines: the source account is credited and the destination is debited by the same amount', async () => {
    await accountsService.createTransfer('biz_1', {
      fromAccountId: 'acc_cash', toAccountId: 'acc_bank', amount: '4000.00', businessDate: TODAY,
    } as any);
    const entries = fakePrisma._tables().ledgerEntry;
    expect(entries).toHaveLength(2);
    const totalDebit = entries.reduce((s: number, e: any) => s + Number(e.debit || 0), 0);
    const totalCredit = entries.reduce((s: number, e: any) => s + Number(e.credit || 0), 0);
    expect(totalDebit).toBe(totalCredit);
    expect(totalDebit).toBe(4000);
  });

  it('writes an audit entry for the transfer — previously it wrote none at all', async () => {
    await accountsService.createTransfer('biz_1', {
      fromAccountId: 'acc_cash', toAccountId: 'acc_bank', amount: '1000.00', businessDate: TODAY,
    } as any);
    const audit = fakePrisma._tables().auditLog;
    expect(audit).toHaveLength(1);
    expect(audit[0].entityType).toBe('TRANSFER');
  });

  it('a transfer on a closed business date is rejected, with zero side effects — previously this check did not exist at all', async () => {
    fakePrisma._tables().dayClose.push({
      id: 'dc_1', businessId: 'biz_1', businessDate: new Date('2026-09-11T00:00:00+05:30'),
    });

    await expect(
      accountsService.createTransfer('biz_1', {
        fromAccountId: 'acc_cash', toAccountId: 'acc_bank', amount: '1000.00', businessDate: TODAY,
      } as any),
    ).rejects.toThrow(/closed/i);

    expect(fakePrisma._tables().transfer).toHaveLength(0);
    expect(fakePrisma._tables().ledgerEntry).toHaveLength(0);
    expect(fakePrisma._tables().auditLog).toHaveLength(0);
  });

  it('business isolation: cannot transfer using another business\u2019s account', async () => {
    await expect(
      accountsService.createTransfer('biz_2', {
        fromAccountId: 'acc_cash', toAccountId: 'acc_bank', amount: '100.00', businessDate: TODAY,
      } as any),
    ).rejects.toThrow('not found');
  });
});

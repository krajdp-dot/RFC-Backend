import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateAccountDto } from './dto/create-account.dto.js';
import { UpdateAccountDto } from './dto/update-account.dto.js';
import { CreateTransferDto } from './dto/create-transfer.dto.js';
import { AdjustOpeningBalanceDto } from './dto/adjust-opening-balance.dto.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { toMoneyString } from '../../common/utils/money.util.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditAction } from '../../common/enums.js';
import { assertBusinessDateOpen } from '../../common/utils/business-date-guard.util.js';

@Injectable()
export class AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  async create(businessId: string, createAccountDto: CreateAccountDto) {
    return this.prisma.account.create({
      data: {
        ...createAccountDto,
        businessId,
        openingBalance: new Decimal(createAccountDto.openingBalance || 0),
      },
    });
  }

  async findAll(businessId: string, paginationDto?: PaginationDto) {
    const skip = paginationDto?.skip || 0;
    const take = paginationDto?.take || 20;

    const [accounts, total] = await Promise.all([
      this.prisma.account.findMany({
        where: { businessId },
        orderBy: { name: 'asc' },
        skip,
        take,
      }),
      this.prisma.account.count({ where: { businessId } })
    ]);

    const formattedAccounts = await Promise.all(accounts.map(async account => {
      const balance = await this.getAccountBalance(businessId, account.id);
      return {
        ...account,
        openingBalance: toMoneyString(account.openingBalance),
        balance,
      };
    }));

    return paginatedResponse(formattedAccounts, total, paginationDto?.page || 1, paginationDto?.limit || 20);
  }

  async findOne(businessId: string, id: string) {
    const account = await this.prisma.account.findFirst({
      where: { id, businessId },
    });

    if (!account) {
      throw new NotFoundException('Account not found');
    }

    const balance = await this.getAccountBalance(businessId, id);

    return {
      ...account,
      openingBalance: toMoneyString(account.openingBalance),
      balance,
    };
  }

  /**
   * Phase 1: opening balance can no longer be changed through the generic
   * update endpoint — it's stripped here unconditionally, even if present in
   * the request body, rather than silently accepted. Use
   * adjustOpeningBalance() instead, which requires a reason and writes an
   * atomic audit entry.
   */
  async update(businessId: string, id: string, updateAccountDto: UpdateAccountDto) {
    const account = await this.prisma.account.findFirst({
      where: { id, businessId },
    });

    if (!account) {
      throw new NotFoundException('Account not found');
    }

    const { openingBalance, ...rest } = updateAccountDto as any;
    const data: Prisma.AccountUpdateInput = { ...rest };

    const updated = await this.prisma.account.update({
      where: { id },
      data,
    });

    return {
      ...updated,
      openingBalance: toMoneyString(updated.openingBalance),
    };
  }

  /**
   * Phase 1: the dedicated, audited path for changing an opening balance.
   * Atomic with its audit entry — if the audit write fails, the balance
   * change rolls back with it (same transaction).
   */
  async adjustOpeningBalance(
    businessId: string,
    id: string,
    dto: AdjustOpeningBalanceDto,
    actingUserId?: string | null,
  ) {
    let newBalance: Decimal;
    try {
      newBalance = new Decimal(dto.amount);
    } catch {
      throw new BadRequestException('Invalid amount format');
    }

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({ where: { id, businessId } });
      if (!account) {
        throw new NotFoundException('Account not found');
      }

      const before = toMoneyString(account.openingBalance);
      const updated = await tx.account.update({
        where: { id },
        data: { openingBalance: newBalance },
      });

      await this.auditService.record(tx, {
        businessId,
        userId: actingUserId,
        action: AuditAction.UPDATE,
        entityType: 'ACCOUNT',
        entityId: id,
        before: { openingBalance: before },
        after: { openingBalance: toMoneyString(newBalance) },
        reason: dto.reason,
      });

      return {
        ...updated,
        openingBalance: toMoneyString(updated.openingBalance),
      };
    });
  }

  async getAccountBalance(businessId: string, accountId: string): Promise<string> {
    const account = await this.prisma.account.findFirst({
      where: { id: accountId, businessId },
    });

    if (!account) return '0.00';

    const entries = await this.prisma.ledgerEntry.aggregate({
      where: { accountId, businessId },
      _sum: { debit: true, credit: true },
    });

    const debit = new Decimal(entries._sum.debit || 0);
    const credit = new Decimal(entries._sum.credit || 0);

    // Balance = Opening + Debit - Credit (cash received = debit to cash;
    // cash paid out = credit to cash — same convention used everywhere else
    // in this codebase's double-entry postings).
    const balance = new Decimal(account.openingBalance).plus(debit).minus(credit);

    return toMoneyString(balance);
  }

  async getAccountTransactions(businessId: string, accountId: string, paginationDto: PaginationDto) {
    const { skip, take } = paginationDto;

    const where = { accountId, businessId };

    const [items, total] = await Promise.all([
      this.prisma.ledgerEntry.findMany({
        where,
        skip,
        take,
        orderBy: [
          { businessDate: 'desc' },
          { createdAt: 'desc' },
        ],
      }),
      this.prisma.ledgerEntry.count({ where }),
    ]);

    const formatted = items.map(entry => ({
      ...entry,
      debit: toMoneyString(entry.debit),
      credit: toMoneyString(entry.credit),
    }));

    return paginatedResponse(formatted, total, paginationDto.page || 1, paginationDto.limit || 20);
  }

  async createTransfer(businessId: string, createTransferDto: CreateTransferDto) {
    const { fromAccountId, toAccountId, amount, businessDate, notes } = createTransferDto;

    if (fromAccountId === toAccountId) {
      throw new BadRequestException('Cannot transfer to the same account');
    }

    const fromAccount = await this.prisma.account.findFirst({ where: { id: fromAccountId, businessId } });
    const toAccount = await this.prisma.account.findFirst({ where: { id: toAccountId, businessId } });

    if (!fromAccount || !toAccount) {
      throw new NotFoundException('One or both accounts not found');
    }

    const transferAmount = new Decimal(amount);
    if (transferAmount.lte(0)) {
      throw new BadRequestException('Transfer amount must be greater than zero');
    }

    return this.prisma.$transaction(async (tx) => {
      // Phase 9: this mutation had no closed-business-date check at all —
      // every other money-moving mutation (sales, purchases, payments,
      // expenses) rejects on a closed date; a transfer could silently slip
      // through and change account balances (and day-close's own math)
      // for a date that's supposedly locked. Same guard, same place in the
      // flow as everywhere else.
      const bDate = await assertBusinessDateOpen(tx, businessId, businessDate);

      const transfer = await tx.transfer.create({
        data: {
          businessId,
          fromAccountId,
          toAccountId,
          amount: transferAmount,
          businessDate: bDate,
          notes,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          accountId: fromAccountId,
          credit: transferAmount,
          businessDate: bDate,
          businessId,
          transactionType: 'TRANSFER',
          transactionId: transfer.id,
          description: `Transfer to ${toAccount.name}`,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          accountId: toAccountId,
          debit: transferAmount,
          businessDate: bDate,
          businessId,
          transactionType: 'TRANSFER',
          transactionId: transfer.id,
          description: `Transfer from ${fromAccount.name}`,
        },
      });

      // Phase 9: transfers moved real money between accounts with no audit
      // trail at all — every other account-balance-affecting mutation in
      // this file (adjustOpeningBalance) writes one, atomic with the same tx.
      await this.auditService.record(tx, {
        businessId,
        action: AuditAction.CREATE,
        entityType: 'TRANSFER',
        entityId: transfer.id,
        after: { fromAccountId, toAccountId, amount: transferAmount.toString(), businessDate: createTransferDto.businessDate },
        reason: notes,
      });

      return {
        ...transfer,
        amount: toMoneyString(transfer.amount),
      };
    });
  }
}

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateExpenseDto } from './dto/create-expense.dto.js';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { toMoneyString } from '../../common/utils/money.util.js';
import { parseBusinessDate, getDateRange } from '../../common/utils/date.util.js';
import { assertBusinessDateOpen } from '../../common/utils/business-date-guard.util.js';

@Injectable()
export class ExpensesService {
  constructor(private readonly prisma: PrismaService) {}

  async createCategory(businessId: string, createCategoryDto: CreateExpenseCategoryDto) {
    return this.prisma.expenseCategory.create({
      data: {
        ...createCategoryDto,
        businessId,
      },
    });
  }

  async findAllCategories(businessId: string) {
    return this.prisma.expenseCategory.findMany({
      where: { businessId },
      orderBy: { name: 'asc' },
    });
  }

  async create(businessId: string, createExpenseDto: CreateExpenseDto) {
    const { categoryId, description, amount, accountId, paymentMethod, businessDate, payee, notes } = createExpenseDto;

    const account = await this.prisma.account.findFirst({ where: { id: accountId, businessId } });
    if (!account) throw new NotFoundException('Account not found');

    const category = await this.prisma.expenseCategory.findFirst({ where: { id: categoryId, businessId } });
    if (!category) throw new NotFoundException('Expense category not found');

    let expenseAmount: Decimal;
    try {
      expenseAmount = new Decimal(amount);
    } catch (e) {
      throw new BadRequestException('Invalid amount format');
    }

    return this.prisma.$transaction(async (tx) => {
      const bDate = await assertBusinessDateOpen(tx, businessId, businessDate);

      const expense = await tx.expense.create({
        data: {
          businessId,
          categoryId,
          description,
          amount: expenseAmount,
          accountId,
          paymentMethod,
          businessDate: bDate,
          payee,
          notes,
        },
      });

      // Phase 9: this only ever posted the credit (cash/bank account
      // decreasing) — the matching debit side never existed, so every
      // expense silently left the ledger one-sided. Same
      // find-or-create-a-generic-EXPENSE-account pattern already
      // established by inventory.service.ts's wastage loss posting (and
      // reuses that same account if it already exists, rather than
      // creating a second one).
      let expenseAccount = await tx.account.findFirst({
        where: { businessId, type: 'EXPENSE' },
      });
      if (!expenseAccount) {
        expenseAccount = await tx.account.create({
          data: { businessId, name: 'Business Expenses', type: 'EXPENSE' },
        });
      }
      await tx.ledgerEntry.create({
        data: {
          accountId: expenseAccount.id,
          businessId,
          debit: expenseAmount,
          businessDate: bDate,
          transactionType: 'EXPENSE',
          transactionId: expense.id,
          description: `Expense recognized: ${category.name} - ${description}`,
        },
      });

      await tx.ledgerEntry.create({
        data: {
          accountId,
          businessId,
          credit: expenseAmount,
          businessDate: bDate,
          transactionType: 'EXPENSE',
          transactionId: expense.id,
          description: `Expense: ${category.name} - ${description}`,
        },
      });

      return {
        ...expense,
        amount: toMoneyString(expense.amount),
      };
    });
  }

  async findAll(
    businessId: string,
    paginationDto: PaginationDto,
    categoryId?: string,
    startDate?: string,
    endDate?: string,
    accountId?: string,
  ) {
    const { skip, take } = paginationDto;
    
    const where: Prisma.ExpenseWhereInput = {
      businessId,
      ...(categoryId ? { categoryId } : {}),
      ...(accountId ? { accountId } : {}),
      ...(startDate && endDate ? {
        // Was `new Date(startDate)`/`new Date(endDate)` — that parses as
        // UTC midnight, not IST business-day midnight, so a same-day range
        // (startDate === endDate) matched almost nothing. getDateRange is
        // the same business-timezone-aware helper day-close and the rest
        // of the app already use for this.
        businessDate: { gte: getDateRange(startDate, endDate).start, lte: getDateRange(startDate, endDate).end },
      } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.expense.findMany({
        where,
        skip,
        take,
        orderBy: { businessDate: 'desc' },
        include: { category: true, account: true },
      }),
      this.prisma.expense.count({ where }),
    ]);

    return paginatedResponse(items.map(item => ({
      ...item,
      amount: toMoneyString(item.amount),
    })), total, paginationDto.page || 1, paginationDto.limit || 20);
  }

  async getExpenseSummary(businessId: string, startDate?: string, endDate?: string) {
    const where: Prisma.ExpenseWhereInput = {
      businessId,
      ...(startDate && endDate ? {
        // Same business-timezone-aware fix as findAll() above.
        businessDate: { gte: getDateRange(startDate, endDate).start, lte: getDateRange(startDate, endDate).end },
      } : {}),
    };

    // Two flat queries + an in-memory join, rather than `include: { category:
    // true }` — real Postgres resolves that fine, but it's a silent no-op
    // against this repo's FakePrismaService test double (findMany only ever
    // reads `where`/`orderBy`/`take`), which is exactly why the dashboard's
    // largest-expense-category figure (Phase 7) needed this fixed to be
    // testable at all.
    const [expenses, categories] = await Promise.all([
      this.prisma.expense.findMany({ where }),
      this.prisma.expenseCategory.findMany({ where: { businessId } }),
    ]);
    const categoryNameById = new Map<string, string>(categories.map((c) => [c.id, c.name]));

    const categoryMap = new Map<string, { name: string, amount: Decimal, count: number }>();
    let totalAmount = new Decimal(0);

    for (const expense of expenses) {
      const amount = new Decimal(expense.amount);
      totalAmount = totalAmount.plus(amount);

      const existing = categoryMap.get(expense.categoryId) || {
        name: categoryNameById.get(expense.categoryId) || 'Unknown category',
        amount: new Decimal(0),
        count: 0,
      };
      existing.amount = existing.amount.plus(amount);
      existing.count += 1;
      categoryMap.set(expense.categoryId, existing);
    }

    const summary = Array.from(categoryMap.values()).map(cat => ({
      category: cat.name,
      amount: toMoneyString(cat.amount),
      count: cat.count,
      percentage: totalAmount.gt(0) ? cat.amount.dividedBy(totalAmount).times(100).toFixed(2) : '0.00',
    }));

    return {
      total: toMoneyString(totalAmount),
      breakdown: summary.sort((a, b) => Number(b.amount) - Number(a.amount)),
    };
  }
}

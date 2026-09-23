import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateCustomerDto } from './dto/create-customer.dto.js';
import { UpdateCustomerDto } from './dto/update-customer.dto.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { toMoneyString } from '../../common/utils/money.util.js';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(businessId: string, createCustomerDto: CreateCustomerDto) {
    return this.prisma.customer.create({
      data: {
        ...createCustomerDto,
        businessId,
        creditLimit: createCustomerDto.creditLimit ? new Decimal(createCustomerDto.creditLimit) : null,
      },
    });
  }

  async findAll(businessId: string, paginationDto: PaginationDto, search?: string, activeOnly: boolean = true) {
    const { skip, take } = paginationDto;
    
    const where: Prisma.CustomerWhereInput = {
      businessId,
      ...(activeOnly ? { active: true } : {}),
      ...(search ? {
        OR: [
          { name: { contains: search } },
          { phone: { contains: search } },
          { businessName: { contains: search } },
        ],
      } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.customer.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
      }),
      this.prisma.customer.count({ where }),
    ]);

    return paginatedResponse(items.map(item => ({
      ...item,
      creditLimit: toMoneyString(item.creditLimit),
    })), total, paginationDto.page || 1, paginationDto.limit || 20);
  }

  async findOne(businessId: string, id: string) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
    });

    if (!customer) {
      throw new NotFoundException(`Customer not found`);
    }

    const summary = await this.getCustomerSummary(businessId, id);

    return {
      ...customer,
      creditLimit: toMoneyString(customer.creditLimit),
      summary,
    };
  }

  async update(businessId: string, id: string, updateCustomerDto: UpdateCustomerDto) {
    const customer = await this.prisma.customer.findFirst({
      where: { id, businessId },
    });

    if (!customer) {
      throw new NotFoundException(`Customer not found`);
    }

    const data: Prisma.CustomerUpdateInput = { ...updateCustomerDto };
    if (updateCustomerDto.creditLimit) {
      data.creditLimit = new Decimal(updateCustomerDto.creditLimit);
    }

    const updated = await this.prisma.customer.update({
      where: { id },
      data,
    });

    return {
      ...updated,
      creditLimit: toMoneyString(updated.creditLimit),
    };
  }

  async getCustomerSummary(businessId: string, id: string) {
    const sales = await this.prisma.sale.aggregate({
      where: { customerId: id, businessId, status: { not: 'VOID' } },
      _sum: { total: true },
    });

    // Phase 8: was `customer.creditLimit` — the configured MAXIMUM a
    // customer is allowed to owe, not what they actually owe right now (a
    // fully-paid-up customer with a Rs 50,000 limit was showing Rs 50,000
    // outstanding). Sale.creditAmount is the field every payment/refund/
    // return already keeps correct — same convention used by
    // receivables.service.ts's aging analysis — so it's summed directly
    // for this customer instead.
    const outstandingAgg = await this.prisma.sale.aggregate({
      where: { customerId: id, businessId, creditAmount: { gt: 0 } },
      _sum: { creditAmount: true },
    });

    const payments = await this.prisma.payment.aggregate({
      // Phase 8: was every COMPLETED payment for this customer, which
      // included REFUND rows (money paid back to them) as if it were money
      // collected. Scoped to actual collections only.
      where: { customerId: id, businessId, status: 'COMPLETED', transactionType: 'CUSTOMER_PAYMENT' },
      _sum: { amount: true },
      _max: { businessDate: true },
    });

    return {
      totalSales: toMoneyString(sales._sum.total || 0),
      totalCollected: toMoneyString(payments._sum.amount || 0),
      outstanding: toMoneyString(outstandingAgg._sum.creditAmount || 0),
      lastPaymentDate: payments._max.businessDate,
    };
  }

  async getCustomerLedger(businessId: string, id: string, paginationDto: PaginationDto) {
    const { skip, take } = paginationDto;
    
    const [sales, payments] = await Promise.all([
      this.prisma.sale.findMany({
        where: { customerId: id, businessId },
        select: { id: true, businessDate: true, total: true, status: true, saleReference: true },
      }),
      this.prisma.payment.findMany({
        where: { customerId: id, businessId },
        select: { id: true, businessDate: true, amount: true, status: true, idempotencyKey: true },
      }),
    ]);

    const ledger = [
      ...sales.map(s => ({
        type: 'SALE',
        id: s.id,
        date: s.businessDate,
        amount: toMoneyString(s.total),
        status: s.status,
        // Phase 8: was idempotencyKey (a client-generated dedup UUID, not
        // meant for display) — saleReference is the human-readable
        // "SALE-..." reference already shown everywhere else (sales list,
        // sale detail).
        reference: s.saleReference,
      })),
      ...payments.map(p => ({
        type: 'PAYMENT',
        id: p.id,
        date: p.businessDate,
        amount: toMoneyString(p.amount),
        status: p.status,
        // Payments have no dedicated human-readable reference field in the
        // schema; idempotencyKey is the best available (and is itself a
        // readable generated string for payments created alongside a sale
        // — see generateReference() in sales.service.ts), falling back to
        // the row id on the rare row without one (e.g. an older manual
        // payment recorded without a key).
        reference: p.idempotencyKey || p.id,
      })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime());

    const paginatedLedger = ledger.slice(skip, skip + take);

    return paginatedResponse(paginatedLedger, ledger.length, paginationDto.page || 1, paginationDto.limit || 20);
  }

  async getCustomerAging(businessId: string, id: string) {
    const sales = await this.prisma.sale.findMany({
      where: { customerId: id, businessId, status: { not: 'VOID' } },
      select: { businessDate: true, total: true, received: true },
    });

    const now = new Date();
    let current = new Decimal(0);
    let week2 = new Decimal(0);
    let month = new Decimal(0);
    let overdue = new Decimal(0);

    for (const sale of sales) {
      const outstanding = new Decimal(sale.total).minus(new Decimal(sale.received || 0));
      if (outstanding.lte(0)) continue;

      const daysOld = Math.floor((now.getTime() - sale.businessDate.getTime()) / (1000 * 60 * 60 * 24));
      
      if (daysOld <= 7) current = current.plus(outstanding);
      else if (daysOld <= 15) week2 = week2.plus(outstanding);
      else if (daysOld <= 30) month = month.plus(outstanding);
      else overdue = overdue.plus(outstanding);
    }

    const total = current.plus(week2).plus(month).plus(overdue);

    return {
      current: toMoneyString(current),
      week2: toMoneyString(week2),
      month: toMoneyString(month),
      overdue: toMoneyString(overdue),
      total: toMoneyString(total),
    };
  }
}

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateSupplierDto } from './dto/create-supplier.dto.js';
import { UpdateSupplierDto } from './dto/update-supplier.dto.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { Prisma } from '@prisma/client';
import { Decimal } from 'decimal.js';
import { toMoneyString } from '../../common/utils/money.util.js';

@Injectable()
export class SuppliersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(businessId: string, createSupplierDto: CreateSupplierDto) {
    return this.prisma.supplier.create({
      data: {
        ...createSupplierDto,
        businessId,
      },
    });
  }

  async findAll(businessId: string, paginationDto: PaginationDto, search?: string, activeOnly: boolean = true) {
    const { skip, take } = paginationDto;
    
    const where: Prisma.SupplierWhereInput = {
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
      this.prisma.supplier.findMany({
        where,
        skip,
        take,
        orderBy: { name: 'asc' },
      }),
      this.prisma.supplier.count({ where }),
    ]);

    return paginatedResponse(items, total, paginationDto.page || 1, paginationDto.limit || 20);
  }

  async findOne(businessId: string, id: string) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, businessId },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier not found`);
    }

    const summary = await this.getSupplierSummary(businessId, id);

    return {
      ...supplier,
      summary,
    };
  }

  async update(businessId: string, id: string, updateSupplierDto: UpdateSupplierDto) {
    const supplier = await this.prisma.supplier.findFirst({
      where: { id, businessId },
    });

    if (!supplier) {
      throw new NotFoundException(`Supplier not found`);
    }

    const updated = await this.prisma.supplier.update({
      where: { id },
      data: { ...updateSupplierDto },
    });

    return updated;
  }

  async getSupplierSummary(businessId: string, id: string) {
    const purchases = await this.prisma.purchase.aggregate({
      where: { supplierId: id, businessId, status: { not: 'VOID' } },
      _sum: { subtotal: true },
    });

    // Phase 8: was `subtotal` (before transport/loading/unloading/other
    // costs) minus every COMPLETED payment (which included REFUND rows).
    // landedCost is what a purchase's paid/creditAmount split is actually
    // computed against everywhere else (purchases.service.ts,
    // payables.service.ts's aging) — Purchase.creditAmount already nets
    // out every payment and refund correctly on write, so it's summed
    // directly here instead of re-derived.
    const outstandingAgg = await this.prisma.purchase.aggregate({
      where: { supplierId: id, businessId, creditAmount: { gt: 0 } },
      _sum: { creditAmount: true },
    });

    const payments = await this.prisma.payment.aggregate({
      where: { supplierId: id, businessId, status: 'COMPLETED', transactionType: 'SUPPLIER_PAYMENT' },
      _sum: { amount: true },
      _max: { businessDate: true },
    });

    const totalPurchasesAmount = new Decimal(purchases._sum.subtotal || 0);
    const totalPaidAmount = new Decimal(payments._sum.amount || 0);

    return {
      totalPurchases: toMoneyString(totalPurchasesAmount),
      totalPaid: toMoneyString(totalPaidAmount),
      outstanding: toMoneyString(outstandingAgg._sum.creditAmount || 0),
      lastPaymentDate: payments._max.businessDate,
    };
  }

  async getSupplierLedger(businessId: string, id: string, paginationDto: PaginationDto) {
    const { skip, take } = paginationDto;
    
    const [purchases, payments] = await Promise.all([
      this.prisma.purchase.findMany({
        where: { supplierId: id, businessId },
        select: { id: true, businessDate: true, landedCost: true, status: true, purchaseReference: true },
      }),
      this.prisma.payment.findMany({
        where: { supplierId: id, businessId },
        select: { id: true, businessDate: true, amount: true, status: true, idempotencyKey: true },
      }),
    ]);

    const ledger = [
      ...purchases.map(p => ({
        type: 'PURCHASE',
        id: p.id,
        // Phase 8: was subtotal (before transport/loading/unloading/other
        // costs) — landedCost is the actual amount owed/paid for the
        // purchase, matching Purchase.paid/creditAmount everywhere else.
        date: p.businessDate,
        amount: toMoneyString(p.landedCost),
        status: p.status,
        reference: p.purchaseReference,
      })),
      ...payments.map(p => ({
        type: 'PAYMENT',
        id: p.id,
        date: p.businessDate,
        amount: toMoneyString(p.amount),
        status: p.status,
        reference: p.idempotencyKey || p.id,
      })),
    ].sort((a, b) => b.date.getTime() - a.date.getTime());

    const paginatedLedger = ledger.slice(skip, skip + take);

    return paginatedResponse(paginatedLedger, ledger.length, paginationDto.page || 1, paginationDto.limit || 20);
  }

  async getSupplierAging(businessId: string, id: string) {
    const purchases = await this.prisma.purchase.findMany({
      where: { supplierId: id, businessId, status: { not: 'VOID' } },
      select: { businessDate: true, subtotal: true, paid: true },
    });

    const now = new Date();
    let current = new Decimal(0);
    let week2 = new Decimal(0);
    let month = new Decimal(0);
    let overdue = new Decimal(0);

    for (const purchase of purchases) {
      const outstanding = new Decimal(purchase.subtotal).minus(new Decimal(purchase.paid || 0));
      if (outstanding.lte(0)) continue;

      const daysOld = Math.floor((now.getTime() - purchase.businessDate.getTime()) / (1000 * 60 * 60 * 24));
      
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
      subtotal: toMoneyString(total),
    };
  }
}

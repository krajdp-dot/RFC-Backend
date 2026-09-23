import { PaymentTransactionType, AuditAction } from '../../common/enums.js';
import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { ReceivePaymentDto } from './dto/receive-payment.dto.js';
import { MakePaymentDto } from './dto/make-payment.dto.js';
import { RefundCustomerDto } from './dto/refund-customer.dto.js';
import { RefundSupplierDto } from './dto/refund-supplier.dto.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { toDecimal, sumDecimal, toMoneyString } from '../../common/utils/money.util.js';
import { parseBusinessDate } from '../../common/utils/date.util.js';
import { assertBusinessDateOpen } from '../../common/utils/business-date-guard.util.js';
import { AuditService } from '../audit/audit.service.js';
import { generateReference } from '../../common/utils/reference.util.js';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private async getOrCreateAccount(tx: any, businessId: string, type: string, name: string) {
    let acc = await tx.account.findFirst({ where: { businessId, type } });
    if (!acc) acc = await tx.account.create({ data: { businessId, name, type, openingBalance: 0 } });
    return acc;
  }

  /**
   * Row-lock the sale/purchase for the duration of the transaction (Postgres
   * SELECT ... FOR UPDATE) so two concurrent payments against the same
   * sale/purchase can't both read the same "outstanding" figure and both
   * succeed. The second request blocks until the first commits, then
   * re-reads the now-updated row.
   */
  private async lockSale(tx: any, businessId: string, saleId: string) {
    await tx.$queryRaw`SELECT id FROM sales WHERE id = ${saleId} AND "businessId" = ${businessId} FOR UPDATE`;
  }

  private async lockPurchase(tx: any, businessId: string, purchaseId: string) {
    await tx.$queryRaw`SELECT id FROM purchases WHERE id = ${purchaseId} AND "businessId" = ${businessId} FOR UPDATE`;
  }

  async receivePayment(businessId: string, dto: ReceivePaymentDto, actingUserId?: string | null) {
    const payment = await this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        const existing = await tx.payment.findFirst({ where: { businessId, idempotencyKey: dto.idempotencyKey } });
        if (existing) return existing;
      }

      const bDate = await assertBusinessDateOpen(tx, businessId, dto.businessDate);

      const customer = await tx.customer.findFirst({ where: { id: dto.customerId, businessId } });
      if (!customer) throw new NotFoundException('Customer not found');

      const amountDec = toDecimal(dto.amount);
      if (amountDec.lte(0)) throw new BadRequestException('Payment amount must be positive');

      const account = await tx.account.findFirst({ where: { id: dto.accountId, businessId } });
      if (!account) throw new NotFoundException('Account not found');

      let sale: any = null;
      if (dto.saleId) {
        await this.lockSale(tx, businessId, dto.saleId);
        sale = await tx.sale.findFirst({ where: { id: dto.saleId, businessId } });
        if (!sale) throw new NotFoundException('Sale not found');
        if (sale.customerId !== dto.customerId) {
          throw new BadRequestException('Sale does not belong to the specified customer');
        }

        const outstanding = toDecimal(sale.creditAmount);
        if (outstanding.lte(0)) {
          throw new BadRequestException('This sale has no outstanding amount to collect');
        }
        if (amountDec.gt(outstanding)) {
          const excess = amountDec.minus(outstanding);
          throw new BadRequestException(`Payment exceeds outstanding by \u20b9${toMoneyString(excess)}`);
        }
      }

      const paymentRef = generateReference('PAYMENT_IN', dto.businessDate);

      const payment = await tx.payment.create({
        data: {
          businessId,
          transactionType: PaymentTransactionType.CUSTOMER_PAYMENT,
          saleId: dto.saleId ?? null,
          customerId: dto.customerId,
          amount: amountDec,
          method: dto.method,
          accountId: dto.accountId,
          businessDate: bDate,
          notes: dto.notes,
          idempotencyKey: dto.idempotencyKey ?? null,
        },
      });

      let before: any = null;
      let after: any = null;

      if (sale) {
        const newReceived = sumDecimal(sale.received, amountDec);
        // creditAmount is adjusted directly, not re-derived from
        // total-received: a prior return may have already reduced
        // creditAmount independently of received/total, and re-deriving
        // here would silently discard that (Phase 2 requirement).
        const newCreditAmount = toDecimal(sale.creditAmount).minus(amountDec);
        before = { received: toMoneyString(sale.received), creditAmount: toMoneyString(sale.creditAmount) };
        after = { received: toMoneyString(newReceived), creditAmount: toMoneyString(newCreditAmount) };
        await tx.sale.update({
          where: { id: dto.saleId },
          data: { received: newReceived, creditAmount: newCreditAmount },
        });
      }

      // Double-entry: debit the cash/bank/digital account, credit the
      // customer-receivable account — both legs, not just the cash side.
      await tx.ledgerEntry.create({
        data: {
          businessId,
          accountId: dto.accountId,
          transactionType: PaymentTransactionType.CUSTOMER_PAYMENT,
          transactionId: payment.id,
          entityType: 'CUSTOMER',
          entityId: dto.customerId,
          debit: amountDec,
          businessDate: bDate,
          description: `Payment received from customer ${paymentRef}`,
        },
      });

      const receivableAccount = await this.getOrCreateAccount(tx, businessId, 'CUSTOMER_RECEIVABLE', 'Customer Receivables');
      await tx.ledgerEntry.create({
        data: {
          businessId,
          accountId: receivableAccount.id,
          transactionType: PaymentTransactionType.CUSTOMER_PAYMENT,
          transactionId: payment.id,
          entityType: 'CUSTOMER',
          entityId: dto.customerId,
          credit: amountDec,
          businessDate: bDate,
          description: `Payment received from customer ${paymentRef}`,
        },
      });

      if (sale) {
        await this.auditService.record(tx, {
          businessId,
          userId: actingUserId,
          action: AuditAction.UPDATE,
          entityType: 'SALE',
          entityId: sale.id,
          before,
          after,
          reason: `Customer payment ${paymentRef}`,
        });
      }

      return { ...payment, amount: amountDec };
    });

    // Phase 12: same shape as sale.created above — committed data only,
    // listener decides whether/how to notify, idempotent regardless of
    // whether this event fires once or (on a replayed idempotencyKey)
    // twice for the same payment.id.
    this.eventEmitter.emit('payment.received', { businessId, paymentId: payment.id });

    return payment;
  }

  async makePayment(businessId: string, dto: MakePaymentDto, actingUserId?: string | null) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        const existing = await tx.payment.findFirst({ where: { businessId, idempotencyKey: dto.idempotencyKey } });
        if (existing) return existing;
      }

      const bDate = await assertBusinessDateOpen(tx, businessId, dto.businessDate);

      const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, businessId } });
      if (!supplier) throw new NotFoundException('Supplier not found');

      const amountDec = toDecimal(dto.amount);
      if (amountDec.lte(0)) throw new BadRequestException('Payment amount must be positive');

      const account = await tx.account.findFirst({ where: { id: dto.accountId, businessId } });
      if (!account) throw new NotFoundException('Account not found');

      let purchase: any = null;
      if (dto.purchaseId) {
        await this.lockPurchase(tx, businessId, dto.purchaseId);
        purchase = await tx.purchase.findFirst({ where: { id: dto.purchaseId, businessId } });
        if (!purchase) throw new NotFoundException('Purchase not found');
        if (purchase.supplierId !== dto.supplierId) {
          throw new BadRequestException('Purchase does not belong to the specified supplier');
        }

        const outstanding = toDecimal(purchase.creditAmount);
        if (outstanding.lte(0)) {
          throw new BadRequestException('This purchase has no outstanding amount to pay');
        }
        if (amountDec.gt(outstanding)) {
          const excess = amountDec.minus(outstanding);
          throw new BadRequestException(`Payment exceeds outstanding by \u20b9${toMoneyString(excess)}`);
        }
      }

      const paymentRef = generateReference('PAYMENT_OUT', dto.businessDate);

      const payment = await tx.payment.create({
        data: {
          businessId,
          transactionType: PaymentTransactionType.SUPPLIER_PAYMENT,
          purchaseId: dto.purchaseId ?? null,
          supplierId: dto.supplierId,
          amount: amountDec,
          method: dto.method,
          accountId: dto.accountId,
          businessDate: bDate,
          notes: dto.notes,
          idempotencyKey: dto.idempotencyKey ?? null,
        },
      });

      let before: any = null;
      let after: any = null;

      if (purchase) {
        const newPaid = sumDecimal(purchase.paid, amountDec);
        const newCreditAmount = toDecimal(purchase.creditAmount).minus(amountDec);
        before = { paid: toMoneyString(purchase.paid), creditAmount: toMoneyString(purchase.creditAmount) };
        after = { paid: toMoneyString(newPaid), creditAmount: toMoneyString(newCreditAmount) };
        await tx.purchase.update({
          where: { id: dto.purchaseId },
          data: { paid: newPaid, creditAmount: newCreditAmount },
        });
      }

      // Double-entry: credit the cash/bank/digital account, debit the
      // supplier-payable account — both legs.
      await tx.ledgerEntry.create({
        data: {
          businessId,
          accountId: dto.accountId,
          transactionType: PaymentTransactionType.SUPPLIER_PAYMENT,
          transactionId: payment.id,
          entityType: 'SUPPLIER',
          entityId: dto.supplierId,
          credit: amountDec,
          businessDate: bDate,
          description: `Payment made to supplier ${paymentRef}`,
        },
      });

      const payableAccount = await this.getOrCreateAccount(tx, businessId, 'SUPPLIER_PAYABLE', 'Supplier Payables');
      await tx.ledgerEntry.create({
        data: {
          businessId,
          accountId: payableAccount.id,
          transactionType: PaymentTransactionType.SUPPLIER_PAYMENT,
          transactionId: payment.id,
          entityType: 'SUPPLIER',
          entityId: dto.supplierId,
          debit: amountDec,
          businessDate: bDate,
          description: `Payment made to supplier ${paymentRef}`,
        },
      });

      if (purchase) {
        await this.auditService.record(tx, {
          businessId,
          userId: actingUserId,
          action: AuditAction.UPDATE,
          entityType: 'PURCHASE',
          entityId: purchase.id,
          before,
          after,
          reason: `Supplier payment ${paymentRef}`,
        });
      }

      return { ...payment, amount: amountDec };
    });
  }

  /**
   * Pay money BACK to a customer — only valid when the linked sale's
   * creditAmount is negative (the business owes them, typically after a
   * return on an already-paid sale). The reverse of receivePayment.
   */
  async refundCustomer(businessId: string, dto: RefundCustomerDto, actingUserId?: string | null) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        const existing = await tx.payment.findFirst({ where: { businessId, idempotencyKey: dto.idempotencyKey } });
        if (existing) return existing;
      }

      const bDate = await assertBusinessDateOpen(tx, businessId, dto.businessDate);

      const customer = await tx.customer.findFirst({ where: { id: dto.customerId, businessId } });
      if (!customer) throw new NotFoundException('Customer not found');

      const amountDec = toDecimal(dto.amount);
      if (amountDec.lte(0)) throw new BadRequestException('Refund amount must be positive');

      const account = await tx.account.findFirst({ where: { id: dto.accountId, businessId } });
      if (!account) throw new NotFoundException('Account not found');

      await this.lockSale(tx, businessId, dto.saleId);
      const sale = await tx.sale.findFirst({ where: { id: dto.saleId, businessId } });
      if (!sale) throw new NotFoundException('Sale not found');
      if (sale.customerId !== dto.customerId) {
        throw new BadRequestException('Sale does not belong to the specified customer');
      }

      const creditAmount = toDecimal(sale.creditAmount);
      const owedToCustomer = creditAmount.lt(0) ? creditAmount.abs() : toDecimal(0);
      if (owedToCustomer.lte(0)) {
        throw new BadRequestException('No refund is owed for this sale');
      }
      if (amountDec.gt(owedToCustomer)) {
        const excess = amountDec.minus(owedToCustomer);
        throw new BadRequestException(`Refund exceeds amount owed by \u20b9${toMoneyString(excess)}`);
      }

      const paymentRef = generateReference('REFUND_OUT', dto.businessDate);

      const payment = await tx.payment.create({
        data: {
          businessId,
          transactionType: PaymentTransactionType.REFUND,
          amount: amountDec,
          method: dto.method,
          businessDate: bDate,
          customerId: dto.customerId,
          accountId: dto.accountId,
          saleId: dto.saleId,
          notes: dto.notes,
          idempotencyKey: dto.idempotencyKey ?? null,
        },
      });

      const newReceived = toDecimal(sale.received).minus(amountDec);
      const newCreditAmount = toDecimal(sale.creditAmount).plus(amountDec);
      await tx.sale.update({
        where: { id: dto.saleId },
        data: { received: newReceived, creditAmount: newCreditAmount },
      });

      const receivableAccount = await this.getOrCreateAccount(tx, businessId, 'CUSTOMER_RECEIVABLE', 'Customer Receivables');

      // Reverse of a normal payment: debit receivable, credit cash out.
      await tx.ledgerEntry.create({
        data: {
          businessId,
          accountId: receivableAccount.id,
          transactionType: PaymentTransactionType.REFUND,
          transactionId: payment.id,
          entityType: 'CUSTOMER',
          entityId: dto.customerId,
          debit: amountDec,
          businessDate: bDate,
          description: `Refund to customer ${paymentRef}: ${dto.reason}`,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          businessId,
          accountId: dto.accountId,
          transactionType: PaymentTransactionType.REFUND,
          transactionId: payment.id,
          entityType: 'CUSTOMER',
          entityId: dto.customerId,
          credit: amountDec,
          businessDate: bDate,
          description: `Refund to customer ${paymentRef}: ${dto.reason}`,
        },
      });

      await this.auditService.record(tx, {
        businessId,
        userId: actingUserId,
        action: AuditAction.UPDATE,
        entityType: 'SALE',
        entityId: sale.id,
        before: { received: toMoneyString(sale.received), creditAmount: toMoneyString(sale.creditAmount) },
        after: { received: toMoneyString(newReceived), creditAmount: toMoneyString(newCreditAmount) },
        reason: dto.reason,
      });

      return { ...payment, amount: amountDec };
    });
  }

  /**
   * Receive money BACK from a supplier — only valid when the linked
   * purchase's creditAmount is negative (the supplier owes the business).
   * The reverse of makePayment.
   */
  async refundSupplier(businessId: string, dto: RefundSupplierDto, actingUserId?: string | null) {
    return this.prisma.$transaction(async (tx) => {
      if (dto.idempotencyKey) {
        const existing = await tx.payment.findFirst({ where: { businessId, idempotencyKey: dto.idempotencyKey } });
        if (existing) return existing;
      }

      const bDate = await assertBusinessDateOpen(tx, businessId, dto.businessDate);

      const supplier = await tx.supplier.findFirst({ where: { id: dto.supplierId, businessId } });
      if (!supplier) throw new NotFoundException('Supplier not found');

      const amountDec = toDecimal(dto.amount);
      if (amountDec.lte(0)) throw new BadRequestException('Refund amount must be positive');

      const account = await tx.account.findFirst({ where: { id: dto.accountId, businessId } });
      if (!account) throw new NotFoundException('Account not found');

      await this.lockPurchase(tx, businessId, dto.purchaseId);
      const purchase = await tx.purchase.findFirst({ where: { id: dto.purchaseId, businessId } });
      if (!purchase) throw new NotFoundException('Purchase not found');
      if (purchase.supplierId !== dto.supplierId) {
        throw new BadRequestException('Purchase does not belong to the specified supplier');
      }

      const creditAmount = toDecimal(purchase.creditAmount);
      const owedByCustomer = creditAmount.lt(0) ? creditAmount.abs() : toDecimal(0);
      if (owedByCustomer.lte(0)) {
        throw new BadRequestException('No refund is owed on this purchase');
      }
      if (amountDec.gt(owedByCustomer)) {
        const excess = amountDec.minus(owedByCustomer);
        throw new BadRequestException(`Refund exceeds amount owed by \u20b9${toMoneyString(excess)}`);
      }

      const paymentRef = generateReference('REFUND_IN', dto.businessDate);

      const payment = await tx.payment.create({
        data: {
          businessId,
          transactionType: PaymentTransactionType.REFUND,
          amount: amountDec,
          method: dto.method,
          businessDate: bDate,
          supplierId: dto.supplierId,
          accountId: dto.accountId,
          purchaseId: dto.purchaseId,
          notes: dto.notes,
          idempotencyKey: dto.idempotencyKey ?? null,
        },
      });

      const newPaid = toDecimal(purchase.paid).minus(amountDec);
      const newCreditAmount = toDecimal(purchase.creditAmount).plus(amountDec);
      await tx.purchase.update({
        where: { id: dto.purchaseId },
        data: { paid: newPaid, creditAmount: newCreditAmount },
      });

      const payableAccount = await this.getOrCreateAccount(tx, businessId, 'SUPPLIER_PAYABLE', 'Supplier Payables');

      // Reverse of a normal payment: debit cash in, credit payable.
      await tx.ledgerEntry.create({
        data: {
          businessId,
          accountId: dto.accountId,
          transactionType: PaymentTransactionType.REFUND,
          transactionId: payment.id,
          entityType: 'SUPPLIER',
          entityId: dto.supplierId,
          debit: amountDec,
          businessDate: bDate,
          description: `Refund from supplier ${paymentRef}: ${dto.reason}`,
        },
      });
      await tx.ledgerEntry.create({
        data: {
          businessId,
          accountId: payableAccount.id,
          transactionType: PaymentTransactionType.REFUND,
          transactionId: payment.id,
          entityType: 'SUPPLIER',
          entityId: dto.supplierId,
          credit: amountDec,
          businessDate: bDate,
          description: `Refund from supplier ${paymentRef}: ${dto.reason}`,
        },
      });

      await this.auditService.record(tx, {
        businessId,
        userId: actingUserId,
        action: AuditAction.UPDATE,
        entityType: 'PURCHASE',
        entityId: purchase.id,
        before: { paid: toMoneyString(purchase.paid), creditAmount: toMoneyString(purchase.creditAmount) },
        after: { paid: toMoneyString(newPaid), creditAmount: toMoneyString(newCreditAmount) },
        reason: dto.reason,
      });

      return { ...payment, amount: amountDec };
    });
  }

  async findAll(
    businessId: string,
    paginationDto: PaginationDto,
    filters: { type?: string; customerId?: string; supplierId?: string; startDate?: string; endDate?: string },
  ) {
    const { skip, take } = paginationDto;
    const where: any = { businessId };
    if (filters.type) where.transactionType = filters.type;
    if (filters.customerId) where.customerId = filters.customerId;
    if (filters.supplierId) where.supplierId = filters.supplierId;
    if (filters.startDate && filters.endDate) {
      where.businessDate = {
        gte: parseBusinessDate(filters.startDate),
        lte: parseBusinessDate(filters.endDate),
      };
    }

    const [items, total] = await Promise.all([
      this.prisma.payment.findMany({ where, skip, take, orderBy: { businessDate: 'desc' } }),
      this.prisma.payment.count({ where }),
    ]);

    return paginatedResponse(
      items.map((p) => ({ ...p, amount: toMoneyString(p.amount) })),
      total,
      paginationDto.page || 1,
      paginationDto.limit || 20,
    );
  }
}

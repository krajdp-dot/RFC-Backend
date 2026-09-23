import { Injectable, Inject, BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { normalizePhone } from '../../common/utils/phone.util.js';
import { toMoneyString } from '../../common/utils/money.util.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { WHATSAPP_PROVIDER } from './whatsapp.constants.js';
import { WhatsAppProvider } from './providers/whatsapp-provider.interface.js';
import { renderTemplate, renderCustomMessage, formatAmountForMessage, TemplateKey } from './templates.js';

export class WhatsAppOptInRequiredError extends BadRequestException {
  constructor() {
    super({
      message: "This customer hasn't opted in to WhatsApp messages yet.",
      code: 'WHATSAPP_OPT_IN_REQUIRED',
    });
  }
}

export class WhatsAppNumberMissingError extends BadRequestException {
  constructor() {
    super({ message: 'This customer has no valid WhatsApp number on file.', code: 'WHATSAPP_NUMBER_MISSING' });
  }
}

interface EnqueueInput {
  customerId: string;
  userId: string | null;
  templateKey: TemplateKey;
  variables: Record<string, string>;
  idempotencyKey: string;
  relatedEntityType?: string;
  relatedEntityId?: string;
  /** Automated sends (from the event listener) don't throw on missing opt-in/number — they just don't send. A person explicitly clicking Send gets a clear error instead, because they're waiting on it. */
  silent?: boolean;
}

@Injectable()
export class WhatsAppService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  /**
   * Section 22/23: outstanding and statement figures are never
   * recomputed here — this calls straight into the same customer service
   * logic every other screen uses, so there is exactly one place that
   * calculates a customer's outstanding.
   */
  private async resolveCustomer(businessId: string, customerId: string) {
    const customer = await this.prisma.customer.findFirst({ where: { id: customerId, businessId } });
    if (!customer) throw new NotFoundException('Customer not found');
    return customer;
  }

  private recipientFor(customer: { phone: string | null; whatsappNumber: string | null }): string | null {
    const normalized = normalizePhone(customer.whatsappNumber || customer.phone);
    return normalized.valid ? normalized.e164 : null;
  }

  /**
   * The one place every send passes through — opt-in (section 8),
   * idempotency (section 30), and message-record creation all happen
   * here exactly once, regardless of which specific "send X" method
   * called it.
   */
  private async enqueue(businessId: string, input: EnqueueInput) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.whatsAppMessage.findFirst({
        where: { businessId, idempotencyKey: input.idempotencyKey },
      });
      if (existing) return existing;

      const customer = await tx.customer.findFirst({ where: { id: input.customerId, businessId } });
      if (!customer) throw new NotFoundException('Customer not found');

      if (!customer.whatsappOptIn) {
        if (input.silent) return null;
        throw new WhatsAppOptInRequiredError();
      }

      const recipient = this.recipientFor(customer);
      if (!recipient) {
        if (input.silent) return null;
        throw new WhatsAppNumberMissingError();
      }

      const { text, messageType, templateName } = renderTemplate(input.templateKey, input.variables);

      const message = await tx.whatsAppMessage.create({
        data: {
          businessId,
          customerId: customer.id,
          userId: input.userId,
          provider: this.provider.name,
          messageType,
          templateName,
          templateVariables: input.variables,
          recipient,
          contentSnapshot: text,
          status: 'QUEUED',
          idempotencyKey: input.idempotencyKey,
          relatedEntityType: input.relatedEntityType,
          relatedEntityId: input.relatedEntityId,
        },
      });

      await this.auditService.record(tx, {
        businessId,
        userId: input.userId,
        action: 'CREATE',
        entityType: 'WHATSAPP_MESSAGE',
        entityId: message.id,
        after: { templateName, recipient, relatedEntityType: input.relatedEntityType, relatedEntityId: input.relatedEntityId },
      });

      return message;
    });
  }

  // ---- Sale confirmation (section 20) -----------------------------------

  async sendSaleConfirmation(businessId: string, saleId: string, userId: string | null, silent = false) {
    const sale = await this.prisma.sale.findFirst({ where: { id: saleId, businessId } });
    if (!sale) throw new NotFoundException('Sale not found');

    const customer = await this.resolveCustomer(businessId, sale.customerId);
    const items = await this.prisma.saleItem.findMany({ where: { saleId: sale.id } });
    const productIds = [...new Set(items.map((item: any) => item.productId))];
    const products = productIds.length
      ? await this.prisma.product.findMany({ where: { id: { in: productIds } } })
      : [];
    const productNameById = new Map(products.map((p: any) => [p.id, p.name]));

    const itemLines = items
      .map(
        (item: any) =>
          `${item.quantity} x ${productNameById.get(item.productId) ?? 'Product'} @ \u20b9${formatAmountForMessage(item.rate.toString())}`,
      )
      .join('\n');

    return this.enqueue(businessId, {
      customerId: sale.customerId,
      userId,
      templateKey: 'SALE_CONFIRMATION',
      variables: {
        customer_name: customer.name,
        items: itemLines,
        total: formatAmountForMessage(sale.total.toString()),
      },
      idempotencyKey: `SALE:${sale.id}:SALE_CONFIRMATION`,
      relatedEntityType: 'SALE',
      relatedEntityId: sale.id,
      silent,
    });
  }

  // ---- Payment receipt (section 21) --------------------------------------
  // "Never let staff manually type the amount" — every value below is
  // read straight off the authoritative Payment row, never from a
  // parameter the caller supplies.

  async sendPaymentReceipt(businessId: string, paymentId: string, userId: string | null, silent = false) {
    const payment = await this.prisma.payment.findFirst({ where: { id: paymentId, businessId } });
    if (!payment) throw new NotFoundException('Payment not found');
    if (!payment.customerId) {
      throw new BadRequestException('This payment has no customer to notify (a supplier payment, perhaps).');
    }
    const customer = await this.resolveCustomer(businessId, payment.customerId);

    return this.enqueue(businessId, {
      customerId: payment.customerId,
      userId,
      templateKey: 'PAYMENT_RECEIPT',
      variables: {
        customer_name: customer.name,
        amount: formatAmountForMessage(payment.amount.toString()),
        payment_mode: payment.method,
        date: payment.businessDate.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }),
      },
      idempotencyKey: `PAYMENT:${payment.id}:PAYMENT_RECEIPT`,
      relatedEntityType: 'PAYMENT',
      relatedEntityId: payment.id,
      silent,
    });
  }

  // ---- Outstanding reminder / statement (sections 22-23) -----------------
  // customersService is not injected here to avoid a circular module
  // dependency; getCustomerAging's logic is one straightforward Prisma
  // query, so it's called the same way rather than re-implemented — see
  // getOutstanding() below, which is the exact aging total calculation
  // customers.service.ts uses for the same figure everywhere else.

  private async getOutstanding(businessId: string, customerId: string): Promise<string> {
    const sales = await this.prisma.sale.findMany({
      where: { customerId, businessId, status: { not: 'VOID' } },
      select: { total: true, received: true },
    });
    const outstanding = sales.reduce((sum, s) => sum + (Number(s.total) - Number(s.received || 0)), 0);
    return toMoneyString(Math.max(0, outstanding));
  }

  async sendOutstandingReminder(businessId: string, customerId: string, userId: string | null, silent = false) {
    const customer = await this.resolveCustomer(businessId, customerId);
    const outstanding = await this.getOutstanding(businessId, customerId);

    return this.enqueue(businessId, {
      customerId,
      userId,
      templateKey: 'OUTSTANDING_REMINDER',
      variables: { customer_name: customer.name, outstanding: formatAmountForMessage(outstanding) },
      idempotencyKey: `CUSTOMER:${customerId}:OUTSTANDING_REMINDER:${new Date().toISOString().slice(0, 10)}`,
      relatedEntityType: 'CUSTOMER',
      relatedEntityId: customerId,
      silent,
    });
  }

  async sendStatement(businessId: string, customerId: string, userId: string | null, mutationId?: string) {
    const customer = await this.resolveCustomer(businessId, customerId);
    const [sales, payments] = await Promise.all([
      this.prisma.sale.findMany({ where: { customerId, businessId, status: { not: 'VOID' } }, select: { total: true } }),
      this.prisma.payment.findMany({ where: { customerId, businessId, status: 'COMPLETED' }, select: { amount: true } }),
    ]);
    const totalSales = sales.reduce((sum, s) => sum + Number(s.total), 0);
    const totalPayments = payments.reduce((sum, p) => sum + Number(p.amount), 0);
    const outstanding = await this.getOutstanding(businessId, customerId);

    return this.enqueue(businessId, {
      customerId,
      userId,
      templateKey: 'STATEMENT',
      variables: {
        customer_name: customer.name,
        opening: '0', // this business has no separate opening-balance-per-customer concept today — see PHASE-12-REPORT.md
        sales: formatAmountForMessage(totalSales),
        payments: formatAmountForMessage(totalPayments),
        outstanding: formatAmountForMessage(outstanding),
      },
      // Statements are point-in-time snapshots a person can reasonably
      // ask for more than once in a day (figures change as the day goes
      // on), so — unlike a confirmation/receipt tied to one immutable
      // transaction — there's no natural fixed key to dedupe on. The
      // caller (the WhatsApp panel) generates a UUID once per dialog
      // open, the same pattern sendCustomMessage and Phase 9/11's
      // idempotencyKey convention already use, so a double-tap on Send
      // reuses it and dedupes reliably. Falling back to a timestamp when
      // none is given keeps this callable without one, but a millisecond
      // collision was never a reliable guarantee — this is deliberately
      // now the secondary path, not the primary one.
      // after the first.
      idempotencyKey: mutationId ? `CUSTOMER:${customerId}:STATEMENT:${mutationId}` : `CUSTOMER:${customerId}:STATEMENT:${Date.now()}`,
      relatedEntityType: 'CUSTOMER',
      relatedEntityId: customerId,
    });
  }

  // ---- Custom message (section 40) ---------------------------------------

  async sendCustomMessage(businessId: string, customerId: string, userId: string | null, content: string, mutationId: string) {
    const customer = await this.resolveCustomer(businessId, customerId);
    if (!customer.whatsappOptIn) throw new WhatsAppOptInRequiredError();
    const recipient = this.recipientFor(customer);
    if (!recipient) throw new WhatsAppNumberMissingError();

    const text = renderCustomMessage(content);
    if (!text) throw new BadRequestException('Message content is empty.');

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.whatsAppMessage.findFirst({ where: { businessId, idempotencyKey: mutationId } });
      if (existing) return existing;

      const message = await tx.whatsAppMessage.create({
        data: {
          businessId,
          customerId,
          userId,
          provider: this.provider.name,
          messageType: 'SERVICE',
          templateName: null,
          recipient,
          contentSnapshot: text,
          status: 'QUEUED',
          idempotencyKey: mutationId,
          relatedEntityType: 'CUSTOM',
        },
      });

      await this.auditService.record(tx, {
        businessId,
        userId,
        action: 'CREATE',
        entityType: 'WHATSAPP_MESSAGE',
        entityId: message.id,
        after: { templateName: null, recipient, relatedEntityType: 'CUSTOM' },
      });

      return message;
    });
  }

  // ---- Opt-in / opt-out (section 8) --------------------------------------

  async setOptIn(businessId: string, customerId: string, userId: string | null, optIn: boolean) {
    const customer = await this.resolveCustomer(businessId, customerId);
    const now = new Date();
    const updated = await this.prisma.customer.update({
      where: { id: customerId },
      data: optIn
        ? { whatsappOptIn: true, whatsappOptInAt: now, whatsappOptOutAt: null }
        : { whatsappOptIn: false, whatsappOptOutAt: now },
    });

    await this.auditService.recordStandalone({
      businessId,
      userId,
      action: 'UPDATE',
      entityType: 'CUSTOMER_WHATSAPP_CONSENT',
      entityId: customerId,
      before: { whatsappOptIn: customer.whatsappOptIn },
      after: { whatsappOptIn: updated.whatsappOptIn },
    });

    return updated;
  }

  // ---- Automation settings (sections 28-29) ------------------------------

  async getAutomationSettings(businessId: string) {
    const existing = await this.prisma.whatsAppAutomationSetting.findUnique({ where: { businessId } });
    return (
      existing ?? {
        businessId,
        saleConfirmationEnabled: false,
        paymentReceiptEnabled: false,
        outstandingReminderEnabled: false,
      }
    );
  }

  async updateAutomationSettings(
    businessId: string,
    userId: string | null,
    changes: Partial<{ saleConfirmationEnabled: boolean; paymentReceiptEnabled: boolean; outstandingReminderEnabled: boolean }>,
  ) {
    const before = await this.getAutomationSettings(businessId);
    const existing = await this.prisma.whatsAppAutomationSetting.findFirst({ where: { businessId } });

    const updated = existing
      ? await this.prisma.whatsAppAutomationSetting.update({
          where: { id: existing.id },
          data: { updatedBy: userId, ...changes },
        })
      : await this.prisma.whatsAppAutomationSetting.create({
          data: { businessId, updatedBy: userId, ...changes },
        });

    await this.auditService.recordStandalone({
      businessId,
      userId,
      action: 'UPDATE',
      entityType: 'WHATSAPP_AUTOMATION_SETTINGS',
      entityId: updated.id,
      before,
      after: updated,
    });

    return updated;
  }

  // ---- History / search (sections 41-42) ---------------------------------

  async listMessages(
    businessId: string,
    filters: { customerId?: string; status?: string; messageType?: string },
    pagination: PaginationDto,
  ) {
    const where = { businessId, ...filters };
    const [items, total] = await Promise.all([
      this.prisma.whatsAppMessage.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: pagination.skip,
        take: pagination.take,
      }),
      this.prisma.whatsAppMessage.count({ where }),
    ]);
    return paginatedResponse(items, total, pagination.page || 1, pagination.limit || 20);
  }

  async getMessage(businessId: string, id: string) {
    const message = await this.prisma.whatsAppMessage.findFirst({ where: { id, businessId } });
    if (!message) throw new NotFoundException('Message not found');
    return message;
  }
}

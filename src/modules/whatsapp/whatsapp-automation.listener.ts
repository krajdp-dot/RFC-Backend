import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WhatsAppService } from './whatsapp.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * Phase 12, section 27 — SalesService and PaymentsService know nothing
 * about WhatsApp; they emit a plain "this happened" event and this
 * listener decides whether it becomes a message. Section 28-29:
 * automation is off by default per business, per message type — this is
 * the one place that checks WhatsAppAutomationSetting before ever
 * calling WhatsAppService.
 *
 * Every send here passes `silent: true` — an automated send that finds
 * no opt-in or no valid number simply doesn't send (there is no person
 * waiting on a response to show an error to); a person explicitly
 * clicking "Send confirmation" gets a real error instead (see
 * whatsapp.controller.ts), because they're the one waiting on it.
 */
@Injectable()
export class WhatsAppAutomationListener {
  private readonly logger = new Logger(WhatsAppAutomationListener.name);

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly prisma: PrismaService,
  ) {}

  @OnEvent('sale.created')
  async onSaleCreated({ businessId, saleId }: { businessId: string; saleId: string }) {
    const settings = await this.prisma.whatsAppAutomationSetting.findUnique({ where: { businessId } });
    if (!settings?.saleConfirmationEnabled) return;

    try {
      await this.whatsapp.sendSaleConfirmation(businessId, saleId, null, /* silent */ true);
    } catch (err) {
      // An automated attempt failing must never affect the sale it's
      // about (section 33) — log and stop, nothing more.
      this.logger.warn(`Automated sale confirmation failed for sale ${saleId}: ${err instanceof Error ? err.message : err}`);
    }
  }

  @OnEvent('payment.received')
  async onPaymentReceived({ businessId, paymentId }: { businessId: string; paymentId: string }) {
    const settings = await this.prisma.whatsAppAutomationSetting.findUnique({ where: { businessId } });
    if (!settings?.paymentReceiptEnabled) return;

    try {
      await this.whatsapp.sendPaymentReceipt(businessId, paymentId, null, true);
    } catch (err) {
      this.logger.warn(`Automated payment receipt failed for payment ${paymentId}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

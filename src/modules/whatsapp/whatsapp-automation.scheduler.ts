import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { WhatsAppService } from './whatsapp.service.js';

/**
 * Phase 12, sections 28-29 — sale confirmation and payment receipt
 * automation hang off a real event (SalesService/PaymentsService just
 * emitted one). "Outstanding threshold reached" has no equivalent
 * moment — nothing creates or changes when a balance quietly gets old —
 * so it has to be a periodic check instead of an event listener.
 *
 * Scope decision, documented rather than hidden: the threshold is a
 * fixed constant, not a per-business configurable amount. Section 29's
 * mockup only asks for an ON/OFF toggle per message type, and this
 * codebase has no other per-business numeric settings to model that on
 * (Phase 10's automation settings are all booleans) — a configurable
 * amount is a reasonable follow-up, not something this pass silently
 * skipped. See PHASE-12-REPORT.md, "Known limitations".
 *
 * Reminders are safe to run more than once a day: sendOutstandingReminder
 * already builds its idempotency key with today's date baked in, so a
 * second run (a manual retry, a redeploy) sends nothing twice.
 */
const OUTSTANDING_REMINDER_THRESHOLD = 1000;

@Injectable()
export class WhatsAppAutomationScheduler {
  private readonly logger = new Logger(WhatsAppAutomationScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly whatsapp: WhatsAppService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_9AM)
  async sendDailyOutstandingReminders() {
    await this.runForAllBusinesses();
  }

  /** Extracted so a test (or a manual admin trigger later) can run this without waiting for 9am. */
  async runForAllBusinesses(): Promise<{ sent: number; skipped: number }> {
    const businesses = await this.prisma.whatsAppAutomationSetting.findMany({
      where: { outstandingReminderEnabled: true },
      select: { businessId: true },
    });

    let sent = 0;
    let skipped = 0;

    for (const { businessId } of businesses) {
      const customers = await this.prisma.customer.findMany({
        where: { businessId, active: true, whatsappOptIn: true },
        select: { id: true },
      });
      const sales = await this.prisma.sale.findMany({
        where: { businessId, status: { not: 'VOID' } },
        select: { customerId: true, total: true, received: true },
      });
      const outstandingByCustomer = new Map<string, number>();
      for (const sale of sales) {
        const prior = outstandingByCustomer.get(sale.customerId) ?? 0;
        outstandingByCustomer.set(sale.customerId, prior + (Number(sale.total) - Number(sale.received || 0)));
      }

      for (const customer of customers) {
        const outstanding = outstandingByCustomer.get(customer.id) ?? 0;
        if (outstanding < OUTSTANDING_REMINDER_THRESHOLD) {
          skipped++;
          continue;
        }
        try {
          await this.whatsapp.sendOutstandingReminder(businessId, customer.id, null, true);
          sent++;
        } catch (err) {
          this.logger.warn(
            `Automated outstanding reminder failed for customer ${customer.id}: ${err instanceof Error ? err.message : err}`,
          );
          skipped++;
        }
      }
    }

    return { sent, skipped };
  }
}

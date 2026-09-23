import { Injectable, Inject, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { WHATSAPP_PROVIDER } from './whatsapp.constants.js';
import { WhatsAppProvider, WhatsAppProviderError } from './providers/whatsapp-provider.interface.js';

/**
 * Phase 12, section 32 — the async send step: a QUEUED WhatsAppMessage
 * row is the job; this processor is the worker. No Redis/Bull — this
 * business's message volume (dozens to low hundreds a day, per the
 * capability matrix this phase actually built) doesn't need one, and
 * @nestjs/schedule's @Interval is the same "reuse what's proportionate"
 * call Phase 11 made for the frontend sync engine, just server-side.
 *
 * Rate limiting (section 31) happens at two points: BATCH_SIZE caps how
 * many the worker sends per tick regardless of how many are queued, and
 * — more importantly, since it stops a flood before it's even
 * created — the controller's send endpoints carry their own
 * per-user @Throttle() (see whatsapp.controller.ts).
 */
const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const TICK_MS = 5000;

@Injectable()
export class WhatsAppQueueProcessor {
  private readonly logger = new Logger(WhatsAppQueueProcessor.name);
  // Test-only: set true to stop @Interval from double-processing while a
  // test drives processQueue() directly and deterministically.
  public paused = false;

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  @Interval(TICK_MS)
  async onTick() {
    if (this.paused) return;
    await this.processQueue();
  }

  async processQueue(): Promise<{ sent: number; failed: number; stillQueued: number }> {
    const batch = await this.prisma.whatsAppMessage.findMany({
      where: { status: 'QUEUED', attemptCount: { lt: MAX_ATTEMPTS } },
      orderBy: { createdAt: 'asc' },
      take: BATCH_SIZE,
    });

    const result = { sent: 0, failed: 0, stillQueued: 0 };
    for (const message of batch) {
      const outcome = await this.processOne(message);
      result[outcome]++;
    }
    return result;
  }

  private async processOne(message: {
    id: string;
    recipient: string;
    templateName: string | null;
    templateVariables: unknown;
    contentSnapshot: string;
    attemptCount: number;
  }): Promise<'sent' | 'failed' | 'stillQueued'> {
    const nextAttempt = message.attemptCount + 1;
    await this.prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: { status: 'SENDING', attemptCount: nextAttempt },
    });

    try {
      const result = await this.provider.sendTemplateMessage({
        to: message.recipient,
        templateName: message.templateName ?? 'custom_message',
        variables: (message.templateVariables as Record<string, string>) ?? {},
        renderedText: message.contentSnapshot,
      });

      await this.prisma.whatsAppMessage.update({
        where: { id: message.id },
        data: { status: 'SENT', providerMessageId: result.providerMessageId, sentAt: new Date() },
      });
      return 'sent';
    } catch (err) {
      const providerError = err instanceof WhatsAppProviderError;
      const retryable = providerError ? err.retryable : true; // an unexpected non-provider error: assume transient, don't burn the message on attempt 1
      const code = providerError ? err.code : 'UNKNOWN_ERROR';
      const reason = err instanceof Error ? err.message : 'Unknown error';

      if (retryable && nextAttempt < MAX_ATTEMPTS) {
        // Back to QUEUED for the next tick — never FAILED for something
        // that might just be a blip (section 33-34: RFC keeps working,
        // and a WhatsApp hiccup shouldn't need a person to intervene).
        await this.prisma.whatsAppMessage.update({
          where: { id: message.id },
          data: { status: 'QUEUED', failureCode: code, failureReason: reason },
        });
        this.logger.warn(`WhatsApp send retry ${nextAttempt}/${MAX_ATTEMPTS} for ${message.id}: ${code}`);
        return 'stillQueued';
      }

      await this.prisma.whatsAppMessage.update({
        where: { id: message.id },
        data: { status: 'FAILED', failedAt: new Date(), failureCode: code, failureReason: reason },
      });
      this.logger.error(`WhatsApp send failed permanently for ${message.id}: ${code} — ${reason}`);
      return 'failed';
    }
  }
}

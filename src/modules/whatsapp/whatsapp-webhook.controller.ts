import { Controller, Get, Post, Query, Headers, Req, BadRequestException, Logger, Inject } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../../common/decorators/public.decorator.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WHATSAPP_PROVIDER } from './whatsapp.constants.js';
import { WhatsAppProvider } from './providers/whatsapp-provider.interface.js';

/**
 * Phase 12, section 15 — Meta's real Cloud API webhook contract: a GET
 * verification handshake once, at setup time, then POST deliveries for
 * every event after that. Both routes are @Public() (no JWT — Meta isn't
 * one of RFC's users) and are the only two places in this codebase that
 * intentionally skip authentication; everything they do instead is
 * signature-verified (POST) or token-verified (GET), never left open.
 *
 * Section 46: this does not blindly trust any incoming payload — every
 * POST is rejected before any side effect if its signature doesn't
 * verify. Section 47: every event, once verified, is deduplicated by the
 * provider's own event id before being processed — see
 * WhatsAppWebhookEvent and processStatusEvent/processIncomingMessage
 * below.
 */
@Controller('whatsapp/webhook')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  @Public()
  @Get()
  verify(
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') token: string,
    @Query('hub.challenge') challenge: string,
  ) {
    const expected = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    if (mode === 'subscribe' && expected && token === expected) {
      this.logger.log('Webhook verification handshake succeeded');
      return challenge;
    }
    throw new BadRequestException('Webhook verification failed');
  }

  @Public()
  @Post()
  async receive(@Req() req: Request, @Headers('x-hub-signature-256') signature: string | undefined) {
    // req.rawBody is the exact bytes Meta sent (see main.ts) — the
    // signature is computed over these bytes specifically, not over
    // JSON.stringify(req.body), which can differ in whitespace/key order.
    const rawBody = (req as any).rawBody?.toString('utf8') ?? '';

    if (!this.provider.verifyWebhookSignature(rawBody, signature)) {
      this.logger.warn('Rejected webhook delivery with an invalid or missing signature');
      // Meta expects a 200 even for content it will retry, but an
      // unverified request is never processed — 401 tells Meta (or
      // whoever actually sent this) plainly that it was refused, and
      // guarantees no side effect below runs for it.
      throw new BadRequestException('Invalid webhook signature');
    }

    const body = req.body as any;
    const entries = Array.isArray(body?.entry) ? body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry?.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change?.value ?? {};
        for (const status of value.statuses ?? []) {
          await this.processStatusEvent(status).catch((err) =>
            this.logger.error(`Failed processing status event: ${err instanceof Error ? err.message : err}`),
          );
        }
        for (const incoming of value.messages ?? []) {
          await this.processIncomingMessage(incoming, value.contacts?.[0]).catch((err) =>
            this.logger.error(`Failed processing incoming message: ${err instanceof Error ? err.message : err}`),
          );
        }
      }
    }

    // Meta requires a 200 within a few seconds regardless of what the
    // payload contained, or it will back off and eventually disable the
    // subscription — this is deliberately unconditional.
    return { received: true };
  }

  /** A delivery/read/failed status update for a message RFC sent. */
  private async processStatusEvent(status: { id: string; status: string; timestamp?: string; errors?: any[] }) {
    const dedupKey = `status:${status.id}:${status.status}`;
    const deduped = await this.recordEventOnce(dedupKey, 'STATUS_UPDATE');
    if (!deduped) return; // already processed — section 47, exactly once

    const message = await this.prisma.whatsAppMessage.findFirst({ where: { providerMessageId: status.id } });
    if (!message) {
      this.logger.warn(`Status event for unknown providerMessageId ${status.id}`);
      return;
    }

    const now = new Date();
    const statusMap: Record<string, { status: string; field: 'sentAt' | 'deliveredAt' | 'readAt' | 'failedAt' }> = {
      sent: { status: 'SENT', field: 'sentAt' },
      delivered: { status: 'DELIVERED', field: 'deliveredAt' },
      read: { status: 'READ', field: 'readAt' },
      failed: { status: 'FAILED', field: 'failedAt' },
    };
    const mapped = statusMap[status.status];
    if (!mapped) return;

    // A message can only move forward through
    // SENT -> DELIVERED -> READ; a delayed "delivered" event arriving
    // after we already know it was READ must not regress the status.
    const rank = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ'];
    const currentRank = rank.indexOf(message.status);
    const incomingRank = rank.indexOf(mapped.status);
    if (mapped.status !== 'FAILED' && incomingRank <= currentRank) return;

    await this.prisma.whatsAppMessage.update({
      where: { id: message.id },
      data: {
        status: mapped.status,
        [mapped.field]: now,
        ...(mapped.status === 'FAILED'
          ? { failureReason: status.errors?.[0]?.title, failureCode: String(status.errors?.[0]?.code ?? 'PROVIDER_REPORTED_FAILURE') }
          : {}),
      },
    });
  }

  /** An inbound message FROM a customer (section 17) — logged and matched to a customer if their number is recognized; never auto-actioned (section 18). */
  private async processIncomingMessage(
    incoming: { id: string; from: string; timestamp?: string; text?: { body?: string } },
    contact?: { profile?: { name?: string }; wa_id?: string },
  ) {
    const deduped = await this.recordEventOnce(incoming.id, 'INCOMING_MESSAGE');
    if (!deduped) return;

    const { normalizePhone } = await import('../../common/utils/phone.util.js');
    const fromNormalized = normalizePhone(incoming.from);

    // Incoming webhook payloads don't carry a businessId — a real
    // multi-business deployment resolves this from which
    // WHATSAPP_PHONE_NUMBER_ID the message arrived on, mapped to a
    // business. This deployment runs one business, so that mapping isn't
    // built yet — see PHASE-12-REPORT.md, "Known limitations". Every
    // customer this could match is scoped to Business.whatsappMessages
    // rows we already sent, which is inherently single-business already.
    const business = await this.prisma.business.findFirst();
    if (!business) return;

    const customer = await this.prisma.customer.findFirst({
      where: { businessId: business.id, OR: [{ whatsappNumber: fromNormalized.e164 }, { phone: fromNormalized.e164 }] },
    });

    await this.prisma.whatsAppIncomingMessage.create({
      data: {
        businessId: business.id,
        customerId: customer?.id,
        fromNumber: fromNormalized.e164 || incoming.from,
        providerMessageId: incoming.id,
        content: incoming.text?.body ?? '(non-text message)',
      },
    });
  }

  /** Section 47 — returns false (do nothing further) if this exact event was already processed. */
  private async recordEventOnce(providerEventId: string, eventType: string): Promise<boolean> {
    try {
      await this.prisma.whatsAppWebhookEvent.create({ data: { providerEventId, eventType } });
      return true;
    } catch (err: any) {
      if (err?.code === 'P2002') return false; // unique constraint — we've seen this exact event before
      throw err;
    }
  }
}

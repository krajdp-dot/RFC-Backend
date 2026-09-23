import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  WhatsAppProvider,
  SendTemplateParams,
  SendResult,
  WhatsAppProviderError,
} from './whatsapp-provider.interface.js';

/**
 * Phase 12, section 4 — the official Meta WhatsApp Business Cloud API
 * only. No WhatsApp Web automation, no QR-session hacks, no scraping —
 * this calls graph.facebook.com the way Meta's own documentation
 * describes, with a server-side access token that never reaches the
 * browser (section 5).
 *
 * This class is written to the real Cloud API contract but has never been
 * exercised against Meta's live servers in this environment — there are
 * no real WHATSAPP_* credentials here to test with. See
 * PHASE-12-REPORT.md, "Live provider verification: NOT VERIFIED". It is
 * only selected at runtime when real credentials are present (see
 * provider.factory.ts); otherwise FakeWhatsAppProvider runs instead, so
 * the system never silently pretends to have sent something it didn't.
 */
@Injectable()
export class MetaCloudApiProvider implements WhatsAppProvider {
  readonly name = 'meta_cloud_api';
  private readonly logger = new Logger(MetaCloudApiProvider.name);
  private readonly graphVersion = 'v21.0';

  constructor(private readonly config: ConfigService) {}

  private get accessToken(): string {
    return this.config.get<string>('WHATSAPP_ACCESS_TOKEN', '');
  }

  private get phoneNumberId(): string {
    return this.config.get<string>('WHATSAPP_PHONE_NUMBER_ID', '');
  }

  private get appSecret(): string {
    return this.config.get<string>('WHATSAPP_APP_SECRET', '');
  }

  async sendTemplateMessage(params: SendTemplateParams): Promise<SendResult> {
    const url = `https://graph.facebook.com/${this.graphVersion}/${this.phoneNumberId}/messages`;

    // Meta template messages take positional {{1}}, {{2}}... parameters,
    // not named ones — the mapping from our named {{customer_name}} etc.
    // to that positional order lives with each template definition (see
    // templates.ts), passed in here as an already-ordered array on
    // params so this provider stays generic across every template.
    const body = {
      messaging_product: 'whatsapp',
      to: params.to.replace(/^\+/, ''), // Cloud API wants digits only, no '+'
      type: 'template',
      template: {
        name: params.templateName,
        language: { code: 'en' },
        components: [
          {
            type: 'body',
            parameters: Object.values(params.variables).map((value) => ({ type: 'text', text: value })),
          },
        ],
      },
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Never reached the provider at all — DNS, network, timeout.
      throw new WhatsAppProviderError(
        err instanceof Error ? err.message : 'Network error contacting WhatsApp provider',
        'NETWORK_ERROR',
        true,
      );
    }

    const data = await response.json().catch(() => ({}) as any);

    if (!response.ok) {
      // Meta's error envelope: { error: { message, type, code, error_subcode, fbtrace_id } }
      const message = data?.error?.message || `WhatsApp provider returned ${response.status}`;
      const code = data?.error?.code ? String(data.error.code) : `HTTP_${response.status}`;
      // 429 and 5xx are the provider's own signal that a retry might
      // succeed later; everything else (bad template name, invalid
      // number, permission error) will fail identically on retry.
      const retryable = response.status === 429 || response.status >= 500;
      this.logger.warn(`WhatsApp send failed: ${code} ${message}`);
      throw new WhatsAppProviderError(message, code, retryable);
    }

    const providerMessageId = data?.messages?.[0]?.id;
    if (!providerMessageId) {
      throw new WhatsAppProviderError('WhatsApp provider accepted the request but returned no message id', 'NO_MESSAGE_ID', false);
    }

    return { providerMessageId };
  }

  /**
   * Meta signs every webhook POST body with HMAC-SHA256 over the raw
   * request bytes, keyed with the app secret, sent as
   * `X-Hub-Signature-256: sha256=<hex>` — this is Meta's standard
   * cross-platform webhook signature scheme (the same one Messenger and
   * Instagram webhooks use), not something specific to WhatsApp.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean {
    if (!signatureHeader || !this.appSecret) return false;
    const [scheme, providedHex] = signatureHeader.split('=');
    if (scheme !== 'sha256' || !providedHex) return false;

    const expectedHex = createHmac('sha256', this.appSecret).update(rawBody, 'utf8').digest('hex');

    const provided = Buffer.from(providedHex, 'hex');
    const expected = Buffer.from(expectedHex, 'hex');
    // Constant-time comparison — a naive === here would let a forged
    // request be verified byte-by-byte via response-timing (section 46:
    // "test forged webhook requests").
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }
}

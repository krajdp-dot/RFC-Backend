import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  WhatsAppProvider,
  SendTemplateParams,
  SendResult,
} from './whatsapp-provider.interface.js';

/**
 * Phase 12, section 56 — with no real Meta credentials in this
 * environment, this is what actually runs unless WHATSAPP_PROVIDER=
 * meta_cloud_api and real credentials are configured (see
 * provider.factory.ts). It never claims a message reached a real phone —
 * every send is logged clearly as fake, and its "delivered"/"read"
 * progression only exists so the rest of the system (status polling, the
 * Sync Center-style history view) has something real to react to in
 * development and tests, not to simulate a working integration.
 */
@Injectable()
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'fake';
  private readonly logger = new Logger(FakeWhatsAppProvider.name);

  /** Test-only hook: set to make the next N sends fail, to exercise retry/failure paths without real network conditions. */
  public failNextSends = 0;
  public lastFailure: { code: string; retryable: boolean } = { code: 'SIMULATED_FAILURE', retryable: true };

  async sendTemplateMessage(params: SendTemplateParams): Promise<SendResult> {
    if (this.failNextSends > 0) {
      this.failNextSends--;
      const { WhatsAppProviderError } = await import('./whatsapp-provider.interface.js');
      throw new WhatsAppProviderError('Simulated provider failure', this.lastFailure.code, this.lastFailure.retryable);
    }

    const providerMessageId = `fake_wamid_${randomUUID()}`;
    this.logger.log(
      `[FAKE PROVIDER — not a real send] to=${params.to} template=${params.templateName} id=${providerMessageId}`,
    );
    return { providerMessageId };
  }

  verifyWebhookSignature(_rawBody: string, signatureHeader: string | undefined): boolean {
    // The fake provider's own test webhook sender signs with this literal
    // marker instead of a real HMAC, so tests can exercise the "signature
    // valid" path without needing a real app secret.
    return signatureHeader === 'fake-valid-signature';
  }
}

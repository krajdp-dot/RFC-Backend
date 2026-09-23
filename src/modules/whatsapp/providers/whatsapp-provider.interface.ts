/**
 * Phase 12, section 3 — the one seam between RFC and an actual WhatsApp
 * provider. Every send in this codebase goes through something
 * implementing this interface; nothing calls a provider's HTTP API
 * directly from anywhere else (section 3: "do not build customer →
 * random WhatsApp HTTP calls everywhere").
 *
 * Two implementations exist: MetaCloudApiProvider (real, section 4 —
 * official Meta Cloud API only, never web-scraping or session hacks) and
 * FakeWhatsAppProvider (deterministic, in-memory — used by every test,
 * and as the actual runtime provider whenever real credentials aren't
 * configured, so this system is honestly runnable without pretending a
 * live integration exists — section 56).
 */

export interface SendTemplateParams {
  /** E.164 form, e.g. "+919876543210" — see phone.util.ts. */
  to: string;
  templateName: string;
  /** Plain-text values only (section 11) — the template renderer has already escaped/validated these before the provider ever sees them. */
  variables: Record<string, string>;
  /** The fully-rendered text, kept alongside the template name/variables so a provider that just sends text (like the fake, or a fallback path) has something to send. */
  renderedText: string;
}

export interface SendResult {
  providerMessageId: string;
}

export interface WhatsAppProvider {
  readonly name: string;
  sendTemplateMessage(params: SendTemplateParams): Promise<SendResult>;
  /**
   * Verifies a webhook payload actually came from this provider.
   * rawBody must be the exact, unparsed request body — signature schemes
   * are computed over raw bytes, not the re-serialized JSON, which can
   * differ in whitespace/key order from what was actually signed.
   */
  verifyWebhookSignature(rawBody: string, signatureHeader: string | undefined): boolean;
}

export class WhatsAppProviderError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'WhatsAppProviderError';
  }
}

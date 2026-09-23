import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { MetaCloudApiProvider } from './meta-cloud-api.provider.js';

/**
 * sendTemplateMessage itself needs a real network call to verify beyond
 * "does it build the right request" — that verification genuinely cannot
 * happen in this environment (no live Meta credentials exist here; see
 * PHASE-12-REPORT.md, "Live provider verification: NOT VERIFIED"). What
 * CAN and must be verified without any live credentials is the webhook
 * signature check, since section 46 explicitly requires testing forged
 * requests — that's pure HMAC math, the same math a forger and this
 * provider both have to get right.
 */
describe('MetaCloudApiProvider.verifyWebhookSignature', () => {
  const APP_SECRET = 'test-app-secret';

  function providerWith(appSecret: string | undefined) {
    const config = { get: (key: string) => (key === 'WHATSAPP_APP_SECRET' ? appSecret : '') } as unknown as ConfigService;
    return new MetaCloudApiProvider(config);
  }

  function sign(body: string, secret: string): string {
    return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
  }

  it('accepts a correctly signed body', () => {
    const provider = providerWith(APP_SECRET);
    const body = JSON.stringify({ entry: [] });
    expect(provider.verifyWebhookSignature(body, sign(body, APP_SECRET))).toBe(true);
  });

  it('rejects a body signed with the wrong secret (a forged request, section 46)', () => {
    const provider = providerWith(APP_SECRET);
    const body = JSON.stringify({ entry: [] });
    expect(provider.verifyWebhookSignature(body, sign(body, 'wrong-secret'))).toBe(false);
  });

  it('rejects when the body was tampered with after signing', () => {
    const provider = providerWith(APP_SECRET);
    const originalBody = JSON.stringify({ entry: [] });
    const signature = sign(originalBody, APP_SECRET);
    const tamperedBody = JSON.stringify({ entry: [{ injected: true }] });
    expect(provider.verifyWebhookSignature(tamperedBody, signature)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const provider = providerWith(APP_SECRET);
    expect(provider.verifyWebhookSignature('{}', undefined)).toBe(false);
  });

  it('rejects a malformed signature header (no "sha256=" scheme prefix)', () => {
    const provider = providerWith(APP_SECRET);
    const body = '{}';
    const rawHex = createHmac('sha256', APP_SECRET).update(body).digest('hex');
    expect(provider.verifyWebhookSignature(body, rawHex)).toBe(false); // missing "sha256=" prefix
  });

  it('never verifies anything when no app secret is configured, rather than comparing against an empty key', () => {
    const provider = providerWith(undefined);
    const body = JSON.stringify({ entry: [] });
    expect(provider.verifyWebhookSignature(body, sign(body, ''))).toBe(false);
  });

  it('rejects a signature of the wrong length rather than throwing', () => {
    const provider = providerWith(APP_SECRET);
    expect(provider.verifyWebhookSignature('{}', 'sha256=abcd')).toBe(false);
  });
});

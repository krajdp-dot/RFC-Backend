/**
 * Phase 12, section 7 — one normalization layer, so the same person's
 * number never creates two different WhatsApp identities depending on how
 * it happened to be typed. This does not create or look up a customer; it
 * only answers "what is the canonical form of this number", so every
 * caller — the customer service, the WhatsApp send path, incoming-webhook
 * matching — agrees on the same string.
 *
 * Scoped to what this business actually needs today: India-first (this is
 * RFC's only market — see /profile.md), but not silently assuming every
 * number is Indian forever, per the brief's explicit warning. A number
 * already carrying a different country code is normalized on its own
 * digits, not coerced into +91.
 */

const INDIA_COUNTRY_CODE = '91';

export interface NormalizedPhone {
  /** E.164-shaped, no punctuation: "+919876543210". This is the canonical form — the one thing to compare, store as whatsappNumber, or send to the provider. */
  e164: string;
  /** Same value without the leading "+", the shape Meta's Cloud API wants in the `to` field of a send request. */
  digitsOnly: string;
  valid: boolean;
}

/**
 * Strips everything but digits and a leading +, then resolves to a
 * canonical +<countrycode><number> form.
 *
 * Handles, all resolving to the same +919876543210:
 *   9876543210, 09876543210, +919876543210, 919876543210,
 *   +91 98765 43210, 91-9876543210
 *
 * A number that already has a non-91 country code (e.g. +14155552671) is
 * left on its own digits — never reinterpreted as Indian just because
 * this business currently only operates in India.
 */
export function normalizePhone(raw: string | null | undefined): NormalizedPhone {
  if (!raw) return { e164: '', digitsOnly: '', valid: false };

  const trimmed = raw.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/[^\d]/g, '');

  if (!digits) return { e164: '', digitsOnly: '', valid: false };

  let normalized: string;

  if (hadPlus) {
    // Already gave us a country code explicitly — trust it as-is.
    normalized = digits;
  } else if (digits.length === 10) {
    // Bare 10-digit Indian mobile number: 9876543210
    normalized = INDIA_COUNTRY_CODE + digits;
  } else if (digits.length === 11 && digits.startsWith('0')) {
    // Domestic-dialing-prefix form: 09876543210
    normalized = INDIA_COUNTRY_CODE + digits.slice(1);
  } else if (digits.length === 12 && digits.startsWith(INDIA_COUNTRY_CODE)) {
    // Already has the country code, just no +: 919876543210
    normalized = digits;
  } else {
    // Anything else (a different country's number typed without a +, an
    // obviously malformed string) — don't guess. Pass the digits through
    // and mark invalid rather than silently fabricating a wrong number.
    normalized = digits;
  }

  // A real mobile number (India or otherwise) is realistically 10-15
  // digits after the country code portion; treat anything wildly outside
  // that as invalid rather than sending it to the provider and finding
  // out from a failed webhook.
  const valid = normalized.length >= 10 && normalized.length <= 15;

  return { e164: `+${normalized}`, digitsOnly: normalized, valid };
}

/** True if two raw phone strings resolve to the same canonical number — the actual duplicate-prevention check (section 7's "do not create duplicate customers"). */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  return na.valid && nb.valid && na.digitsOnly === nb.digitsOnly;
}

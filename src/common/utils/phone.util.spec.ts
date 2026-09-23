import { normalizePhone, samePhone } from './phone.util.js';

describe('normalizePhone', () => {
  it('resolves every common Indian format to the same canonical number', () => {
    const forms = ['9876543210', '09876543210', '+919876543210', '919876543210', '+91 98765 43210', '91-9876543210'];
    for (const form of forms) {
      expect(normalizePhone(form)).toMatchObject({ e164: '+919876543210', digitsOnly: '919876543210', valid: true });
    }
  });

  it('does not force a non-Indian number into +91', () => {
    const result = normalizePhone('+14155552671');
    expect(result.e164).toBe('+14155552671');
    expect(result.valid).toBe(true);
  });

  it('strips punctuation and whitespace, not just leading/trailing', () => {
    expect(normalizePhone('  +91 (987) 654-3210  ').digitsOnly).toBe('919876543210');
  });

  it('marks empty/missing input invalid without throwing', () => {
    expect(normalizePhone('')).toEqual({ e164: '', digitsOnly: '', valid: false });
    expect(normalizePhone(null)).toEqual({ e164: '', digitsOnly: '', valid: false });
    expect(normalizePhone(undefined)).toEqual({ e164: '', digitsOnly: '', valid: false });
  });

  it('marks an unreasonably short or long number invalid rather than guessing', () => {
    expect(normalizePhone('12345').valid).toBe(false);
    expect(normalizePhone('1234567890123456789').valid).toBe(false);
  });
});

describe('samePhone', () => {
  it('treats every common format of the same number as the same', () => {
    expect(samePhone('9876543210', '+91 98765 43210')).toBe(true);
    expect(samePhone('09876543210', '919876543210')).toBe(true);
  });

  it('treats genuinely different numbers as different', () => {
    expect(samePhone('9876543210', '9876543211')).toBe(false);
  });

  it('never treats two invalid numbers as matching each other', () => {
    expect(samePhone('', '')).toBe(false);
    expect(samePhone('abc', 'abc')).toBe(false);
  });
});

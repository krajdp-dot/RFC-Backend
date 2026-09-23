import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone.js';
import utc from 'dayjs/plugin/utc.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const BUSINESS_TIMEZONE = 'Asia/Kolkata';

/**
 * Reference number prefixes by transaction type.
 */
const PREFIXES: Record<string, string> = {
  SALE: 'SAL',
  PURCHASE: 'PUR',
  PAYMENT_IN: 'RCV',
  PAYMENT_OUT: 'PAY',
  REFUND_OUT: 'RFO',
  REFUND_IN: 'RFI',
  TRANSFER: 'TFR',
  EXPENSE: 'EXP',
  ADJUSTMENT: 'ADJ',
  WASTAGE: 'WST',
  LOT: 'LOT',
};

/**
 * Generate a unique reference number.
 * Format: PREFIX-YYYYMMDD-RANDOM
 * Example: SAL-20260814-A3F2
 */
export function generateReference(type: string, date?: Date | string): string {
  const prefix = PREFIXES[type] || type.substring(0, 3).toUpperCase();
  const d = date ? dayjs(date).tz(BUSINESS_TIMEZONE) : dayjs().tz(BUSINESS_TIMEZONE);
  const dateStr = d.format('YYYYMMDD');
  const random = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${dateStr}-${random}`;
}

/**
 * Generate a lot reference.
 * Format: MMMDD-PRODUCT-VARIETY-SUPPLIER_INITIALS
 * Example: AUG14-APPLE-ROYAL-MA
 */
export function generateLotReference(
  productName: string,
  variety: string | null | undefined,
  supplierName: string | null | undefined,
  date?: Date | string,
): string {
  const d = date ? dayjs(date).tz(BUSINESS_TIMEZONE) : dayjs().tz(BUSINESS_TIMEZONE);
  const dateStr = d.format('MMMDD').toUpperCase();
  const prod = productName.substring(0, 8).toUpperCase().replace(/\s+/g, '');
  const var_ = variety ? `-${variety.substring(0, 6).toUpperCase().replace(/\s+/g, '')}` : '';
  const sup = supplierName
    ? `-${supplierName.split(' ').map((w: string) => w[0]).join('').substring(0, 3).toUpperCase()}`
    : '';
  const random = Math.random().toString(36).substring(2, 5).toUpperCase();
  return `${dateStr}-${prod}${var_}${sup}-${random}`;
}

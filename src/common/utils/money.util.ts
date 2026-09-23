import { Decimal } from 'decimal.js';

// Configure Decimal.js for financial precision
Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/**
 * Convert a value to Decimal for safe financial arithmetic.
 * Accepts: number, string, Decimal, Prisma Decimal, null/undefined.
 */
export function toDecimal(value: unknown): Decimal {
  if (value === null || value === undefined) return new Decimal(0);
  if (value instanceof Decimal) return value;
  return new Decimal(String(value));
}

/**
 * Add multiple Decimal values.
 */
export function sumDecimal(...values: unknown[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0));
}

/**
 * Multiply two values.
 */
export function mulDecimal(a: unknown, b: unknown): Decimal {
  return toDecimal(a).times(toDecimal(b));
}

/**
 * Divide two values (returns 0 if divisor is 0).
 */
export function divDecimal(a: unknown, b: unknown): Decimal {
  const divisor = toDecimal(b);
  if (divisor.isZero()) return new Decimal(0);
  return toDecimal(a).dividedBy(divisor);
}

/**
 * Round to 2 decimal places for money.
 */
export function roundMoney(value: unknown): Decimal {
  return toDecimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

/**
 * Round to 4 decimal places for per-unit cost.
 */
export function roundCost(value: unknown): Decimal {
  return toDecimal(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP);
}

/**
 * Round to 3 decimal places for weight (kg).
 */
export function roundWeight(value: unknown): Decimal {
  return toDecimal(value).toDecimalPlaces(3, Decimal.ROUND_HALF_UP);
}

/**
 * Convert Decimal to string for API response (prevents JSON float issues).
 */
export function toMoneyString(value: unknown): string {
  return roundMoney(value).toFixed(2);
}

/**
 * Check if value is positive.
 */
export function isPositive(value: unknown): boolean {
  return toDecimal(value).isPositive();
}

/**
 * Calculate percentage: (part / total) * 100
 */
export function calcPercentage(part: unknown, total: unknown): Decimal {
  const t = toDecimal(total);
  if (t.isZero()) return new Decimal(0);
  return toDecimal(part).dividedBy(t).times(100).toDecimalPlaces(2);
}

/**
 * Calculate margin: ((selling - cost) / selling) * 100
 */
export function calcMarginPct(selling: unknown, cost: unknown): Decimal {
  const s = toDecimal(selling);
  if (s.isZero()) return new Decimal(0);
  return s.minus(toDecimal(cost)).dividedBy(s).times(100).toDecimalPlaces(2);
}

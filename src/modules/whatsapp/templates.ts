/**
 * Phase 12, section 10 — the reusable template abstraction. Every
 * business-triggered message (never a fully custom one — see
 * MessageType/CUSTOM below) renders through one of these definitions, so
 * the wording matches what section 10 specifies and the *values* are the
 * only thing that ever varies.
 *
 * `body` here is the human-readable rendered text this codebase actually
 * sends today (via the fake provider, and as `contentSnapshot` in message
 * history). `metaVariableOrder` is a second, parallel concern: Meta's
 * Cloud API takes template parameters positionally ({{1}}, {{2}}, ...),
 * not by name, so it also records the order our named variables would
 * need to be passed in *if* this were sent through a real,
 * Meta-pre-approved template with that exact name. Getting a real
 * template approved by Meta is an account-level step outside this
 * codebase — see PHASE-12-REPORT.md.
 */

export type MessageType = 'TRANSACTIONAL' | 'SERVICE' | 'REMINDER' | 'PROMOTIONAL' | 'INTERNAL';

export interface TemplateDefinition {
  templateName: string;
  messageType: MessageType;
  /** The named variables this template accepts, in the exact order Meta's positional {{1}}, {{2}}... parameters would need them. */
  metaVariableOrder: string[];
  render: (vars: Record<string, string>) => string;
}

/** The part of sanitization that has nothing to do with length — shared by both a short template variable and a longer custom message, each of which caps length differently below. */
function stripUnsafe(raw: string): string {
  return String(raw ?? '')
    .replace(/<[^>]*>/g, '') // strip anything HTML-tag-shaped
    .replace(/[\r\n\t]+/g, ' ') // Meta template parameters may not contain newlines
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Indian digit grouping (12,34,567 not 1,234,567) for the amounts that
 * actually reach a customer's phone. The rest of this API returns plain
 * "1234.56" strings on purpose — this formatting is specific to text a
 * person reads, so it lives here rather than in the shared money utils.
 */
export function formatAmountForMessage(value: string | number): string {
  const num = typeof value === 'number' ? value : parseFloat(value);
  if (Number.isNaN(num)) return String(value);

  const isWhole = Number.isInteger(num);
  const [intPart, decimalPart] = Math.abs(num).toFixed(2).split('.');
  const sign = num < 0 ? '-' : '';

  let grouped: string;
  if (intPart.length <= 3) {
    grouped = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3);
    const pairs = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    grouped = `${pairs},${last3}`;
  }

  return isWhole ? `${sign}${grouped}` : `${sign}${grouped}.${decimalPart}`;
}

/** Section 11 — plain text only. Strips anything that isn't, rather than trying to escape it into safety: a template variable is a name, an amount, a date — never markup. */
export function sanitizeTemplateVariable(raw: string): string {
  return stripUnsafe(raw).slice(0, 512); // generous but bounded — this is a name/amount/date, never a paragraph
}

export function sanitizeVariables(vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    out[key] = sanitizeTemplateVariable(value);
  }
  return out;
}

export const TEMPLATES: Record<string, TemplateDefinition> = {
  SALE_CONFIRMATION: {
    templateName: 'sale_confirmation',
    messageType: 'TRANSACTIONAL',
    metaVariableOrder: ['customer_name', 'items', 'total'],
    render: (v) =>
      `Hello ${v.customer_name},\n\nYour order from Rajdeep Fruits Company:\n\n${v.items}\n\nTotal: \u20b9${v.total}\n\nThank you.`,
  },
  PAYMENT_RECEIPT: {
    templateName: 'payment_receipt',
    messageType: 'TRANSACTIONAL',
    metaVariableOrder: ['customer_name', 'amount', 'payment_mode', 'date'],
    render: (v) =>
      `Payment received from ${v.customer_name}\n\nAmount: \u20b9${v.amount}\nMode: ${v.payment_mode}\nDate: ${v.date}\n\nThank you.`,
  },
  OUTSTANDING_REMINDER: {
    templateName: 'outstanding_reminder',
    messageType: 'REMINDER',
    metaVariableOrder: ['customer_name', 'outstanding'],
    render: (v) =>
      `Hello ${v.customer_name},\n\nYour current outstanding with Rajdeep Fruits Company is:\n\n\u20b9${v.outstanding}\n\nPlease contact us if you need the statement.`,
  },
  STATEMENT: {
    templateName: 'statement',
    messageType: 'SERVICE',
    metaVariableOrder: ['customer_name', 'opening', 'sales', 'payments', 'outstanding'],
    render: (v) =>
      `Customer:\n${v.customer_name}\n\nOpening:\n\u20b9${v.opening}\n\nSales:\n\u20b9${v.sales}\n\nPayments:\n\u20b9${v.payments}\n\nOutstanding:\n\u20b9${v.outstanding}`,
  },
  PRICE_BOARD: {
    templateName: 'price_board',
    messageType: 'PROMOTIONAL',
    metaVariableOrder: ['title', 'lines'],
    render: (v) => `${v.title}\n\n${v.lines}`,
  },
};

export type TemplateKey = keyof typeof TEMPLATES;

/**
 * Custom messages (section 40) don't go through a template at all — the
 * brief is explicit that WhatsApp's own template-approval rules govern
 * what's sendable, and a custom message is understood to be a
 * session-window reply, not an unapproved marketing template. This still
 * runs through the same sanitizer as a template variable would, since it
 * still ends up rendered in the frontend preview and stored as
 * contentSnapshot.
 */
export function renderCustomMessage(content: string): string {
  return stripUnsafe(content).slice(0, 1024);
}

export function renderTemplate(key: TemplateKey, rawVariables: Record<string, string>): { text: string; messageType: MessageType; templateName: string } {
  const def = TEMPLATES[key];
  if (!def) {
    throw new Error(`Unknown WhatsApp template: ${key}`);
  }
  const vars = sanitizeVariables(rawVariables);
  return { text: def.render(vars), messageType: def.messageType, templateName: def.templateName };
}

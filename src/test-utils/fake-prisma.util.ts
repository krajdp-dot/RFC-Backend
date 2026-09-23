import { Decimal } from 'decimal.js';

/**
 * In-memory stand-in for PrismaClient, used across this repo's *.spec.ts
 * files. There is no way to run a real PostgreSQL-backed PrismaClient in
 * this environment: `prisma generate` needs to download an engine binary
 * from Prisma's CDN, which is blocked by network egress restrictions here
 * (unrelated to this codebase). See the test report for what this can and
 * cannot prove — in short: application logic (validation, rejection,
 * atomicity via rollback, which mutations happen in which order) is real
 * and verified; genuine cross-connection concurrency (does a real Postgres
 * advisory lock actually block a second session) is NOT modeled and needs
 * real Postgres to verify.
 *
 * Each model is registered against its real Prisma model name (schema.prisma),
 * not its @@map'd table name — application code always goes through
 * `tx.modelName`, never the raw table name, except in the handful of raw
 * `$queryRaw` locking statements, which is exactly why those need the real
 * @@map'd names (see business-date-guard.util.ts's comments).
 */

export type Table<T> = T[];

function toComparable(v: any): any {
  if (v instanceof Date) return v.getTime();
  if (v instanceof Decimal) return v.toNumber();
  return v;
}

function sameValue(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || a === undefined || b === null || b === undefined) return a == b;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() === new Date(b).getTime();
  if (a instanceof Decimal || b instanceof Decimal) return toDecimalSafe(a).eq(toDecimalSafe(b));
  return a === b;
}

function toDecimalSafe(v: any): Decimal {
  if (v instanceof Decimal) return v;
  return new Decimal(String(v));
}

function valueMatchesFilter(actual: any, filter: any): boolean {
  if (filter !== null && typeof filter === 'object' && !(filter instanceof Date)) {
    return Object.entries(filter).every(([op, val]) => {
      switch (op) {
        case 'gt': return toComparable(actual) > toComparable(val);
        case 'gte': return toComparable(actual) >= toComparable(val);
        case 'lt': return toComparable(actual) < toComparable(val);
        case 'lte': return toComparable(actual) <= toComparable(val);
        case 'in': return Array.isArray(val) && val.some((v) => sameValue(actual, v));
        case 'not': return !sameValue(actual, val);
        case 'equals': return sameValue(actual, val);
        default: return true;
      }
    });
  }
  return sameValue(actual, filter);
}

function matches(record: any, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([key, value]) => valueMatchesFilter(record[key], value));
}

/** Decimal -> string on write, so a field reads back the same shape whether
 * it was seeded as a string or produced by real Decimal arithmetic. */
function normalizeForStorage(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    out[k] = v instanceof Decimal ? v.toString() : v;
  }
  return out;
}

function applyFieldOperators(current: Record<string, any>, data: Record<string, any>): Record<string, any> {
  const resolved: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    const isOperatorObject =
      value !== null && typeof value === 'object' &&
      !(value instanceof Decimal) && !(value instanceof Date) &&
      ('increment' in value || 'decrement' in value || 'multiply' in value || 'divide' in value || 'set' in value);
    if (isOperatorObject) {
      const currentNum = Number(current[key] ?? 0);
      if ('increment' in value) resolved[key] = currentNum + Number(value.increment);
      else if ('decrement' in value) resolved[key] = currentNum - Number(value.decrement);
      else if ('multiply' in value) resolved[key] = currentNum * Number(value.multiply);
      else if ('divide' in value) resolved[key] = currentNum / Number(value.divide);
      else resolved[key] = value.set;
    } else {
      resolved[key] = value;
    }
  }
  return resolved;
}

let idCounter = 0;
function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}_${idCounter}`;
}

type ModelDelegate = {
  findFirst: (args?: any) => Promise<any>;
  findUnique: (args?: any) => Promise<any>;
  findMany: (args?: any) => Promise<any[]>;
  count: (args?: any) => Promise<number>;
  aggregate: (args?: any) => Promise<any>;
  create: (args: any) => Promise<any>;
  createMany: (args: any) => Promise<{ count: number }>;
  update: (args: any) => Promise<any>;
  updateMany: (args: any) => Promise<{ count: number }>;
  deleteMany: (args: any) => Promise<{ count: number }>;
};

function makeModelDelegate(
  tables: Record<string, Table<any>>,
  tableName: string,
  uniqueFields: string[][] = [],
): ModelDelegate {
  function sortRecords(records: any[], orderBy: any): any[] {
    if (!orderBy) return records;
    const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...records].sort((a, b) => {
      for (const ord of orders) {
        for (const [field, dir] of Object.entries(ord)) {
          const av = toComparable(a[field]);
          const bv = toComparable(b[field]);
          if (av < bv) return dir === 'asc' ? -1 : 1;
          if (av > bv) return dir === 'asc' ? 1 : -1;
        }
      }
      return 0;
    });
  }

  return {
    findFirst: async ({ where, orderBy }: { where?: Record<string, any>; orderBy?: any } = {}) => {
      const table = tables[tableName];
      const filtered = table.filter((r) => matches(r, where));
      return sortRecords(filtered, orderBy)[0] ?? null;
    },
    findUnique: async ({ where }: { where?: Record<string, any> } = {}) => {
      const table = tables[tableName];
      return table.find((r) => matches(r, where)) ?? null;
    },
    findMany: async ({ where, orderBy, take }: { where?: Record<string, any>; orderBy?: any; take?: number } = {}) => {
      const table = tables[tableName];
      const filtered = sortRecords(table.filter((r) => matches(r, where)), orderBy);
      return typeof take === 'number' ? filtered.slice(0, take) : filtered;
    },
    count: async ({ where }: { where?: Record<string, any> } = {}) => {
      return tables[tableName].filter((r) => matches(r, where)).length;
    },
    aggregate: async (
      { where, _sum, _max, _min }: {
        where?: Record<string, any>; _sum?: Record<string, boolean>;
        _max?: Record<string, boolean>; _min?: Record<string, boolean>;
      } = {},
    ) => {
      const rows = tables[tableName].filter((r) => matches(r, where));
      const sums: Record<string, any> = {};
      if (_sum) {
        for (const field of Object.keys(_sum)) {
          sums[field] = rows.reduce((acc, r) => acc.plus(toDecimalSafe(r[field] ?? 0)), new Decimal(0));
        }
      }
      // _max/_min: numbers and Decimals compare via toDecimalSafe; dates and
      // strings compare directly — matches toComparable's own field-value
      // handling used by sortRecords/orderBy elsewhere in this file.
      const extremum = (field: string, pick: (a: any, b: any) => any) => {
        if (rows.length === 0) return null;
        return rows.reduce((best, r) => {
          const v = r[field];
          if (v == null) return best;
          if (best == null) return v;
          return pick(v, best);
        }, null as any);
      };
      const maxes: Record<string, any> = {};
      if (_max) {
        for (const field of Object.keys(_max)) {
          maxes[field] = extremum(field, (a, b) => (toComparable(a) > toComparable(b) ? a : b));
        }
      }
      const mins: Record<string, any> = {};
      if (_min) {
        for (const field of Object.keys(_min)) {
          mins[field] = extremum(field, (a, b) => (toComparable(a) < toComparable(b) ? a : b));
        }
      }
      return { _sum: sums, _count: rows.length, _max: maxes, _min: mins };
    },
    create: async ({ data }: { data: Record<string, any> }) => {
      const table = tables[tableName];
      const normalized = normalizeForStorage(data);
      for (const combo of uniqueFields) {
        const conflict = table.find((r) => combo.every((f) => sameValue(r[f], normalized[f])));
        if (conflict) {
          const err: any = new Error(`Unique constraint failed on: ${combo.join(', ')}`);
          err.code = 'P2002';
          err.meta = { target: combo };
          throw err;
        }
      }
      // Phase 9: expand Prisma's nested-write shape (`items: { create: [...] }`)
      // for the two places this codebase actually uses it — sale.create's
      // `items` and purchase.create's `items` — into the real saleItem/
      // purchaseItem tables with the FK set, the way real Postgres does it.
      // Real Prisma resolves this transparently; this fake previously just
      // stored the literal `{ create: [...] }` object as a field value and
      // never touched the related table at all, which is exactly why
      // sales.service.ts's processReturn had no direct test coverage
      // before Phase 9 (nothing could find a real SaleItem row to return).
      // Narrow and explicit on purpose, not a generic nested-write engine,
      // to keep this shared double's behavior predictable.
      const nestedChildTable: Record<string, string> = { sale: 'saleItem', purchase: 'purchaseItem' };
      const fkField: Record<string, string> = { sale: 'saleId', purchase: 'purchaseId' };
      let itemsToCreate: any[] | undefined;
      if (nestedChildTable[tableName] && normalized.items && typeof normalized.items === 'object' && 'create' in normalized.items) {
        const raw = (normalized.items as any).create;
        itemsToCreate = Array.isArray(raw) ? raw : [raw];
        delete normalized.items;
      }
      const record = { id: nextId(tableName), createdAt: new Date(), updatedAt: new Date(), ...normalized };
      table.push(record);
      if (itemsToCreate) {
        const childTable = tables[nestedChildTable[tableName]];
        for (const item of itemsToCreate) {
          childTable.push({
            id: nextId(nestedChildTable[tableName]), createdAt: new Date(), updatedAt: new Date(),
            [fkField[tableName]]: record.id, ...normalizeForStorage(item),
          });
        }
      }
      return record;
    },
    createMany: async ({ data }: { data: Record<string, any>[] }) => {
      const table = tables[tableName];
      for (const d of data) {
        table.push({ id: nextId(tableName), createdAt: new Date(), updatedAt: new Date(), ...normalizeForStorage(d) });
      }
      return { count: data.length };
    },
    update: async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
      const table = tables[tableName];
      const idx = table.findIndex((r) => matches(r, where));
      if (idx === -1) throw new Error(`FakePrisma: ${String(tableName)} not found for update`);
      const current = table[idx];
      const resolved = applyFieldOperators(current, data);
      table[idx] = { ...current, ...normalizeForStorage(resolved), updatedAt: new Date() };
      return table[idx];
    },
    updateMany: async ({ where, data }: { where?: Record<string, any>; data: Record<string, any> }) => {
      const table = tables[tableName];
      let count = 0;
      for (let i = 0; i < table.length; i++) {
        if (matches(table[i], where)) {
          table[i] = { ...table[i], ...normalizeForStorage(applyFieldOperators(table[i], data)), updatedAt: new Date() };
          count++;
        }
      }
      return { count };
    },
    deleteMany: async ({ where }: { where?: Record<string, any> } = {}) => {
      const table = tables[tableName];
      const before = table.length;
      tables[tableName] = table.filter((r) => !matches(r, where));
      return { count: before - tables[tableName].length };
    },
  };
}

export class FakePrismaService {
  business: Table<any> = [];
  user: Table<any> = [];
  userBusiness: Table<any> = [];
  product: Table<any> = [];
  freshnessProfile: Table<any> = [];
  priceReference: Table<any> = [];
  lot: Table<any> = [];
  box: Table<any> = [];
  inventoryMovement: Table<any> = [];
  customer: Table<any> = [];
  supplier: Table<any> = [];
  sale: Table<any> = [];
  saleItem: Table<any> = [];
  purchase: Table<any> = [];
  purchaseItem: Table<any> = [];
  payment: Table<any> = [];
  expenseCategory: Table<any> = [];
  expense: Table<any> = [];
  account: Table<any> = [];
  transfer: Table<any> = [];
  ledgerEntry: Table<any> = [];
  dayClose: Table<any> = [];
  auditLog: Table<any> = [];
  // Phase 12
  whatsAppMessage: Table<any> = [];
  whatsAppIncomingMessage: Table<any> = [];
  whatsAppWebhookEvent: Table<any> = [];
  whatsAppAutomationSetting: Table<any> = [];

  private _rawTables!: Record<string, Table<any>>;

  queryRawCalls: string[] = [];

  constructor(seed: Partial<Record<string, any[]>> = {}) {
    // A separate plain object holds the actual arrays. Delegates close over
    // THIS object, not `this` — if they closed over `this` directly, then
    // assigning `this.dayClose = makeModelDelegate(...)` a few lines below
    // would overwrite the very array the dayClose delegate's closure needs
    // to read, since `this.dayClose` and the closure's `tables['dayClose']`
    // would be the same reference. Every model delegate would silently
    // break the same way — this bit precisely once and cost real time to
    // track down, worth over-explaining.
    const tables: Record<string, Table<any>> = {};
    for (const key of [
      'business', 'user', 'userBusiness', 'product', 'freshnessProfile', 'priceReference',
      'lot', 'box', 'inventoryMovement', 'customer', 'supplier', 'sale', 'saleItem',
      'purchase', 'purchaseItem', 'payment', 'expenseCategory', 'expense', 'account',
      'transfer', 'ledgerEntry', 'dayClose', 'auditLog',
      'whatsAppMessage', 'whatsAppIncomingMessage', 'whatsAppWebhookEvent', 'whatsAppAutomationSetting',
    ]) {
      tables[key] = ((seed as any)[key] || []).map((r: any) => ({ ...r }));
    }
    this._rawTables = tables;

    (this as any).business = makeModelDelegate(tables, 'business');
    (this as any).user = makeModelDelegate(tables, 'user');
    (this as any).userBusiness = makeModelDelegate(tables, 'userBusiness');
    (this as any).product = makeModelDelegate(tables, 'product');
    (this as any).freshnessProfile = makeModelDelegate(tables, 'freshnessProfile');
    (this as any).priceReference = makeModelDelegate(tables, 'priceReference');
    (this as any).lot = makeModelDelegate(tables, 'lot');
    (this as any).box = makeModelDelegate(tables, 'box');
    (this as any).inventoryMovement = makeModelDelegate(tables, 'inventoryMovement');
    (this as any).customer = makeModelDelegate(tables, 'customer');
    (this as any).supplier = makeModelDelegate(tables, 'supplier');
    (this as any).sale = makeModelDelegate(tables, 'sale');
    (this as any).saleItem = makeModelDelegate(tables, 'saleItem');
    (this as any).purchase = makeModelDelegate(tables, 'purchase');
    (this as any).purchaseItem = makeModelDelegate(tables, 'purchaseItem');
    (this as any).payment = makeModelDelegate(tables, 'payment');
    (this as any).expenseCategory = makeModelDelegate(tables, 'expenseCategory');
    (this as any).expense = makeModelDelegate(tables, 'expense');
    (this as any).account = makeModelDelegate(tables, 'account');
    (this as any).transfer = makeModelDelegate(tables, 'transfer');
    (this as any).ledgerEntry = makeModelDelegate(tables, 'ledgerEntry');
    (this as any).dayClose = makeModelDelegate(tables, 'dayClose', [['businessId', 'businessDate']]);
    (this as any).auditLog = makeModelDelegate(tables, 'auditLog');
    // Phase 12 — matches schema.prisma's @@unique / @unique exactly, so
    // a test exercising the same "insert, catch P2002" dedup path the
    // real webhook handler uses (whatsapp-webhook.controller.ts) sees
    // the same behavior a real Postgres constraint would give it.
    (this as any).whatsAppMessage = makeModelDelegate(tables, 'whatsAppMessage', [['businessId', 'idempotencyKey']]);
    (this as any).whatsAppIncomingMessage = makeModelDelegate(tables, 'whatsAppIncomingMessage', [['providerMessageId']]);
    (this as any).whatsAppWebhookEvent = makeModelDelegate(tables, 'whatsAppWebhookEvent', [['providerEventId']]);
    (this as any).whatsAppAutomationSetting = makeModelDelegate(tables, 'whatsAppAutomationSetting', [['businessId']]);
  }

  _tables(): Record<string, any[]> {
    return this._rawTables;
  }

  async $transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
    // Snapshot every table so a thrown error inside `fn` can be rolled back
    // to exactly this point — the same all-or-nothing guarantee a real
    // Prisma interactive transaction gives, which is what every "rejected
    // mutation leaves zero side effects" test in this repo depends on.
    const snapshot: Record<string, any[]> = {};
    for (const [key, value] of Object.entries(this._rawTables)) {
      snapshot[key] = value.map((r) => ({ ...r }));
    }
    try {
      return await fn(this);
    } catch (err) {
      for (const [key, value] of Object.entries(snapshot)) {
        this._rawTables[key].length = 0;
        this._rawTables[key].push(...value);
      }
      throw err;
    }
  }

  async $queryRaw(strings: TemplateStringsArray, ...values: any[]) {
    this.queryRawCalls.push(strings.join('?'));
    return [];
  }

  async $executeRaw(strings: TemplateStringsArray, ...values: any[]) {
    this.queryRawCalls.push(strings.join('?'));
    return 0;
  }
}

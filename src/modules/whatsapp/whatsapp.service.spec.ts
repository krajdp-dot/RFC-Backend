import { Test } from '@nestjs/testing';
import { WhatsAppService, WhatsAppOptInRequiredError, WhatsAppNumberMissingError } from './whatsapp.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WHATSAPP_PROVIDER } from './whatsapp.constants.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { NotFoundException, BadRequestException } from '@nestjs/common';

/**
 * WhatsAppService is the one place every send passes through — these
 * tests exist to prove the three guarantees the rest of Phase 12 is built
 * on: nothing is ever sent to a customer who hasn't opted in (section 8),
 * a retried request never creates a second message (section 30), and
 * every figure in a message comes from the real transaction, never a
 * caller-supplied amount (section 21).
 */
describe('WhatsAppService', () => {
  let service: WhatsAppService;
  let fakePrisma: FakePrismaService;

  const OPTED_IN = 'cust_opted_in';
  const NOT_OPTED_IN = 'cust_not_opted_in';
  const NO_NUMBER = 'cust_no_number';

  function build(overrides: Partial<Record<string, any[]>> = {}) {
    fakePrisma = new FakePrismaService({
      business: [{ id: 'biz_1', name: 'RFC' }],
      customer: [
        { id: OPTED_IN, businessId: 'biz_1', name: 'ABC Fruits', phone: '9876543210', whatsappOptIn: true, active: true },
        { id: NOT_OPTED_IN, businessId: 'biz_1', name: 'XYZ Traders', phone: '9876543211', whatsappOptIn: false, active: true },
        { id: NO_NUMBER, businessId: 'biz_1', name: 'No Number Co', phone: null, whatsappOptIn: true, active: true },
      ],
      product: [{ id: 'prod_1', businessId: 'biz_1', name: 'Royal Red Apple' }],
      sale: [
        {
          id: 'sale_1', businessId: 'biz_1', customerId: OPTED_IN, saleReference: 'SALE-001',
          total: '6150.00', received: '0', status: 'COMPLETED', businessDate: new Date('2026-09-20'),
        },
      ],
      saleItem: [{ id: 'item_1', saleId: 'sale_1', productId: 'prod_1', quantity: 3, unit: 'BOX', rate: '2050.00' }],
      payment: [
        {
          id: 'pay_1', businessId: 'biz_1', customerId: OPTED_IN, amount: '5000.00', method: 'UPI',
          status: 'COMPLETED', businessDate: new Date('2026-09-20'), paymentReference: 'PAY-001',
        },
      ],
      ...overrides,
    });
    return fakePrisma;
  }

  async function setup(fake: FakePrismaService, provider: any) {
    const moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppService,
        AuditService,
        { provide: PrismaService, useValue: fake },
        { provide: WHATSAPP_PROVIDER, useValue: provider },
      ],
    }).compile();
    service = moduleRef.get(WhatsAppService);
  }

  const fakeProvider = { name: 'fake' };

  beforeEach(async () => {
    await setup(build(), fakeProvider);
  });

  describe('opt-in enforcement (section 8)', () => {
    it('refuses to queue anything for a customer who has not opted in', async () => {
      await expect(service.sendOutstandingReminder('biz_1', NOT_OPTED_IN, 'user_1')).rejects.toBeInstanceOf(
        WhatsAppOptInRequiredError,
      );
      expect(fakePrisma._tables().whatsAppMessage).toHaveLength(0);
    });

    it('refuses when the opted-in customer has no usable phone number', async () => {
      await expect(service.sendOutstandingReminder('biz_1', NO_NUMBER, 'user_1')).rejects.toBeInstanceOf(
        WhatsAppNumberMissingError,
      );
    });

    it('an automated (silent) send finds the same blockers but returns null instead of throwing', async () => {
      const result = await service.sendSaleConfirmation('biz_1', 'sale_1', null, true);
      // sale_1's customer IS opted in in this fixture, so re-derive a
      // blocked case directly to prove silent mode's actual behavior.
      const blocked = await service.sendOutstandingReminder('biz_1', NOT_OPTED_IN, null, true);
      expect(blocked).toBeNull();
      expect(result).not.toBeNull(); // sanity: the opted-in path still works
    });
  });

  describe('idempotency (section 30)', () => {
    it('a repeated sale confirmation for the same sale returns the original message, never a second one', async () => {
      const first = await service.sendSaleConfirmation('biz_1', 'sale_1', 'user_1');
      const second = await service.sendSaleConfirmation('biz_1', 'sale_1', 'user_1');
      expect(second.id).toBe(first.id);
      expect(fakePrisma._tables().whatsAppMessage).toHaveLength(1);
    });

    it('a repeated payment receipt for the same payment is equally idempotent', async () => {
      const first = await service.sendPaymentReceipt('biz_1', 'pay_1', 'user_1');
      const second = await service.sendPaymentReceipt('biz_1', 'pay_1', 'user_1');
      expect(second.id).toBe(first.id);
      expect(fakePrisma._tables().whatsAppMessage).toHaveLength(1);
    });

    it('a custom message reuses the caller-supplied mutationId the same way', async () => {
      const key = 'client-mutation-abc';
      const first = await service.sendCustomMessage('biz_1', OPTED_IN, 'user_1', 'Hello there', key);
      const second = await service.sendCustomMessage('biz_1', OPTED_IN, 'user_1', 'A totally different message', key);
      expect(second.id).toBe(first.id);
      expect(second.contentSnapshot).toBe('Hello there'); // original wins, per section 9/30's pattern
    });

    it('two different sales for the same customer are NOT deduplicated against each other', async () => {
      const fake = build({
        sale: [
          { id: 'sale_1', businessId: 'biz_1', customerId: OPTED_IN, saleReference: 'SALE-001', total: '6150.00', received: '0', status: 'COMPLETED', businessDate: new Date() },
          { id: 'sale_2', businessId: 'biz_1', customerId: OPTED_IN, saleReference: 'SALE-002', total: '1000.00', received: '0', status: 'COMPLETED', businessDate: new Date() },
        ],
        saleItem: [
          { id: 'item_1', saleId: 'sale_1', productId: 'prod_1', quantity: 3, unit: 'BOX', rate: '2050.00' },
          { id: 'item_2', saleId: 'sale_2', productId: 'prod_1', quantity: 1, unit: 'BOX', rate: '1000.00' },
        ],
      });
      await setup(fake, fakeProvider);
      await service.sendSaleConfirmation('biz_1', 'sale_1', 'user_1');
      await service.sendSaleConfirmation('biz_1', 'sale_2', 'user_1');
      expect(fake._tables().whatsAppMessage).toHaveLength(2);
    });
  });

  describe('sendSaleConfirmation — data derivation (section 20)', () => {
    it('builds the message entirely from the real sale, never from a caller-supplied amount', async () => {
      const message = await service.sendSaleConfirmation('biz_1', 'sale_1', 'user_1');
      expect(message.contentSnapshot).toContain('ABC Fruits');
      expect(message.contentSnapshot).toContain('Royal Red Apple');
      expect(message.contentSnapshot).toContain('6,150');
      expect(message.relatedEntityType).toBe('SALE');
      expect(message.relatedEntityId).toBe('sale_1');
      expect(message.status).toBe('QUEUED');
      expect(message.recipient).toBe('+919876543210');
    });

    it('throws NotFoundException for a sale in a different business', async () => {
      await expect(service.sendSaleConfirmation('biz_other', 'sale_1', 'user_1')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('sendPaymentReceipt — section 21, "never let staff type the amount"', () => {
    it('the amount in the message is read from the Payment row, not a parameter', async () => {
      const message = await service.sendPaymentReceipt('biz_1', 'pay_1', 'user_1');
      expect(message.contentSnapshot).toContain('5,000');
      expect(message.contentSnapshot).toContain('UPI');
    });

    it('refuses a payment with no customer (a supplier payment)', async () => {
      const fake = build({
        payment: [{ id: 'pay_2', businessId: 'biz_1', customerId: null, amount: '100', method: 'CASH', status: 'COMPLETED', businessDate: new Date() }],
      });
      await setup(fake, fakeProvider);
      await expect(service.sendPaymentReceipt('biz_1', 'pay_2', 'user_1')).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('sendOutstandingReminder / sendStatement — section 22-23, derived from the ledger', () => {
    it('outstanding reflects total minus received, never a separately-stored figure', async () => {
      const message = await service.sendOutstandingReminder('biz_1', OPTED_IN, 'user_1');
      expect(message.contentSnapshot).toContain('6,150'); // 6150 total - 0 received
    });

    it('a statement includes sales, payments, and outstanding together', async () => {
      const message = await service.sendStatement('biz_1', OPTED_IN, 'user_1');
      expect(message.contentSnapshot).toContain('Sales:\n\u20b96,150');
      expect(message.contentSnapshot).toContain('Payments:\n\u20b95,000');
    });

    it('a repeated Send with the same client mutationId is deduplicated — reliable double-tap protection, not a millisecond race', async () => {
      const key = 'dialog-session-abc';
      const first = await service.sendStatement('biz_1', OPTED_IN, 'user_1', key);
      const second = await service.sendStatement('biz_1', OPTED_IN, 'user_1', key);
      expect(second.id).toBe(first.id);
      expect(fakePrisma._tables().whatsAppMessage.filter((m: any) => m.templateName === 'statement')).toHaveLength(1);
    });

    it('two different client mutationIds (two separate dialog sessions) are independently sendable', async () => {
      const first = await service.sendStatement('biz_1', OPTED_IN, 'user_1', 'session-1');
      const second = await service.sendStatement('biz_1', OPTED_IN, 'user_1', 'session-2');
      expect(second.id).not.toBe(first.id);
    });

    it('with no mutationId given, a statement requested later (real time passed) still falls back to being independently sendable', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-09-20T09:00:00Z'));
      const first = await service.sendStatement('biz_1', OPTED_IN, 'user_1');

      jest.setSystemTime(new Date('2026-09-20T14:00:00Z')); // same day, hours later
      const second = await service.sendStatement('biz_1', OPTED_IN, 'user_1');

      expect(second.id).not.toBe(first.id);
      jest.useRealTimers();
    });
  });

  describe('setOptIn (section 8)', () => {
    it('records opt-in with a timestamp and clears any opt-out', async () => {
      const updated = await service.setOptIn('biz_1', NOT_OPTED_IN, 'user_1', true);
      expect(updated.whatsappOptIn).toBe(true);
      expect(updated.whatsappOptInAt).toBeTruthy();
      expect(updated.whatsappOptOutAt).toBeNull();
    });

    it('records opt-out with a timestamp', async () => {
      const updated = await service.setOptIn('biz_1', OPTED_IN, 'user_1', false);
      expect(updated.whatsappOptIn).toBe(false);
      expect(updated.whatsappOptOutAt).toBeTruthy();
    });
  });

  describe('automation settings (section 29)', () => {
    it('defaults every automation type to off for a business with no settings row yet', async () => {
      const settings = await service.getAutomationSettings('biz_1');
      expect(settings.saleConfirmationEnabled).toBe(false);
      expect(settings.paymentReceiptEnabled).toBe(false);
      expect(settings.outstandingReminderEnabled).toBe(false);
    });

    it('creates the settings row on first update, then updates it on the next', async () => {
      const first = await service.updateAutomationSettings('biz_1', 'user_1', { saleConfirmationEnabled: true });
      expect(first.saleConfirmationEnabled).toBe(true);
      expect(fakePrisma._tables().whatsAppAutomationSetting).toHaveLength(1);

      const second = await service.updateAutomationSettings('biz_1', 'user_1', { paymentReceiptEnabled: true });
      expect(second.saleConfirmationEnabled).toBe(true); // untouched field persists
      expect(second.paymentReceiptEnabled).toBe(true);
      expect(fakePrisma._tables().whatsAppAutomationSetting).toHaveLength(1); // still one row, not two
    });
  });

  describe('business isolation (section 37)', () => {
    it('cannot send to or read a customer belonging to a different business', async () => {
      await expect(service.sendOutstandingReminder('biz_other', OPTED_IN, 'user_1')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('message history is scoped to the requesting business', async () => {
      await service.sendSaleConfirmation('biz_1', 'sale_1', 'user_1');
      const otherBusinessHistory = await service.listMessages('biz_other', {}, { skip: 0, take: 20, page: 1, limit: 20 } as any);
      expect(otherBusinessHistory.data).toHaveLength(0);

      const ownHistory = await service.listMessages('biz_1', {}, { skip: 0, take: 20, page: 1, limit: 20 } as any);
      expect(ownHistory.data).toHaveLength(1);
    });
  });
});

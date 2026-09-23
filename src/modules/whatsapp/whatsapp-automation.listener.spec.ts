import { Test } from '@nestjs/testing';
import { WhatsAppAutomationListener } from './whatsapp-automation.listener.js';
import { WhatsAppService } from './whatsapp.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WHATSAPP_PROVIDER } from './whatsapp.constants.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';

/**
 * Section 27: SalesService/PaymentsService just emit "this happened" —
 * these tests are the proof that automation actually stays off until a
 * person turns it on (section 28), and that it can never do anything a
 * person waiting on a response would need to see an error for (silent
 * mode — see whatsapp.service.spec.ts's opt-in tests for that contract).
 */
describe('WhatsAppAutomationListener', () => {
  let listener: WhatsAppAutomationListener;
  let fakePrisma: FakePrismaService;

  async function build(automationEnabled: Partial<{ saleConfirmationEnabled: boolean; paymentReceiptEnabled: boolean }> = {}) {
    fakePrisma = new FakePrismaService({
      business: [{ id: 'biz_1', name: 'RFC' }],
      customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'ABC Fruits', phone: '9876543210', whatsappOptIn: true, active: true }],
      product: [{ id: 'prod_1', businessId: 'biz_1', name: 'Royal Red Apple' }],
      sale: [{ id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', saleReference: 'SALE-001', total: '1000', received: '0', status: 'COMPLETED', businessDate: new Date() }],
      saleItem: [{ id: 'item_1', saleId: 'sale_1', productId: 'prod_1', quantity: 1, unit: 'BOX', rate: '1000' }],
      payment: [{ id: 'pay_1', businessId: 'biz_1', customerId: 'cust_1', amount: '500', method: 'CASH', status: 'COMPLETED', businessDate: new Date() }],
      whatsAppAutomationSetting: Object.keys(automationEnabled).length
        ? [{ id: 'auto_1', businessId: 'biz_1', saleConfirmationEnabled: false, paymentReceiptEnabled: false, outstandingReminderEnabled: false, ...automationEnabled }]
        : [],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppAutomationListener,
        WhatsAppService,
        AuditService,
        { provide: PrismaService, useValue: fakePrisma },
        { provide: WHATSAPP_PROVIDER, useValue: { name: 'fake' } },
      ],
    }).compile();
    listener = moduleRef.get(WhatsAppAutomationListener);
  }

  describe('sale.created', () => {
    it('does nothing when no automation settings row exists for the business (default off, section 28)', async () => {
      await build();
      await listener.onSaleCreated({ businessId: 'biz_1', saleId: 'sale_1' });
      expect(fakePrisma._tables().whatsAppMessage).toHaveLength(0);
    });

    it('does nothing when sale confirmation automation is explicitly off', async () => {
      await build({ saleConfirmationEnabled: false });
      await listener.onSaleCreated({ businessId: 'biz_1', saleId: 'sale_1' });
      expect(fakePrisma._tables().whatsAppMessage).toHaveLength(0);
    });

    it('sends a confirmation when sale confirmation automation is on', async () => {
      await build({ saleConfirmationEnabled: true });
      await listener.onSaleCreated({ businessId: 'biz_1', saleId: 'sale_1' });
      const messages = fakePrisma._tables().whatsAppMessage;
      expect(messages).toHaveLength(1);
      expect(messages[0].relatedEntityId).toBe('sale_1');
    });

    it('does not throw when the customer has not opted in — automated sends are silent (section 8 + 33)', async () => {
      await build({ saleConfirmationEnabled: true });
      await fakePrisma.customer.update({ where: { id: 'cust_1' }, data: { whatsappOptIn: false } });
      await expect(listener.onSaleCreated({ businessId: 'biz_1', saleId: 'sale_1' })).resolves.toBeUndefined();
      expect(fakePrisma._tables().whatsAppMessage).toHaveLength(0);
    });
  });

  describe('payment.received', () => {
    it('does nothing when payment receipt automation is off', async () => {
      await build({ paymentReceiptEnabled: false });
      await listener.onPaymentReceived({ businessId: 'biz_1', paymentId: 'pay_1' });
      expect(fakePrisma._tables().whatsAppMessage).toHaveLength(0);
    });

    it('sends a receipt when payment receipt automation is on', async () => {
      await build({ paymentReceiptEnabled: true });
      await listener.onPaymentReceived({ businessId: 'biz_1', paymentId: 'pay_1' });
      const messages = fakePrisma._tables().whatsAppMessage;
      expect(messages).toHaveLength(1);
      expect(messages[0].relatedEntityId).toBe('pay_1');
    });
  });

  it('the two automation types are independent — enabling one does not enable the other', async () => {
    await build({ saleConfirmationEnabled: true, paymentReceiptEnabled: false });
    await listener.onSaleCreated({ businessId: 'biz_1', saleId: 'sale_1' });
    await listener.onPaymentReceived({ businessId: 'biz_1', paymentId: 'pay_1' });
    const messages = fakePrisma._tables().whatsAppMessage;
    expect(messages).toHaveLength(1);
    expect(messages[0].relatedEntityType).toBe('SALE');
  });
});

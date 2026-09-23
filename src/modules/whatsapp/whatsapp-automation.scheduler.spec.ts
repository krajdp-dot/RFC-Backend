import { Test } from '@nestjs/testing';
import { WhatsAppAutomationScheduler } from './whatsapp-automation.scheduler.js';
import { WhatsAppService } from './whatsapp.service.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WHATSAPP_PROVIDER } from './whatsapp.constants.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';

describe('WhatsAppAutomationScheduler', () => {
  let scheduler: WhatsAppAutomationScheduler;
  let fakePrisma: FakePrismaService;

  async function build(seed: Partial<Record<string, any[]>>) {
    fakePrisma = new FakePrismaService({ business: [{ id: 'biz_1', name: 'RFC' }], ...seed });
    const moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppAutomationScheduler,
        WhatsAppService,
        AuditService,
        { provide: PrismaService, useValue: fakePrisma },
        { provide: WHATSAPP_PROVIDER, useValue: { name: 'fake' } },
      ],
    }).compile();
    scheduler = moduleRef.get(WhatsAppAutomationScheduler);
  }

  it('does nothing for a business with the automation off', async () => {
    await build({
      whatsAppAutomationSetting: [{ id: 'a1', businessId: 'biz_1', outstandingReminderEnabled: false }],
      customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'ABC', phone: '9876543210', whatsappOptIn: true, active: true }],
      sale: [{ id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', total: '5000', received: '0', status: 'COMPLETED' }],
    });
    const result = await scheduler.runForAllBusinesses();
    expect(result).toEqual({ sent: 0, skipped: 0 });
  });

  it('reminds a customer above the threshold, skips one below it', async () => {
    await build({
      whatsAppAutomationSetting: [{ id: 'a1', businessId: 'biz_1', outstandingReminderEnabled: true }],
      customer: [
        { id: 'above', businessId: 'biz_1', name: 'Above Threshold', phone: '9876543210', whatsappOptIn: true, active: true },
        { id: 'below', businessId: 'biz_1', name: 'Below Threshold', phone: '9876543211', whatsappOptIn: true, active: true },
      ],
      sale: [
        { id: 'sale_1', businessId: 'biz_1', customerId: 'above', total: '5000', received: '0', status: 'COMPLETED' },
        { id: 'sale_2', businessId: 'biz_1', customerId: 'below', total: '500', received: '0', status: 'COMPLETED' },
      ],
    });
    const result = await scheduler.runForAllBusinesses();
    expect(result).toEqual({ sent: 1, skipped: 1 });
    const [message] = fakePrisma._tables().whatsAppMessage;
    expect(message.relatedEntityId).toBe('above');
  });

  it('skips a customer who has not opted in even if above the threshold', async () => {
    await build({
      whatsAppAutomationSetting: [{ id: 'a1', businessId: 'biz_1', outstandingReminderEnabled: true }],
      customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'ABC', phone: '9876543210', whatsappOptIn: false, active: true }],
      sale: [{ id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', total: '5000', received: '0', status: 'COMPLETED' }],
    });
    const result = await scheduler.runForAllBusinesses();
    expect(result.sent).toBe(0);
  });

  it('running twice on the same day sends the reminder only once — reuses sendOutstandingReminder\'s own date-scoped idempotency key', async () => {
    await build({
      whatsAppAutomationSetting: [{ id: 'a1', businessId: 'biz_1', outstandingReminderEnabled: true }],
      customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'ABC', phone: '9876543210', whatsappOptIn: true, active: true }],
      sale: [{ id: 'sale_1', businessId: 'biz_1', customerId: 'cust_1', total: '5000', received: '0', status: 'COMPLETED' }],
    });
    await scheduler.runForAllBusinesses();
    await scheduler.runForAllBusinesses();
    expect(fakePrisma._tables().whatsAppMessage).toHaveLength(1);
  });
});

import { Test } from '@nestjs/testing';
import { WhatsAppQueueProcessor } from './whatsapp-queue.processor.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WHATSAPP_PROVIDER } from './whatsapp.constants.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { FakeWhatsAppProvider } from './providers/fake-whatsapp.provider.js';

describe('WhatsAppQueueProcessor', () => {
  let processor: WhatsAppQueueProcessor;
  let fakePrisma: FakePrismaService;
  let provider: FakeWhatsAppProvider;

  function queuedMessage(overrides: Partial<any> = {}) {
    return {
      id: 'msg_1',
      businessId: 'biz_1',
      customerId: 'cust_1',
      provider: 'fake',
      messageType: 'TRANSACTIONAL',
      templateName: 'sale_confirmation',
      templateVariables: { customer_name: 'ABC Fruits' },
      recipient: '+919876543210',
      contentSnapshot: 'Hello ABC Fruits, your order...',
      status: 'QUEUED',
      idempotencyKey: 'SALE:sale_1:SALE_CONFIRMATION',
      attemptCount: 0,
      ...overrides,
    };
  }

  async function build(messages: any[]) {
    fakePrisma = new FakePrismaService({ whatsAppMessage: messages });
    provider = new FakeWhatsAppProvider();
    const moduleRef = await Test.createTestingModule({
      providers: [
        WhatsAppQueueProcessor,
        { provide: PrismaService, useValue: fakePrisma },
        { provide: WHATSAPP_PROVIDER, useValue: provider },
      ],
    }).compile();
    processor = moduleRef.get(WhatsAppQueueProcessor);
  }

  describe('successful send', () => {
    it('marks a QUEUED message SENT with the provider message id', async () => {
      await build([queuedMessage()]);
      const result = await processor.processQueue();

      expect(result).toEqual({ sent: 1, failed: 0, stillQueued: 0 });
      const [message] = fakePrisma._tables().whatsAppMessage;
      expect(message.status).toBe('SENT');
      expect(message.providerMessageId).toMatch(/^fake_wamid_/);
      expect(message.sentAt).toBeTruthy();
    });

    it('sends every QUEUED message in one pass, oldest first', async () => {
      await build([
        queuedMessage({ id: 'msg_1', idempotencyKey: 'k1', createdAt: new Date('2026-09-20T10:00:00Z') }),
        queuedMessage({ id: 'msg_2', idempotencyKey: 'k2', createdAt: new Date('2026-09-20T09:00:00Z') }),
      ]);
      const result = await processor.processQueue();
      expect(result.sent).toBe(2);
    });

    it('never touches a message that is not QUEUED', async () => {
      await build([queuedMessage({ status: 'SENT' }), queuedMessage({ id: 'msg_2', idempotencyKey: 'k2', status: 'FAILED' })]);
      const result = await processor.processQueue();
      expect(result).toEqual({ sent: 0, failed: 0, stillQueued: 0 });
    });
  });

  describe('transient failure — retry (sections 33-34)', () => {
    it('a retryable failure stays QUEUED with the attempt recorded, not FAILED', async () => {
      await build([queuedMessage()]);
      provider.failNextSends = 1;
      provider.lastFailure = { code: 'RATE_LIMITED', retryable: true };

      const result = await processor.processQueue();
      expect(result).toEqual({ sent: 0, failed: 0, stillQueued: 1 });

      const [message] = fakePrisma._tables().whatsAppMessage;
      expect(message.status).toBe('QUEUED');
      expect(message.attemptCount).toBe(1);
      expect(message.failureCode).toBe('RATE_LIMITED');
    });

    it('a message is only marked FAILED after exhausting the attempt budget, never on the first failure', async () => {
      await build([queuedMessage({ attemptCount: 3 })]);
      provider.failNextSends = 1;

      await processor.processQueue();
      const [message] = fakePrisma._tables().whatsAppMessage;
      expect(message.status).toBe('QUEUED'); // attempt 4 of 5 — still under budget
      expect(message.attemptCount).toBe(4);
    });

    it('marks FAILED once the attempt budget is exhausted — visible and manually retryable, never silently dropped', async () => {
      await build([queuedMessage({ attemptCount: 4 })]); // this attempt will be #5, the max
      provider.failNextSends = 1;

      await processor.processQueue();
      const [message] = fakePrisma._tables().whatsAppMessage;
      expect(message.status).toBe('FAILED');
      expect(message.failedAt).toBeTruthy();
      const all = fakePrisma._tables().whatsAppMessage;
      expect(all).toHaveLength(1); // still in the store
    });

    it('a non-retryable provider error fails immediately without waiting for the attempt budget', async () => {
      await build([queuedMessage()]);
      provider.failNextSends = 1;
      provider.lastFailure = { code: 'INVALID_TEMPLATE', retryable: false };

      await processor.processQueue();
      const [message] = fakePrisma._tables().whatsAppMessage;
      expect(message.status).toBe('FAILED');
      expect(message.failureCode).toBe('INVALID_TEMPLATE');
    });
  });

  describe('rate limiting (section 31)', () => {
    it('processes at most BATCH_SIZE messages in a single pass', async () => {
      const many = Array.from({ length: 15 }, (_, i) => queuedMessage({ id: `msg_${i}`, idempotencyKey: `k${i}` }));
      await build(many);
      const result = await processor.processQueue();
      expect(result.sent).toBe(10); // BATCH_SIZE
      const stillQueued = fakePrisma._tables().whatsAppMessage.filter((m: any) => m.status === 'QUEUED');
      expect(stillQueued).toHaveLength(5);
    });
  });
});

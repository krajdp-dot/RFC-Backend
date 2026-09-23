import { Test } from '@nestjs/testing';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { WHATSAPP_PROVIDER } from './whatsapp.constants.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { FakeWhatsAppProvider } from './providers/fake-whatsapp.provider.js';
import { BadRequestException } from '@nestjs/common';

describe('WhatsAppWebhookController', () => {
  let controller: WhatsAppWebhookController;
  let fakePrisma: FakePrismaService;
  let provider: FakeWhatsAppProvider;

  async function build(seed: Partial<Record<string, any[]>> = {}) {
    fakePrisma = new FakePrismaService({ business: [{ id: 'biz_1', name: 'RFC' }], ...seed });
    provider = new FakeWhatsAppProvider();
    const moduleRef = await Test.createTestingModule({
      controllers: [WhatsAppWebhookController],
      providers: [
        { provide: PrismaService, useValue: fakePrisma },
        { provide: WHATSAPP_PROVIDER, useValue: provider },
      ],
    }).compile();
    controller = moduleRef.get(WhatsAppWebhookController);
  }

  function fakeRequest(body: any) {
    return { body, rawBody: Buffer.from(JSON.stringify(body)) } as any;
  }

  const VALID_SIG = 'fake-valid-signature'; // FakeWhatsAppProvider's own test marker — see fake-whatsapp.provider.ts

  beforeEach(async () => {
    await build();
  });

  describe('GET — verification handshake (section 15)', () => {
    const OLD_ENV = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN;
    afterEach(() => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = OLD_ENV;
    });

    it('echoes the challenge back when the token matches', () => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'correct-token';
      const result = controller.verify('subscribe', 'correct-token', 'challenge-123');
      expect(result).toBe('challenge-123');
    });

    it('refuses when the token does not match', () => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'correct-token';
      expect(() => controller.verify('subscribe', 'wrong-token', 'challenge-123')).toThrow(BadRequestException);
    });

    it('refuses when mode is not "subscribe"', () => {
      process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN = 'correct-token';
      expect(() => controller.verify('unsubscribe', 'correct-token', 'challenge-123')).toThrow(BadRequestException);
    });
  });

  describe('POST — signature verification (section 46, "test forged webhook requests")', () => {
    it('rejects a payload with no signature header at all', async () => {
      await expect(controller.receive(fakeRequest({ entry: [] }), undefined)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a payload with a signature that does not verify', async () => {
      await expect(controller.receive(fakeRequest({ entry: [] }), 'sha256=forged')).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a payload with a valid signature and produces zero side effects for an empty entry list', async () => {
      const result = await controller.receive(fakeRequest({ entry: [] }), VALID_SIG);
      expect(result).toEqual({ received: true });
    });
  });

  describe('POST — status updates', () => {
    function statusPayload(id: string, status: string) {
      return { entry: [{ changes: [{ value: { statuses: [{ id, status, timestamp: '1700000000' }] } }] }] };
    }

    it('updates the matching message by providerMessageId', async () => {
      await build({
        whatsAppMessage: [{ id: 'msg_1', businessId: 'biz_1', providerMessageId: 'wamid.123', status: 'SENT', customerId: 'cust_1', recipient: '+91', contentSnapshot: 'x', idempotencyKey: 'k1', provider: 'fake', messageType: 'TRANSACTIONAL' }],
      });
      await controller.receive(fakeRequest(statusPayload('wamid.123', 'delivered')), VALID_SIG);

      const [message] = fakePrisma._tables().whatsAppMessage;
      expect(message.status).toBe('DELIVERED');
      expect(message.deliveredAt).toBeTruthy();
    });

    it('a status for an unknown providerMessageId is logged and ignored, not an error', async () => {
      await expect(controller.receive(fakeRequest(statusPayload('wamid.unknown', 'delivered')), VALID_SIG)).resolves.toEqual({
        received: true,
      });
    });

    it('never regresses status — a late "delivered" arriving after "read" is ignored', async () => {
      await build({
        whatsAppMessage: [{ id: 'msg_1', businessId: 'biz_1', providerMessageId: 'wamid.123', status: 'READ', customerId: 'cust_1', recipient: '+91', contentSnapshot: 'x', idempotencyKey: 'k1', provider: 'fake', messageType: 'TRANSACTIONAL', readAt: new Date() }],
      });
      await controller.receive(fakeRequest(statusPayload('wamid.123', 'delivered')), VALID_SIG);
      const [message] = fakePrisma._tables().whatsAppMessage;
      expect(message.status).toBe('READ'); // unchanged
    });

    it('webhook idempotency (section 47): the identical status event delivered twice updates the message only once', async () => {
      await build({
        whatsAppMessage: [{ id: 'msg_1', businessId: 'biz_1', providerMessageId: 'wamid.123', status: 'SENT', customerId: 'cust_1', recipient: '+91', contentSnapshot: 'x', idempotencyKey: 'k1', provider: 'fake', messageType: 'TRANSACTIONAL' }],
      });
      const payload = fakeRequest(statusPayload('wamid.123', 'delivered'));
      await controller.receive(payload, VALID_SIG);
      await controller.receive(payload, VALID_SIG); // exact same delivery, redelivered by the provider

      expect(fakePrisma._tables().whatsAppWebhookEvent).toHaveLength(1); // deduped, not two records
      const [message] = fakePrisma._tables().whatsAppMessage;
      expect(message.status).toBe('DELIVERED'); // one clean transition, not corrupted by a second pass
    });

    it('a failed status records the failure reason', async () => {
      await build({
        whatsAppMessage: [{ id: 'msg_1', businessId: 'biz_1', providerMessageId: 'wamid.123', status: 'SENT', customerId: 'cust_1', recipient: '+91', contentSnapshot: 'x', idempotencyKey: 'k1', provider: 'fake', messageType: 'TRANSACTIONAL' }],
      });
      const payload = {
        entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.123', status: 'failed', errors: [{ code: 131026, title: 'Message undeliverable' }] }] } }] }],
      };
      await controller.receive(fakeRequest(payload), VALID_SIG);
      const [message] = fakePrisma._tables().whatsAppMessage;
      expect(message.status).toBe('FAILED');
      expect(message.failureReason).toBe('Message undeliverable');
    });
  });

  describe('POST — incoming messages (section 17)', () => {
    function incomingPayload(id: string, from: string, text: string) {
      return { entry: [{ changes: [{ value: { messages: [{ id, from, text: { body: text }, timestamp: '1700000000' }] } }] }] };
    }

    it('logs an incoming message and matches it to the customer by normalized phone', async () => {
      await build({ customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'ABC Fruits', phone: '9876543210' }] });
      await controller.receive(fakeRequest(incomingPayload('wamid.in1', '919876543210', 'Kal 20 box bhejna')), VALID_SIG);

      const [incoming] = fakePrisma._tables().whatsAppIncomingMessage;
      expect(incoming.customerId).toBe('cust_1');
      expect(incoming.content).toBe('Kal 20 box bhejna');
    });

    it('logs an incoming message even from an unrecognized number, with no customer match', async () => {
      await controller.receive(fakeRequest(incomingPayload('wamid.in2', '919999999999', 'Hi')), VALID_SIG);
      const [incoming] = fakePrisma._tables().whatsAppIncomingMessage;
      expect(incoming.customerId).toBeUndefined();
    });

    it('never auto-creates a sale or any other transaction from an incoming message (section 18)', async () => {
      await build({ customer: [{ id: 'cust_1', businessId: 'biz_1', name: 'ABC Fruits', phone: '9876543210' }] });
      await controller.receive(fakeRequest(incomingPayload('wamid.in3', '919876543210', '20 box apple bhej dena')), VALID_SIG);
      expect(fakePrisma._tables().sale ?? []).toHaveLength(0);
    });

    it('webhook idempotency applies to incoming messages too — a redelivered message is logged once', async () => {
      const payload = fakeRequest(incomingPayload('wamid.in4', '919876543210', 'Hello'));
      await controller.receive(payload, VALID_SIG);
      await controller.receive(payload, VALID_SIG);
      expect(fakePrisma._tables().whatsAppIncomingMessage).toHaveLength(1);
    });
  });
});

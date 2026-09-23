import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { WhatsAppService } from './whatsapp.service.js';
import { WhatsAppController } from './whatsapp.controller.js';
import { WhatsAppWebhookController } from './whatsapp-webhook.controller.js';
import { WhatsAppQueueProcessor } from './whatsapp-queue.processor.js';
import { WhatsAppAutomationListener } from './whatsapp-automation.listener.js';
import { WhatsAppAutomationScheduler } from './whatsapp-automation.scheduler.js';
import { WHATSAPP_PROVIDER } from './whatsapp.constants.js';
import { MetaCloudApiProvider } from './providers/meta-cloud-api.provider.js';
import { FakeWhatsAppProvider } from './providers/fake-whatsapp.provider.js';

/**
 * Phase 12, section 56 — the provider actually selected at runtime.
 * WHATSAPP_PROVIDER=meta_cloud_api with a real WHATSAPP_ACCESS_TOKEN
 * calls the real Meta Cloud API; anything else (unset, "fake", or
 * meta_cloud_api with no token configured) runs the fake provider
 * instead, so a misconfigured or credential-less deployment fails
 * obviously — every send logged as [FAKE PROVIDER] — rather than
 * pretending to work. See docs/PHASE-12-WHATSAPP.md, "Provider
 * configuration".
 */
const providerFactory = {
  provide: WHATSAPP_PROVIDER,
  useFactory: (config: ConfigService, meta: MetaCloudApiProvider, fake: FakeWhatsAppProvider) => {
    const selected = config.get<string>('WHATSAPP_PROVIDER', 'fake');
    const hasCredentials = Boolean(config.get<string>('WHATSAPP_ACCESS_TOKEN'));
    if (selected === 'meta_cloud_api' && hasCredentials) return meta;
    return fake;
  },
  inject: [ConfigService, MetaCloudApiProvider, FakeWhatsAppProvider],
};

@Module({
  imports: [ConfigModule, PrismaModule, AuditModule],
  controllers: [WhatsAppController, WhatsAppWebhookController],
  providers: [
    WhatsAppService,
    WhatsAppQueueProcessor,
    WhatsAppAutomationListener,
    WhatsAppAutomationScheduler,
    MetaCloudApiProvider,
    FakeWhatsAppProvider,
    providerFactory,
  ],
  exports: [WhatsAppService],
})
export class WhatsAppModule {}

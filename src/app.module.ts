import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard.js';
import { PermissionsGuard } from './modules/auth/authorization/permissions.guard.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { PrismaModule } from './modules/prisma/prisma.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { BusinessesModule } from './modules/businesses/businesses.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { ProductsModule } from './modules/products/products.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { SuppliersModule } from './modules/suppliers/suppliers.module.js';
import { AccountsModule } from './modules/accounts/accounts.module.js';
import { ExpensesModule } from './modules/expenses/expenses.module.js';
import { LotsModule } from './modules/lots/lots.module.js';
import { BoxesModule } from './modules/boxes/boxes.module.js';
import { InventoryModule } from './modules/inventory/inventory.module.js';
import { PurchasesModule } from './modules/purchases/purchases.module.js';
import { SalesModule } from './modules/sales/sales.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { FreshnessModule } from './modules/freshness/freshness.module.js';
import { PricingModule } from './modules/pricing/pricing.module.js';
import { ReceivablesModule } from './modules/receivables/receivables.module.js';
import { PayablesModule } from './modules/payables/payables.module.js';
import { ReconciliationModule } from './modules/reconciliation/reconciliation.module.js';
import { DashboardModule } from './modules/dashboard/dashboard.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { DayCloseModule } from './modules/day-close/day-close.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module.js';
import { IntelligenceModule } from './modules/intelligence/intelligence.module.js';
@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Rate limiting
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 100 }],
    }),

    // Phase 12: the WhatsApp queue worker's @Interval() tick
    // (WhatsAppQueueProcessor) and the automation listener's @OnEvent()
    // handlers (WhatsAppAutomationListener) both need these registered
    // once, globally — see docs/PHASE-12-WHATSAPP.md, "Message queue"
    // and "Event-driven design" for why these specific packages and not
    // Redis/Bull.
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),

    // Database
    PrismaModule,

    // Core
    AuthModule,
    BusinessesModule,
    UsersModule,

    // Catalog
    ProductsModule,

    // Inventory
    LotsModule,
    BoxesModule,
    InventoryModule,

    // Relationships
    CustomersModule,
    SuppliersModule,

    // Transactions
    PurchasesModule,
    SalesModule,
    PaymentsModule,

    // Financial
    AccountsModule,
    ExpensesModule,
    ReceivablesModule,
    PayablesModule,

    // Intelligence
    FreshnessModule,
    PricingModule,
    ReconciliationModule,

    // Aggregation
    DashboardModule,
    ReportsModule,
    DayCloseModule,
    AuditModule,
    WhatsAppModule,

    // Phase 13 — reads the modules above, writes to none of them.
    IntelligenceModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
    {
      provide: APP_GUARD,
      useClass: JwtAuthGuard,
    },
    // Phase 10: runs after JwtAuthGuard (registration order = execution
    // order for multiple APP_GUARD providers), so request.user.role is
    // already populated from the freshly-checked membership by the time
    // this reads it. A no-op for any route without @RequirePermission().
    {
      provide: APP_GUARD,
      useClass: PermissionsGuard,
    },
  ],
})
export class AppModule {}

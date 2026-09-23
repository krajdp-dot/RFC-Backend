import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller.js';
import { DashboardService } from './dashboard.service.js';
import { ReceivablesModule } from '../receivables/receivables.module.js';
import { PayablesModule } from '../payables/payables.module.js';
import { ExpensesModule } from '../expenses/expenses.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';
import { FreshnessModule } from '../freshness/freshness.module.js';

// Phase 7: the dashboard now reuses the same services every other screen in
// the app reuses (receivables/payables aging, expense category breakdown,
// reconciliation integrity checks, freshness/at-risk-stock) instead of
// recomputing any of that itself, so these modules need to be imported here
// too — Nest module encapsulation means importing DashboardModule alone
// doesn't transitively expose what it imports.
@Module({
  imports: [
    ReceivablesModule,
    PayablesModule,
    ExpensesModule,
    ReconciliationModule,
    FreshnessModule,
  ],
  controllers: [DashboardController],
  providers: [DashboardService],
})
export class DashboardModule {}

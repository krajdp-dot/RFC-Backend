import { Module } from '@nestjs/common';
import { IntelligenceController } from './intelligence.controller.js';
import { IntelligenceService } from './intelligence.service.js';
import { FreshnessModule } from '../freshness/freshness.module.js';
import { ReceivablesModule } from '../receivables/receivables.module.js';
import { PayablesModule } from '../payables/payables.module.js';
import { ExpensesModule } from '../expenses/expenses.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';

/**
 * Phase 13 — Intelligence sits on top of the existing source-of-truth
 * modules (spec's opening rule: "must NOT create a second accounting
 * system"). It imports the modules whose services it reuses rather than
 * re-implementing their logic, and owns no Prisma models of its own —
 * there is nothing in schema.prisma for this module because it has
 * nothing to persist.
 */
@Module({
  imports: [FreshnessModule, ReceivablesModule, PayablesModule, ExpensesModule, ReconciliationModule],
  controllers: [IntelligenceController],
  providers: [IntelligenceService],
  exports: [IntelligenceService],
})
export class IntelligenceModule {}

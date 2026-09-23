import { Module } from '@nestjs/common';
import { DayCloseController } from './day-close.controller.js';
import { DayCloseService } from './day-close.service.js';
import { AuditModule } from '../audit/audit.module.js';
import { ReconciliationModule } from '../reconciliation/reconciliation.module.js';

@Module({
  imports: [AuditModule, ReconciliationModule],
  controllers: [DayCloseController],
  providers: [DayCloseService],
})
export class DayCloseModule {}

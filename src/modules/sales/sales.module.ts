import { Module } from '@nestjs/common';
import { SalesController } from './sales.controller.js';
import { SalesService } from './sales.service.js';
import { LotsModule } from '../lots/lots.module.js';
import { AuditModule } from '../audit/audit.module.js';

@Module({
  imports: [LotsModule, AuditModule],
  controllers: [SalesController],
  providers: [SalesService],
  exports: [SalesService],
})
export class SalesModule {}

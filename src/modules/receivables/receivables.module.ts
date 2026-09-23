import { Module } from '@nestjs/common';
import { ReceivablesController } from './receivables.controller.js';
import { ReceivablesService } from './receivables.service.js';

@Module({
  controllers: [ReceivablesController],
  providers: [ReceivablesService],
  exports: [ReceivablesService],
})
export class ReceivablesModule {}

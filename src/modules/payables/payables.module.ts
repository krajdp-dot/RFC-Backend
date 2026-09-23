import { Module } from '@nestjs/common';
import { PayablesController } from './payables.controller.js';
import { PayablesService } from './payables.service.js';

@Module({
  controllers: [PayablesController],
  providers: [PayablesService],
  exports: [PayablesService],
})
export class PayablesModule {}

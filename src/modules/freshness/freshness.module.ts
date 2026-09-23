import { Module } from '@nestjs/common';
import { FreshnessController } from './freshness.controller.js';
import { FreshnessService } from './freshness.service.js';

@Module({
  controllers: [FreshnessController],
  providers: [FreshnessService],
  exports: [FreshnessService],
})
export class FreshnessModule {}

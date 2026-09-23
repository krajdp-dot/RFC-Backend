import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';
import { FreshnessModule } from '../freshness/freshness.module.js';

@Module({
  imports: [FreshnessModule],
  controllers: [ReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}

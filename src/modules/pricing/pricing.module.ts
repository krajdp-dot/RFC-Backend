import { Module } from '@nestjs/common';
import { PricingController, PricingProductsController, PricingLotsController } from './pricing.controller.js';
import { PricingService } from './pricing.service.js';
import { FreshnessModule } from '../freshness/freshness.module.js';

@Module({
  imports: [FreshnessModule],
  controllers: [PricingController, PricingProductsController, PricingLotsController],
  providers: [PricingService],
  exports: [PricingService],
})
export class PricingModule {}

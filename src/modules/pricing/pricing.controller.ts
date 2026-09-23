import { Controller, Get, Post, Body, Param } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PricingService } from './pricing.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CreateManualReferenceDto } from './dto/create-manual-reference.dto.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('pricing')
@ApiBearerAuth()
@Controller('pricing')
export class PricingController {
  constructor(private readonly pricingService: PricingService) {}

  @Get('board')
  @ApiOperation({ summary: 'Get current pricing board for all products' })
  @RequirePermission(PERMISSIONS.PRICING_VIEW)
  async getPricingBoard(@CurrentBusiness() businessId: string) {
    return this.pricingService.getPricingBoard(businessId);
  }

  @Post('manual-reference')
  @ApiOperation({ summary: 'Create manual price reference' })
  @RequirePermission(PERMISSIONS.PRICING_EDIT)
  async createManualReference(
    @CurrentBusiness() businessId: string,
    @Body() data: CreateManualReferenceDto,
  ) {
    return this.pricingService.createManualReference(businessId, data);
  }
}

@ApiTags('pricing')
@ApiBearerAuth()
@Controller('products')
export class PricingProductsController {
  constructor(private readonly pricingService: PricingService) {}

  @Get(':productId/pricing')
  @ApiOperation({ summary: 'Get detailed pricing for one product' })
  @RequirePermission(PERMISSIONS.PRICING_VIEW)
  async getProductPricing(
    @CurrentBusiness() businessId: string,
    @Param('productId') productId: string,
  ) {
    return this.pricingService.getProductPricing(businessId, productId);
  }
}

@ApiTags('pricing')
@ApiBearerAuth()
@Controller('lots')
export class PricingLotsController {
  constructor(private readonly pricingService: PricingService) {}

  @Get(':lotId/recommended-price')
  @ApiOperation({ summary: 'Get price recommendation for a lot' })
  @RequirePermission(PERMISSIONS.PRICING_VIEW)
  async getLotRecommendedPrice(
    @CurrentBusiness() businessId: string,
    @Param('lotId') lotId: string,
  ) {
    return this.pricingService.getLotRecommendedPrice(businessId, lotId);
  }
}

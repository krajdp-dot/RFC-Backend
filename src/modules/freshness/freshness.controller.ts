import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { FreshnessService } from './freshness.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('freshness')
@ApiBearerAuth()
@Controller('freshness')
export class FreshnessController {
  constructor(private readonly freshnessService: FreshnessService) {}

  @Get()
  @ApiOperation({ summary: 'Get all lots with freshness info' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  async getFreshness(@CurrentBusiness() businessId: string) {
    return this.freshnessService.getAllLotsFreshness(businessId);
  }

  @Get('at-risk')
  @ApiOperation({ summary: 'Get lots with at-risk status' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  async getAtRiskStock(@CurrentBusiness() businessId: string) {
    return this.freshnessService.getAtRiskStock(businessId);
  }

  @Get(':lotId')
  @ApiOperation({ summary: 'Get single lot freshness detail' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  async getLotFreshness(
    @CurrentBusiness() businessId: string,
    @Param('lotId') lotId: string,
  ) {
    return this.freshnessService.getLotFreshness(businessId, lotId);
  }
}

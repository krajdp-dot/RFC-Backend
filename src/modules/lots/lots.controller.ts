import { FreshnessStatus, LotStatus } from '../../common/enums.js';
﻿import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { LotsService } from './lots.service.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('lots')
@ApiBearerAuth()
@Controller('lots')
export class LotsController {
  constructor(private readonly lotsService: LotsService) {}

  @Get()
  @ApiOperation({ summary: 'List lots with pagination and filters' })
  @ApiQuery({ name: 'productId', required: false, type: 'string' })
  @ApiQuery({ name: 'status', required: false, enum: LotStatus })
  @ApiQuery({ name: 'freshnessStatus', required: false, enum: FreshnessStatus })
  @ApiQuery({ name: 'page', required: false, type: 'number' })
  @ApiQuery({ name: 'limit', required: false, type: 'number' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  findAll(
    @CurrentBusiness() businessId: string,
    @Query('productId') productId?: string,
    @Query('status') status?: LotStatus,
    @Query('freshnessStatus') freshnessStatus?: FreshnessStatus,
    @Query() paginationDto?: PaginationDto,
  ) {
    return this.lotsService.findAll(businessId, { productId, status, freshnessStatus }, paginationDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single lot with boxes and recent movements' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  findOne(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
  ) {
    return this.lotsService.findOne(businessId, id);
  }
}

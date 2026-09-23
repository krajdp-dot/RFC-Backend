import { BoxStatus } from '../../common/enums.js';
﻿import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { BoxesService } from './boxes.service.js';
import { CreateBoxDto } from './dto/create-box.dto.js';
import { AdjustBoxDto } from './dto/adjust-box.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('boxes')
@ApiBearerAuth()
@Controller('boxes')
export class BoxesController {
  constructor(private readonly boxesService: BoxesService) {}

  @Get()
  @ApiOperation({ summary: 'List boxes' })
  @ApiQuery({ name: 'lotId', required: false })
  @ApiQuery({ name: 'productId', required: false })
  @ApiQuery({ name: 'status', required: false, enum: BoxStatus })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  findAll(
    @CurrentBusiness() businessId: string,
    @Query('lotId') lotId?: string,
    @Query('productId') productId?: string,
    @Query('status') status?: BoxStatus,
    @Query() paginationDto?: PaginationDto,
  ) {
    return this.boxesService.findAll(businessId, { lotId, productId, status }, paginationDto);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single box' })
  @RequirePermission(PERMISSIONS.INVENTORY_VIEW)
  findOne(@CurrentBusiness() businessId: string, @Param('id') id: string) {
    return this.boxesService.findOne(businessId, id);
  }

  @Post()
  @ApiOperation({ summary: 'Create a box' })
  @RequirePermission(PERMISSIONS.PRODUCTS_EDIT)
  create(@CurrentBusiness() businessId: string, @Body() dto: CreateBoxDto) {
    return this.boxesService.create(businessId, dto);
  }

  @Post(':id/adjust')
  @ApiOperation({ summary: 'Adjust box status or weight' })
  @RequirePermission(PERMISSIONS.INVENTORY_ADJUST)
  adjust(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Body() dto: AdjustBoxDto,
  ) {
    return this.boxesService.adjust(businessId, id, dto);
  }
}

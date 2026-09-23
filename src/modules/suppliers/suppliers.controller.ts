import { Controller, Get, Post, Body, Put, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SuppliersService } from './suppliers.service.js';
import { CreateSupplierDto } from './dto/create-supplier.dto.js';
import { UpdateSupplierDto } from './dto/update-supplier.dto.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('suppliers')
@ApiBearerAuth()
@Controller('suppliers')
export class SuppliersController {
  constructor(private readonly suppliersService: SuppliersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new supplier' })
  @RequirePermission(PERMISSIONS.SUPPLIERS_CREATE)
  create(
    @CurrentBusiness() businessId: string,
    @Body() createSupplierDto: CreateSupplierDto,
  ) {
    return this.suppliersService.create(businessId, createSupplierDto);
  }

  @Get()
  @ApiOperation({ summary: 'List suppliers with pagination' })
  @RequirePermission(PERMISSIONS.SUPPLIERS_VIEW)
  findAll(
    @CurrentBusiness() businessId: string,
    @Query() paginationDto: PaginationDto,
    @Query('search') search?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.suppliersService.findAll(businessId, paginationDto, search, activeOnly !== 'false');
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single supplier with summary stats' })
  @RequirePermission(PERMISSIONS.SUPPLIERS_VIEW)
  findOne(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
  ) {
    return this.suppliersService.findOne(businessId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update supplier' })
  @RequirePermission(PERMISSIONS.SUPPLIERS_EDIT)
  update(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Body() updateSupplierDto: UpdateSupplierDto,
  ) {
    return this.suppliersService.update(businessId, id, updateSupplierDto);
  }

  @Get(':id/ledger')
  @ApiOperation({ summary: 'Get supplier transaction history' })
  @RequirePermission(PERMISSIONS.SUPPLIERS_VIEW)
  getLedger(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.suppliersService.getSupplierLedger(businessId, id, paginationDto);
  }

  @Get(':id/aging')
  @ApiOperation({ summary: 'Get supplier aging analysis' })
  @RequirePermission(PERMISSIONS.SUPPLIERS_VIEW)
  getAging(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
  ) {
    return this.suppliersService.getSupplierAging(businessId, id);
  }
}

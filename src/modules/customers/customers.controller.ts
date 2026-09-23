import { Controller, Get, Post, Body, Put, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CustomersService } from './customers.service.js';
import { CreateCustomerDto } from './dto/create-customer.dto.js';
import { UpdateCustomerDto } from './dto/update-customer.dto.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('customers')
@ApiBearerAuth()
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  @ApiOperation({ summary: 'Create a new customer' })
  @RequirePermission(PERMISSIONS.CUSTOMERS_CREATE)
  async create(
    @CurrentBusiness() businessId: string,
    @Body() dto: CreateCustomerDto
  ) {
    return this.customersService.create(businessId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List customers with pagination' })
  @RequirePermission(PERMISSIONS.CUSTOMERS_VIEW)
  async findAll(
    @CurrentBusiness() businessId: string,
    @Query() paginationDto: PaginationDto,
    @Query('search') search?: string,
    @Query('activeOnly') activeOnly?: string,
  ) {
    return this.customersService.findAll(
      businessId,
      paginationDto,
      search,
      activeOnly !== 'false',
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single customer with summary stats' })
  @RequirePermission(PERMISSIONS.CUSTOMERS_VIEW)
  async findOne(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string
  ) {
    return this.customersService.findOne(businessId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update customer' })
  @RequirePermission(PERMISSIONS.CUSTOMERS_EDIT)
  async update(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.update(businessId, id, dto);
  }

  @Get(':id/ledger')
  @ApiOperation({ summary: 'Get customer transaction history' })
  @RequirePermission(PERMISSIONS.CUSTOMERS_VIEW)
  async getLedger(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Query() paginationDto: PaginationDto,
  ) {
    return this.customersService.getCustomerLedger(
      businessId,
      id,
      paginationDto,
    );
  }

  @Get(':id/aging')
  @ApiOperation({ summary: 'Get customer aging analysis' })
  @RequirePermission(PERMISSIONS.CUSTOMERS_VIEW)
  async getAging(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string
  ) {
    return this.customersService.getCustomerAging(
      businessId,
      id,
    );
  }
}


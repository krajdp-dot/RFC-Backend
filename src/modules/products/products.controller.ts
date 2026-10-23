import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  ParseIntPipe,
  DefaultValuePipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiQuery,
} from '@nestjs/swagger';
import { ProductsService } from './products.service.js';
import {
  CreateProductDto,
  FreshnessProfileDto,
} from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('products')
@ApiBearerAuth()
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) { }

  @Post()
  @ApiOperation({ summary: 'Create a new product' })
  @RequirePermission(PERMISSIONS.PRODUCTS_EDIT)
  async create(
    @CurrentBusiness() businessId: string,
    @Body() dto: CreateProductDto
  ) {
    return this.productsService.create(businessId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List products with pagination and filters' })
  @ApiQuery({ name: 'search', required: false, type: String })
  @ApiQuery({ name: 'category', required: false, type: String })
  @ApiQuery({ name: 'isActive', required: false, type: Boolean })
  @RequirePermission(PERMISSIONS.PRODUCTS_VIEW)
  async findAll(
    @CurrentBusiness() businessId: string,
    @Query() paginationDto: PaginationDto,
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('isActive') activeStr?: string,
  ) {
    let active: boolean | undefined;

    if (activeStr !== undefined) {
      active = activeStr === 'true';
    }

    return this.productsService.findAll(businessId, paginationDto, {
      search,
      category,
      active,
    });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get single product details' })
  @RequirePermission(PERMISSIONS.PRODUCTS_VIEW)
  async findOne(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string
  ) {
    return this.productsService.findOne(businessId, id);
  }

  @Put(':id')
  @ApiOperation({ summary: 'Update product' })
  @RequirePermission(PERMISSIONS.PRODUCTS_EDIT)
  async update(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    return this.productsService.update(
      businessId,
      id,
      dto,
    );
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove product from active catalogue while preserving historical records' })
  @RequirePermission(PERMISSIONS.PRODUCTS_DELETE)
  async deleteProduct(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @CurrentUser('userId') userId: string,
    @Body() body?: { reason?: string },
  ) {
    return this.productsService.deleteProduct(businessId, id, userId, body?.reason);
  }

  @Get(':id/freshness-profile')
  @ApiOperation({ summary: 'Get freshness decay curve for a product' })
  @RequirePermission(PERMISSIONS.PRODUCTS_VIEW)
  async getFreshnessProfile(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
  ) {
    return this.productsService.getFreshnessProfile(
      businessId,
      id,
    );
  }

  @Put(':id/freshness-profile')
  @ApiOperation({ summary: 'Update freshness decay curve for a product' })
  @RequirePermission(PERMISSIONS.PRODUCTS_EDIT)
  async updateFreshnessProfile(
    @CurrentBusiness() businessId: string,
    @Param('id') id: string,
    @Body() profiles: FreshnessProfileDto[],
  ) {
    return this.productsService.updateFreshnessProfile(
      businessId,
      id,
      profiles,
    );
  }
}
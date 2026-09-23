import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiQuery } from '@nestjs/swagger';
import { ExpensesService } from './expenses.service.js';
import { CreateExpenseDto } from './dto/create-expense.dto.js';
import { CreateExpenseCategoryDto } from './dto/create-expense-category.dto.js';
import { PaginationDto } from '../../common/dto/pagination.dto.js';
import { CurrentBusiness } from '../../common/decorators/current-business.decorator.js';
import { RequirePermission } from '../auth/authorization/require-permission.decorator.js';
import { PERMISSIONS } from '../auth/authorization/permissions.js';

@ApiTags('expenses')
@ApiBearerAuth()
@Controller('expenses')
export class ExpensesController {
  constructor(private readonly expensesService: ExpensesService) {}

  @Post('categories')
  @ApiOperation({ summary: 'Create an expense category' })
  @RequirePermission(PERMISSIONS.EXPENSES_CREATE)
  createCategory(
    @CurrentBusiness() businessId: string,
    @Body() createCategoryDto: CreateExpenseCategoryDto,
  ) {
    return this.expensesService.createCategory(businessId, createCategoryDto);
  }

  @Get('categories')
  @ApiOperation({ summary: 'List all expense categories' })
  @RequirePermission(PERMISSIONS.EXPENSES_VIEW)
  findAllCategories(@CurrentBusiness() businessId: string) {
    return this.expensesService.findAllCategories(businessId);
  }

  @Post()
  @ApiOperation({ summary: 'Record a new expense' })
  @RequirePermission(PERMISSIONS.EXPENSES_CREATE)
  create(
    @CurrentBusiness() businessId: string,
    @Body() createExpenseDto: CreateExpenseDto,
  ) {
    return this.expensesService.create(businessId, createExpenseDto);
  }

  @Get()
  @ApiOperation({ summary: 'List expenses with pagination and filters' })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'accountId', required: false })
  @RequirePermission(PERMISSIONS.EXPENSES_VIEW)
  findAll(
    @CurrentBusiness() businessId: string,
    @Query() paginationDto: PaginationDto,
    @Query('categoryId') categoryId?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('accountId') accountId?: string,
  ) {
    return this.expensesService.findAll(businessId, paginationDto, categoryId, startDate, endDate, accountId);
  }

  @Get('summary')
  @ApiOperation({ summary: 'Get expense summary breakdown' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @RequirePermission(PERMISSIONS.EXPENSES_VIEW)
  getSummary(
    @CurrentBusiness() businessId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.expensesService.getExpenseSummary(businessId, startDate, endDate);
  }
}

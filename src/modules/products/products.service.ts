import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { CreateProductDto, FreshnessProfileDto } from './dto/create-product.dto.js';
import { UpdateProductDto } from './dto/update-product.dto.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { Prisma } from '@prisma/client';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(businessId: string, dto: CreateProductDto) {
    const { freshnessProfile, ...productData } = dto;
    
    return this.prisma.product.create({
      data: {
        ...productData,
        businessId,
        freshnessProfiles: freshnessProfile ? {
          create: freshnessProfile.map(fp => ({
            dayOffset: fp.dayOffset,
            qualityPct: fp.qualityPct,
            status: fp.status as any,
            priceMultiplier: fp.priceMultiplier,
          })),
        } : undefined,
      },
      include: {
        freshnessProfiles: true,
      },
    });
  }

  async findAll(businessId: string, paginationDto: PaginationDto, filters: {
    search?: string;
    category?: string;
    active?: boolean;
  } = {}) {
    const { search, category, active } = filters;
    const skip = paginationDto.skip || 0;
    const take = paginationDto.take || 20;
    
    const where: Prisma.ProductWhereInput = {
      businessId,
      ...(search ? { name: { contains: search, mode: 'insensitive' } } : {}),
      ...(category ? { category } : {}),
      ...(active !== undefined ? { active } : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        skip,
        take,
        include: { freshnessProfiles: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return paginatedResponse(items, total, paginationDto.page || 1, paginationDto.limit || 20);
  }

  async findOne(businessId: string, id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, businessId },
      include: {
        freshnessProfiles: {
          orderBy: { dayOffset: 'asc' },
        },
      },
    });

    if (!product) {
      throw new NotFoundException('Product not found');
    }

    return product;
  }

  async update(businessId: string, id: string, dto: UpdateProductDto) {
    const { freshnessProfile, ...productData } = dto;
    
    // Check if exists
    await this.findOne(businessId, id);

    return this.prisma.product.update({
      where: { id },
      data: productData,
      include: { freshnessProfiles: true },
    });
  }

  async getFreshnessProfile(businessId: string, id: string) {
    const product = await this.findOne(businessId, id);
    return product.freshnessProfiles;
  }

  async updateFreshnessProfile(businessId: string, id: string, profiles: FreshnessProfileDto[]) {
    // Check if exists
    await this.findOne(businessId, id);

    return this.prisma.$transaction(async (tx) => {
      // Delete old profiles
      await tx.freshnessProfile.deleteMany({
        where: { productId: id },
      });

      // Create new ones
      if (profiles && profiles.length > 0) {
        await tx.freshnessProfile.createMany({
          data: profiles.map(fp => ({
            productId: id,
            dayOffset: fp.dayOffset,
            qualityPct: fp.qualityPct,
            status: fp.status as any,
            priceMultiplier: fp.priceMultiplier,
          })),
        });
      }

      return tx.freshnessProfile.findMany({
        where: { productId: id },
        orderBy: { dayOffset: 'asc' },
      });
    });
  }
}

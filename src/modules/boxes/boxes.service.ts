import { BoxStatus } from '../../common/enums.js';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service.js';
import { CreateBoxDto } from './dto/create-box.dto.js';
import { AdjustBoxDto } from './dto/adjust-box.dto.js';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { toDecimal } from '../../common/utils/money.util.js';
import { generateReference } from '../../common/utils/reference.util.js';

@Injectable()
export class BoxesService {
  constructor(private prisma: PrismaService) {}

  async findAll(businessId: string, params: { lotId?: string; productId?: string; status?: BoxStatus }, paginationDto?: PaginationDto) {
    const skip = paginationDto?.skip || 0;
    const take = paginationDto?.take || 100;

    const where = {
      businessId,
      ...params
    };

    const [items, total] = await Promise.all([
      this.prisma.box.findMany({
        where,
        skip,
        take,
        orderBy: { createdAt: 'desc' }
      }),
      this.prisma.box.count({ where }),
    ]);

    return paginatedResponse(items, total, paginationDto?.page || 1, paginationDto?.limit || 100);
  }

  async findOne(businessId: string, id: string) {
    const box = await this.prisma.box.findFirst({
      where: { id, businessId },
      include: {
        lot: true,
        product: true
      }
    });

    if (!box) {
      throw new NotFoundException('Box not found');
    }

    return box;
  }

  async create(businessId: string, dto: CreateBoxDto) {
    const lot = await this.prisma.lot.findFirst({
      where: { id: dto.lotId, businessId }
    });

    if (!lot) {
      throw new NotFoundException('Lot not found');
    }

    return this.prisma.box.create({
      data: {
        businessId,
        lotId: lot.id,
        productId: lot.productId,
        boxReference: generateReference('BOX', new Date().toISOString()),
        purchaseCost: lot.costPerBox,
        currentCost: lot.costPerBox,
        netWeightKg: dto.weightKg ? toDecimal(dto.weightKg) : toDecimal(0),
        qualityNotes: dto.label,
        status: BoxStatus.IN_STOCK
      }
    });
  }

  async adjust(businessId: string, id: string, dto: AdjustBoxDto) {
    const box = await this.prisma.box.findFirst({
      where: { id, businessId }
    });

    if (!box) {
      throw new NotFoundException('Box not found');
    }

    return this.prisma.box.update({
      where: { id },
      data: {
        status: dto.status,
        netWeightKg: dto.weightKg ? toDecimal(dto.weightKg) : undefined
      }
    });
  }
}

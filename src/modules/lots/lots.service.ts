import { FreshnessStatus, LotStatus } from '../../common/enums';
import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../modules/prisma/prisma.service';
import { PaginationDto, paginatedResponse } from '../../common/dto/pagination.dto.js';
import { getAgeDays } from '../../common/utils/date.util';

@Injectable()
export class LotsService {
  constructor(private prisma: PrismaService) {}

  async findAll(businessId: string, params: {
    productId?: string;
    status?: LotStatus;
    freshnessStatus?: FreshnessStatus;
  }, paginationDto?: PaginationDto) {
    const skip = paginationDto?.skip || 0;
    const take = paginationDto?.take || 20;
    const { productId, status, freshnessStatus } = params;

    const where = {
      businessId,
      ...(productId && { productId }),
      ...(status && { status }),
      ...(freshnessStatus && { freshnessStatus }),
    };

    const [items, total] = await Promise.all([
      this.prisma.lot.findMany({
        where,
        skip,
        take,
        orderBy: { receivedDate: "desc" },
        include: { product: { select: { name: true } } }
      }),
      this.prisma.lot.count({ where })
    ]);

    return paginatedResponse(items, total, paginationDto?.page || 1, paginationDto?.limit || 20);
  }

  async findOne(businessId: string, id: string) {
    const lot = await this.prisma.lot.findFirst({
      where: { id, businessId },
      include: {
        product: true,
        boxes: {
          take: 50,
          orderBy: { createdAt: "desc" }
        },
        inventoryMovements: {
          take: 20,
          orderBy: { businessDate: "desc" }
        }
      }
    });

    if (!lot) {
      throw new NotFoundException('Lot not found');
    }

    return lot;
  }

  async getFEFOLots(tx: any, businessId: string, productId: string) {
    return tx.lot.findMany({
      where: {
        businessId,
        productId,
        status: LotStatus.ACTIVE,
        remainingBoxes: { gt: 0 }
      },
      orderBy: [
        { freshnessScore: 'asc' },
        { receivedDate: 'asc' }
      ]
    });
  }


}

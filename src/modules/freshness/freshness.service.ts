import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { toMoneyString, toDecimal } from '../../common/utils/money.util.js';

@Injectable()
export class FreshnessService {
  constructor(private readonly prisma: PrismaService) {}

  async calculateFreshness(lot: any, product: any) {
    if (!lot.receivedDate || !product.id) return { score: 100, status: 'FRESH', priceMultiplier: 1.0 };
    
    const now = new Date();
    const ageMs = now.getTime() - new Date(lot.receivedDate).getTime();
    const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));

    const profiles = await (this.prisma as any).freshnessProfile?.findMany({
      where: { productId: product.id, dayOffset: { lte: ageDays } },
      orderBy: { dayOffset: 'desc' },
      take: 1,
    }) || [];

    const profile = profiles[0];
    if (profile) {
      return {
        score: toDecimal(profile.qualityPct).toNumber(),
        status: profile.status,
        priceMultiplier: toDecimal(profile.priceMultiplier).toNumber(),
      };
    }
    return { score: 100, status: 'FRESH', priceMultiplier: 1.0 };
  }

  async getAllLotsFreshness(businessId: string) {
    // Flat queries + in-memory join instead of `include: { product: true }`
    // — resolves fine against real Postgres, but is a silent no-op against
    // this repo's FakePrismaService test double (findMany only ever reads
    // `where`/`orderBy`/`take`), which left getAtRiskStock() (used directly
    // by Phase 7's dashboard) untestable. Same fix applied here as in
    // receivables/payables/expenses.service.ts.
    const [lots, products] = await Promise.all([
      this.prisma.lot.findMany({ where: { businessId, status: { not: 'DEPLETED' } } }),
      this.prisma.product.findMany({ where: { businessId } }),
    ]);
    const productById = new Map(products.map((p: any) => [p.id, p]));

    const result = [];
    for (const lot of lots) {
      const product = productById.get(lot.productId);
      const freshness = await this.calculateFreshness(lot, product || {});
      result.push({ ...lot, product, freshness });
    }
    return result.sort((a, b) => a.freshness.score - b.freshness.score);
  }

  async getLotFreshness(businessId: string, lotId: string) {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, businessId },
      include: { product: true },
    });
    if (!lot) throw new NotFoundException('Lot not found');
    const freshness = await this.calculateFreshness(lot, lot.product);
    return { ...lot, freshness };
  }

  async recalculateAllFreshness(businessId: string) {
    const lots = await this.prisma.lot.findMany({
      where: { businessId, status: { not: 'DEPLETED' } },
      include: { product: true },
    });

    for (const lot of lots) {
      const freshness = await this.calculateFreshness(lot, lot.product);
      await this.prisma.lot.update({
        where: { id: lot.id },
        data: {
          freshnessScore: freshness.score,
          freshnessStatus: freshness.status,
        },
      });
    }
    return { success: true };
  }

  async getAtRiskStock(businessId: string) {
    const lots = await this.getAllLotsFreshness(businessId);
    const atRisk = lots.filter((l) => l.freshness.score < 70);
    
    return atRisk.map((l) => {
      const cost = toDecimal(l.costPerBox);
      const remaining = toDecimal(l.remainingBoxes);
      const valueAtRisk = remaining.times(cost).times(toDecimal(1).minus(l.freshness.priceMultiplier || 1)).toNumber();
      
      let recommendedAction = 'WATCH';
      if (l.freshness.score < 50) recommendedAction = 'CLEAR_TODAY';
      else if (l.freshness.score < 60) recommendedAction = 'MARKDOWN';

      return {
        lotId: l.id,
        lotReference: l.lotReference,
        productName: l.product.name,
        remainingBoxes: remaining,
        costPerBox: toMoneyString(cost),
        freshnessScore: l.freshness.score,
        freshnessStatus: l.freshness.status,
        valueAtRisk: toMoneyString(valueAtRisk),
        recommendedAction,
      };
    });
  }
}

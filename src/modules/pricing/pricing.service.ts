import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { FreshnessService } from '../freshness/freshness.service.js';
import { toMoneyString, toDecimal, mulDecimal, sumDecimal, calcMarginPct } from '../../common/utils/money.util.js';
import { CreateManualReferenceDto } from './dto/create-manual-reference.dto.js';

/**
 * Phase 6 — real pricing math, decimal-safe.
 * markup% is COST-relative: price = cost * (1 + markup/100).
 * margin% is PRICE-relative: minimumPrice = cost / (1 - minMargin/100) —
 * these are deliberately different formulas (spec \u00a76/\u00a77); the previous
 * code used `cost * (1 + 0.05)` for its "5% min margin", which is a markup
 * calculation, not a margin one.
 */
function recommendedFromMarkup(cost: any, defaultMarkupPct: any) {
  const pct = toDecimal(defaultMarkupPct ?? 0);
  return toDecimal(cost).times(toDecimal(1).plus(pct.dividedBy(100)));
}

function minimumFromMargin(cost: any, minMarginPct: any) {
  const pct = toDecimal(minMarginPct ?? 0);
  const denom = toDecimal(1).minus(pct.dividedBy(100));
  if (denom.lte(0)) {
    // Impossible configuration (minMarginPct >= 100) — fall back to cost
    // rather than dividing by zero/negative and returning nonsense.
    return toDecimal(cost);
  }
  return toDecimal(cost).dividedBy(denom);
}

@Injectable()
export class PricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly freshnessService: FreshnessService,
  ) {}

  async getPricingBoard(businessId: string) {
    const products = await this.prisma.product.findMany({
      where: { businessId, active: true },
    });

    const board = [];
    for (const p of products) {
      board.push(await this.getProductPricing(businessId, p.id));
    }
    return board;
  }

  async getProductPricing(businessId: string, productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, businessId },
    });
    if (!product) throw new NotFoundException('Product not found');

    const lots = await this.prisma.lot.findMany({
      where: { productId, businessId, status: { not: 'DEPLETED' } },
    });

    let avgCost = toDecimal(0);
    if (lots.length > 0) {
      const totalCost = lots.reduce((sum, l) => sumDecimal(sum, mulDecimal(l.costPerBox, l.remainingBoxes)), toDecimal(0));
      const totalBoxes = lots.reduce((sum, l) => sumDecimal(sum, l.remainingBoxes), toDecimal(0));
      avgCost = totalBoxes.gt(0) ? totalCost.dividedBy(totalBoxes) : toDecimal(0);
    }

    const priceRef = await this.prisma.priceReference.findFirst({
      where: { productId, businessId },
      orderBy: { createdAt: 'desc' },
    });
    const marketPrice = priceRef ? toDecimal(priceRef.marketPrice) : null;

    // Phase 6: was `avgCost.times(1.15)` blended with `marketPrice*0.98` —
    // a hardcoded 15% for every product regardless of its own configured
    // defaultMarkupPct, and an unrequested market-undercut rule with its
    // own hardcoded 2%. Now genuinely per-product.
    const recommendedPrice = recommendedFromMarkup(avgCost, (product as any).defaultMarkupPct);
    const minimumPrice = minimumFromMargin(avgCost, (product as any).minMarginPct);

    return {
      productId: product.id,
      productName: product.name,
      marketPrice: marketPrice ? toMoneyString(marketPrice) : null,
      avgCost: toMoneyString(avgCost),
      recommendedPrice: toMoneyString(recommendedPrice),
      minimumPrice: toMoneyString(minimumPrice),
      margin: toMoneyString(recommendedPrice.minus(avgCost)),
      marginPct: calcMarginPct(recommendedPrice, avgCost).toNumber(),
      source: priceRef?.source || null,
      lastUpdated: priceRef?.createdAt || null,
      // Phase 6: `currentSellingPrice` (literally commented "// Mock" in the
      // previous version, a copy of recommendedPrice) and a hardcoded
      // `trend: 'UP'` were removed rather than half-fixed — there was no
      // real data behind either and nothing in the spec asks for them.
      // Computing a genuine "current selling price" would mean querying
      // recent sale items for this product; not done here, see the report.
    };
  }

  async getLotRecommendedPrice(businessId: string, lotId: string) {
    const lot = await this.prisma.lot.findFirst({
      where: { id: lotId, businessId },
      include: { product: true },
    });
    if (!lot) throw new NotFoundException('Lot not found');

    const freshness = await this.freshnessService.calculateFreshness(lot, lot.product);
    const cost = toDecimal(lot.costPerBox);
    const product: any = lot.product;

    const priceRef = await this.prisma.priceReference.findFirst({
      where: { productId: lot.productId, businessId },
      orderBy: { createdAt: 'desc' },
    });
    const marketPrice = priceRef ? toDecimal(priceRef.marketPrice) : null;

    // Phase 6: real config, not `1.15`/`1.05`(itself a markup formula
    // mislabeled "min margin")/`1.02`.
    const baseRecommended = recommendedFromMarkup(cost, product.defaultMarkupPct);
    const minimumPrice = minimumFromMargin(cost, product.minMarginPct);

    // Freshness (existing FreshnessService, not a second engine) can only
    // move the price DOWN toward the minimum, never below it — clearance
    // guidance still has to respect the configured margin floor (spec \u00a78).
    const freshnessAdjusted = baseRecommended.times(toDecimal(freshness.priceMultiplier));
    const recommended = freshnessAdjusted.lt(minimumPrice) ? minimumPrice : freshnessAdjusted;
    const clearance = freshnessAdjusted.lt(minimumPrice) ? minimumPrice : freshnessAdjusted;

    const valueAtRisk = mulDecimal(lot.remainingBoxes, cost).times(toDecimal(1).minus(toDecimal(freshness.priceMultiplier)));

    return {
      lotId,
      recommended: toMoneyString(recommended),
      minimum: toMoneyString(minimumPrice),
      clearance: toMoneyString(clearance),
      marketPrice: marketPrice ? toMoneyString(marketPrice) : null,
      valueAtRisk: toMoneyString(valueAtRisk),
      reason: `Freshness ${freshness.status}${marketPrice ? `, Market \u20b9${toMoneyString(marketPrice)}` : ''}`,
    };
  }

  async createManualReference(businessId: string, data: CreateManualReferenceDto) {
    return this.prisma.priceReference.create({
      data: {
        businessId,
        productId: data.productId,
        marketPrice: data.marketPrice,
        source: 'MANUAL',
        notes: data.notes,
        effectiveDate: new Date(),
      },
    });
  }

  async getBuyHoldDecision(businessId: string, productId: string) {
    // NOTE: still a stub, unchanged by this phase. Nothing in the Phase 6
    // spec defines what a real buy/hold decision should weigh (velocity?
    // days of cover? freshness curve?) — guessing at that isn't the same as
    // fixing a hardcoded percentage against a known-correct formula, so
    // this is flagged rather than filled in. See the Phase 6 report.
    return { decision: 'HOLD', reason: 'Sufficient stock for current velocity.' };
  }
}

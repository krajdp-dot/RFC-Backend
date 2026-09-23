import { Test } from '@nestjs/testing';
import { PricingService } from './pricing.service.js';
import { FreshnessService } from '../freshness/freshness.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';

describe('PricingService.getProductPricing', () => {
  let pricingService: PricingService;
  let fakePrisma: FakePrismaService;

  async function build(product: any, lots: any[], priceReferences: any[] = []) {
    fakePrisma = new FakePrismaService({ product: [product], lot: lots, priceReference: priceReferences });
    const moduleRef = await Test.createTestingModule({
      providers: [PricingService, FreshnessService, { provide: PrismaService, useValue: fakePrisma }],
    }).compile();
    pricingService = moduleRef.get(PricingService);
  }

  it('uses the product\u2019s own defaultMarkupPct, not a hardcoded 15% for every product', async () => {
    await build(
      { id: 'p1', businessId: 'biz_1', name: 'Apple', defaultMarkupPct: 25, minMarginPct: 5 },
      [{ id: 'lot_1', businessId: 'biz_1', productId: 'p1', costPerBox: '100.00', remainingBoxes: 10, status: 'ACTIVE' }],
    );
    const result = await pricingService.getProductPricing('biz_1', 'p1');
    expect(result.recommendedPrice).toBe('125.00'); // 100 * 1.25, not 1.15
  });

  it('uses the product\u2019s own minMarginPct via the real margin formula, not a hardcoded 5% markup-shaped calc', async () => {
    await build(
      { id: 'p1', businessId: 'biz_1', name: 'Apple', defaultMarkupPct: 15, minMarginPct: 20 },
      [{ id: 'lot_1', businessId: 'biz_1', productId: 'p1', costPerBox: '100.00', remainingBoxes: 10, status: 'ACTIVE' }],
    );
    const result = await pricingService.getProductPricing('biz_1', 'p1');
    expect(result.minimumPrice).toBe('125.00'); // 100 / (1 - 0.20) = 125, NOT 100*1.20=120
  });

  it('markup and margin are not confused: cost 100, markup 20% -> price 120, margin 16.67%', async () => {
    await build(
      { id: 'p1', businessId: 'biz_1', name: 'Apple', defaultMarkupPct: 20, minMarginPct: 0 },
      [{ id: 'lot_1', businessId: 'biz_1', productId: 'p1', costPerBox: '100.00', remainingBoxes: 10, status: 'ACTIVE' }],
    );
    const result = await pricingService.getProductPricing('biz_1', 'p1');
    expect(result.recommendedPrice).toBe('120.00');
    expect(result.marginPct).toBeCloseTo(16.67, 1);
  });

  it('averages cost across multiple lots weighted by remaining boxes (real landed cost, not selling price)', async () => {
    await build(
      { id: 'p1', businessId: 'biz_1', name: 'Apple', defaultMarkupPct: 10, minMarginPct: 5 },
      [
        { id: 'lot_1', businessId: 'biz_1', productId: 'p1', costPerBox: '100.00', remainingBoxes: 10, status: 'ACTIVE' },
        { id: 'lot_2', businessId: 'biz_1', productId: 'p1', costPerBox: '200.00', remainingBoxes: 10, status: 'ACTIVE' },
      ],
    );
    const result = await pricingService.getProductPricing('biz_1', 'p1');
    expect(result.avgCost).toBe('150.00'); // (100*10 + 200*10) / 20
  });

  it('surfaces market rate as context without using it as cost', async () => {
    await build(
      { id: 'p1', businessId: 'biz_1', name: 'Apple', defaultMarkupPct: 10, minMarginPct: 5 },
      [{ id: 'lot_1', businessId: 'biz_1', productId: 'p1', costPerBox: '100.00', remainingBoxes: 10, status: 'ACTIVE' }],
      [{ id: 'ref_1', businessId: 'biz_1', productId: 'p1', marketPrice: '150.00', source: 'MANUAL', createdAt: new Date() }],
    );
    const result = await pricingService.getProductPricing('biz_1', 'p1');
    expect(result.marketPrice).toBe('150.00');
    expect(result.avgCost).toBe('100.00'); // cost basis unaffected by market rate
  });

  it('missing market data does not break pricing \u2014 marketPrice is null, not a fabricated fallback', async () => {
    await build(
      { id: 'p1', businessId: 'biz_1', name: 'Apple', defaultMarkupPct: 10, minMarginPct: 5 },
      [{ id: 'lot_1', businessId: 'biz_1', productId: 'p1', costPerBox: '100.00', remainingBoxes: 10, status: 'ACTIVE' }],
    );
    const result = await pricingService.getProductPricing('biz_1', 'p1');
    expect(result.marketPrice).toBeNull();
    expect(result.recommendedPrice).toBe('110.00');
  });

  it('business isolation: a product from another business is not found', async () => {
    await build(
      { id: 'p1', businessId: 'biz_2', name: 'Apple', defaultMarkupPct: 10, minMarginPct: 5 },
      [],
    );
    await expect(pricingService.getProductPricing('biz_1', 'p1')).rejects.toThrow('Product not found');
  });
});

describe('PricingService.getLotRecommendedPrice \u2014 freshness integration', () => {
  let pricingService: PricingService;
  let fakePrisma: FakePrismaService;

  async function build(product: any, lot: any) {
    fakePrisma = new FakePrismaService({
      product: [product],
      lot: [{ ...lot, product }],
    });
    const moduleRef = await Test.createTestingModule({
      providers: [PricingService, FreshnessService, { provide: PrismaService, useValue: fakePrisma }],
    }).compile();
    pricingService = moduleRef.get(PricingService);
  }

  it('never recommends below the configured minimum, even when freshness pushes the price down hard', async () => {
    await build(
      { id: 'p1', businessId: 'biz_1', name: 'Apple', defaultMarkupPct: 15, minMarginPct: 5, freshnessProfiles: [] },
      { id: 'lot_1', businessId: 'biz_1', productId: 'p1', costPerBox: '100.00', remainingBoxes: 5, receivedDate: new Date(Date.now() - 30 * 86400000) },
    );
    const result = await pricingService.getLotRecommendedPrice('biz_1', 'lot_1');
    // minimum = 100 / 0.95 = 105.26 regardless of how aggressive freshness gets
    expect(Number(result.recommended)).toBeGreaterThanOrEqual(105.26);
    expect(Number(result.clearance)).toBeGreaterThanOrEqual(105.26);
  });
});

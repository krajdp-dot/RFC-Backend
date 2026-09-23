import { Test } from '@nestjs/testing';
import { ReportsService } from './reports.service.js';
import { FreshnessService } from '../freshness/freshness.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';

describe('ReportsService.getFreshness', () => {
  async function build(seed: Partial<Record<string, any[]>>) {
    const fakePrisma = new FakePrismaService(seed);
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReportsService, FreshnessService,
        { provide: PrismaService, useValue: fakePrisma },
      ],
    }).compile();
    return moduleRef.get(ReportsService);
  }

  function daysAgo(n: number) {
    return new Date(Date.now() - n * 86400000);
  }

  it('returns the shape the frontend actually consumes: summary + items, not atRiskValue/data', async () => {
    const service = await build({
      product: [{ id: 'p1', businessId: 'biz_1', name: 'Banana' }],
      lot: [{ id: 'l1', businessId: 'biz_1', productId: 'p1', status: 'ACTIVE', remainingBoxes: 10, costPerBox: '300', receivedDate: new Date() }],
    });
    const result: any = await service.getFreshness('biz_1', {} as any);
    expect(result).toHaveProperty('summary');
    expect(result).toHaveProperty('items');
    expect(result).not.toHaveProperty('atRiskValue');
    expect(result).not.toHaveProperty('data');
  });

  it('a lot with no freshness profile (default score 100) counts as fresh stock, not an item needing attention', async () => {
    const service = await build({
      product: [{ id: 'p1', businessId: 'biz_1', name: 'Banana' }],
      lot: [{ id: 'l1', businessId: 'biz_1', productId: 'p1', status: 'ACTIVE', remainingBoxes: 10, costPerBox: '300', receivedDate: new Date() }],
    });
    const result: any = await service.getFreshness('biz_1', {} as any);
    expect(result.summary.freshStockValue).toBe('3000.00');
    expect(result.items).toHaveLength(0);
  });

  it('an aged lot past its freshness profile is bucketed and reported with a real risk value', async () => {
    const service = await build({
      product: [{ id: 'p1', businessId: 'biz_1', name: 'Banana' }],
      freshnessProfile: [
        { id: 'fp1', productId: 'p1', dayOffset: 5, qualityPct: '40', status: 'URGENT', priceMultiplier: '0.4' },
      ],
      lot: [{ id: 'l1', businessId: 'biz_1', productId: 'p1', status: 'ACTIVE', remainingBoxes: 10, costPerBox: '300', receivedDate: daysAgo(5) }],
    });
    const result: any = await service.getFreshness('biz_1', {} as any);
    // value = 10*300 = 3000; score 40 -> highRisk bucket; riskValue = 3000*(1-0.4) = 1800
    expect(result.summary.highRiskValue).toBe('3000.00');
    expect(result.summary.erosionValue).toBe('1800.00');
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ productName: 'Banana', quantity: 10, qualityPct: 40, riskValue: '1800.00' });
  });

  it('depleted stock (remainingBoxes 0) is excluded from both value and items', async () => {
    const service = await build({
      product: [{ id: 'p1', businessId: 'biz_1', name: 'Banana' }],
      lot: [{ id: 'l1', businessId: 'biz_1', productId: 'p1', status: 'DEPLETED', remainingBoxes: 0, costPerBox: '300', receivedDate: daysAgo(30) }],
    });
    const result: any = await service.getFreshness('biz_1', {} as any);
    expect(result.summary.totalValue).toBe('0.00');
    expect(result.items).toHaveLength(0);
  });
});

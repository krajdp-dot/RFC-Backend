import { CustomersService } from './customers.service.js';
import { FakePrismaService } from '../../test-utils/fake-prisma.util.js';
import { getBusinessDate } from '../../common/utils/date.util.js';

const TODAY = getBusinessDate();

describe('CustomersService.getCustomerSummary', () => {
  function build(seed: Partial<Record<string, any[]>>) {
    const fakePrisma = new FakePrismaService(seed);
    return { service: new CustomersService(fakePrisma as any), fakePrisma };
  }

  it('outstanding reflects unpaid credit sales, not the configured credit limit', async () => {
    // A customer with a large limit who has fully paid off every sale
    // should show zero outstanding, not their limit.
    const { service } = build({
      customer: [{ id: 'c1', businessId: 'biz_1', name: 'Rajesh Traders', creditLimit: '50000' }],
      sale: [
        { id: 's1', businessId: 'biz_1', customerId: 'c1', total: '10000', creditAmount: '0', status: 'COMPLETED' },
      ],
    });
    const summary = await service.getCustomerSummary('biz_1', 'c1');
    expect(summary.outstanding).toBe('0.00');
  });

  it('outstanding sums real unpaid credit, independent of credit limit', async () => {
    const { service } = build({
      customer: [{ id: 'c1', businessId: 'biz_1', name: 'Rajesh Traders', creditLimit: '5000' }],
      sale: [
        { id: 's1', businessId: 'biz_1', customerId: 'c1', total: '20000', creditAmount: '12000', status: 'COMPLETED' },
      ],
    });
    const summary = await service.getCustomerSummary('biz_1', 'c1');
    // Real outstanding (12000) can legitimately exceed the configured limit
    // (5000) — the two are different concepts and this must not clamp.
    expect(summary.outstanding).toBe('12000.00');
  });

  it('totalCollected counts customer payments, not a refund paid back to them', async () => {
    const { service } = build({
      customer: [{ id: 'c1', businessId: 'biz_1', name: 'Rajesh Traders', creditLimit: '0' }],
      sale: [
        { id: 's1', businessId: 'biz_1', customerId: 'c1', total: '10000', creditAmount: '0', status: 'COMPLETED' },
      ],
      payment: [
        { id: 'p1', businessId: 'biz_1', customerId: 'c1', transactionType: 'CUSTOMER_PAYMENT', amount: '10000', status: 'COMPLETED', businessDate: TODAY },
        { id: 'p2', businessId: 'biz_1', customerId: 'c1', transactionType: 'REFUND', amount: '2000', status: 'COMPLETED', businessDate: TODAY },
      ],
    });
    const summary = await service.getCustomerSummary('biz_1', 'c1');
    expect(summary.totalCollected).toBe('10000.00');
  });

  it('business isolation: another business\u2019s sales never count toward this customer\u2019s outstanding', async () => {
    const { service } = build({
      customer: [{ id: 'c1', businessId: 'biz_A', name: 'A Co', creditLimit: '0' }],
      sale: [
        { id: 's1', businessId: 'biz_A', customerId: 'c1', total: '1000', creditAmount: '1000', status: 'COMPLETED' },
        { id: 's2', businessId: 'biz_B', customerId: 'c1', total: '999999', creditAmount: '999999', status: 'COMPLETED' },
      ],
    });
    const summary = await service.getCustomerSummary('biz_A', 'c1');
    expect(summary.outstanding).toBe('1000.00');
  });
});

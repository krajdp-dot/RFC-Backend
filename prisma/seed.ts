import { PrismaClient } from '@prisma/client';
import { UnitType, QualityGrade, FreshnessStatus, AccountType } from '../src/common/enums';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding Rajdeep Fruits OS database...\n');

  // 1. Create default admin user
  const passwordHash = await bcrypt.hash('admin123', 10);
  const user = await prisma.user.upsert({
    where: { email: 'admin@rajdeepfruits.com' },
    update: {},
    create: {
      email: 'admin@rajdeepfruits.com',
      passwordHash,
      name: 'Rajdeep Admin',
      phone: '+919876543210',
    },
  });
  console.log('✅ Admin user created:', user.email);

  // 2. Create business
  const business = await prisma.business.create({
    data: {
      name: 'Rajdeep Fruits Company',
      legalName: 'Rajdeep Fruits Private Limited',
      timezone: 'Asia/Kolkata',
      currency: 'INR',
      address: 'Market Yard, Sector 12',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411028',
      phone: '+919876543210',
      email: 'info@rajdeepfruits.com',
    },
  });
  console.log('✅ Business created:', business.name);

  // 3. Link user to business
  await prisma.userBusiness.create({
    data: {
      userId: user.id,
      businessId: business.id,
      role: 'OWNER',
    },
  });
  console.log('✅ User linked to business as OWNER');

  // 4. Create accounts
  const accounts = [
    { name: 'Cash Galla', type: AccountType.CASH, openingBalance: 50000 },
    { name: 'SBI', type: AccountType.BANK, openingBalance: 200000 },
    { name: 'PNB', type: AccountType.BANK, openingBalance: 100000 },
    { name: 'UPI PhonePe', type: AccountType.DIGITAL, openingBalance: 0 },
  ];

  for (const acc of accounts) {
    await prisma.account.create({
      data: {
        businessId: business.id,
        name: acc.name,
        type: acc.type,
        openingBalance: acc.openingBalance,
      },
    });
  }
  console.log('✅ Accounts created:', accounts.map((a) => a.name).join(', '));

  // 5. Create expense categories
  const categories = [
    'Transport', 'Labour', 'Loading', 'Unloading', 'Rent', 'Electricity',
    'Fuel', 'Packaging', 'Phone', 'Repairs', 'Commission', 'Market Charges',
    'Bank Charges', 'Wastage', 'Other',
  ];

  for (const name of categories) {
    await prisma.expenseCategory.create({
      data: { businessId: business.id, name },
    });
  }
  console.log('✅ Expense categories created:', categories.length);

  // 6. Create products with freshness profiles
  const products = [
    {
      name: 'Apple',
      variety: 'Royal',
      grade: 'A',
      category: 'Apple',
      primaryUnit: UnitType.BOX,
      defaultBoxWeightKg: 10.5,
      weightRangeMinKg: 9.5,
      weightRangeMaxKg: 11.5,
      shelfLifeDays: 7,
      defaultMarkupPct: 15,
      minMarginPct: 5,
      reorderThreshold: 50,
      reorderQty: 100,
      storageNotes: 'Store in cold storage 2-4°C',
      freshnessProfile: [
        { dayOffset: 0, qualityPct: 100, status: FreshnessStatus.FRESH, priceMultiplier: 1.0 },
        { dayOffset: 1, qualityPct: 95, status: FreshnessStatus.FRESH, priceMultiplier: 1.0 },
        { dayOffset: 2, qualityPct: 88, status: FreshnessStatus.GOOD_FRESH, priceMultiplier: 0.95 },
        { dayOffset: 3, qualityPct: 78, status: FreshnessStatus.WATCH, priceMultiplier: 0.88 },
        { dayOffset: 4, qualityPct: 65, status: FreshnessStatus.MARKDOWN, priceMultiplier: 0.75 },
        { dayOffset: 5, qualityPct: 50, status: FreshnessStatus.URGENT, priceMultiplier: 0.60 },
        { dayOffset: 6, qualityPct: 35, status: FreshnessStatus.LIKELY_LOSS, priceMultiplier: 0.40 },
        { dayOffset: 7, qualityPct: 20, status: FreshnessStatus.LIKELY_LOSS, priceMultiplier: 0.20 },
      ],
    },
    {
      name: 'Mango',
      variety: 'Alphonso',
      grade: 'Premium',
      category: 'Mango',
      primaryUnit: UnitType.BOX,
      defaultBoxWeightKg: 4.0,
      weightRangeMinKg: 3.5,
      weightRangeMaxKg: 4.5,
      shelfLifeDays: 4,
      defaultMarkupPct: 20,
      minMarginPct: 8,
      reorderThreshold: 30,
      reorderQty: 50,
      storageNotes: 'Keep at room temperature, avoid cold storage',
      freshnessProfile: [
        { dayOffset: 0, qualityPct: 100, status: FreshnessStatus.FRESH, priceMultiplier: 1.0 },
        { dayOffset: 1, qualityPct: 90, status: FreshnessStatus.GOOD_FRESH, priceMultiplier: 0.95 },
        { dayOffset: 2, qualityPct: 72, status: FreshnessStatus.WATCH, priceMultiplier: 0.82 },
        { dayOffset: 3, qualityPct: 50, status: FreshnessStatus.MARKDOWN, priceMultiplier: 0.65 },
        { dayOffset: 4, qualityPct: 30, status: FreshnessStatus.LIKELY_LOSS, priceMultiplier: 0.35 },
      ],
    },
    {
      name: 'Orange',
      variety: 'Nagpur',
      grade: 'A',
      category: 'Citrus',
      primaryUnit: UnitType.BOX,
      defaultBoxWeightKg: 15.0,
      weightRangeMinKg: 14.0,
      weightRangeMaxKg: 16.0,
      shelfLifeDays: 10,
      defaultMarkupPct: 12,
      minMarginPct: 5,
      reorderThreshold: 40,
      reorderQty: 80,
      storageNotes: 'Cool dry storage',
      freshnessProfile: [
        { dayOffset: 0, qualityPct: 100, status: FreshnessStatus.FRESH, priceMultiplier: 1.0 },
        { dayOffset: 2, qualityPct: 95, status: FreshnessStatus.FRESH, priceMultiplier: 1.0 },
        { dayOffset: 4, qualityPct: 88, status: FreshnessStatus.GOOD_FRESH, priceMultiplier: 0.95 },
        { dayOffset: 6, qualityPct: 75, status: FreshnessStatus.WATCH, priceMultiplier: 0.85 },
        { dayOffset: 8, qualityPct: 55, status: FreshnessStatus.MARKDOWN, priceMultiplier: 0.70 },
        { dayOffset: 10, qualityPct: 35, status: FreshnessStatus.LIKELY_LOSS, priceMultiplier: 0.40 },
      ],
    },
    {
      name: 'Banana',
      variety: 'Robusta',
      grade: 'Standard',
      category: 'Banana',
      primaryUnit: UnitType.BOX,
      defaultBoxWeightKg: 12.0,
      weightRangeMinKg: 11.0,
      weightRangeMaxKg: 13.0,
      shelfLifeDays: 5,
      defaultMarkupPct: 10,
      minMarginPct: 4,
      reorderThreshold: 60,
      reorderQty: 120,
      storageNotes: 'Room temperature, avoid refrigeration',
      freshnessProfile: [
        { dayOffset: 0, qualityPct: 100, status: FreshnessStatus.FRESH, priceMultiplier: 1.0 },
        { dayOffset: 1, qualityPct: 92, status: FreshnessStatus.FRESH, priceMultiplier: 1.0 },
        { dayOffset: 2, qualityPct: 80, status: FreshnessStatus.GOOD_FRESH, priceMultiplier: 0.92 },
        { dayOffset: 3, qualityPct: 60, status: FreshnessStatus.WATCH, priceMultiplier: 0.78 },
        { dayOffset: 4, qualityPct: 40, status: FreshnessStatus.MARKDOWN, priceMultiplier: 0.55 },
        { dayOffset: 5, qualityPct: 20, status: FreshnessStatus.LIKELY_LOSS, priceMultiplier: 0.30 },
      ],
    },
    {
      name: 'Pomegranate',
      variety: 'Bhagwa',
      grade: 'A',
      category: 'Pomegranate',
      primaryUnit: UnitType.BOX,
      defaultBoxWeightKg: 5.0,
      weightRangeMinKg: 4.5,
      weightRangeMaxKg: 5.5,
      shelfLifeDays: 14,
      defaultMarkupPct: 18,
      minMarginPct: 7,
      reorderThreshold: 20,
      reorderQty: 50,
      storageNotes: 'Cold storage 5-8°C, handles longer',
      freshnessProfile: [
        { dayOffset: 0, qualityPct: 100, status: FreshnessStatus.FRESH, priceMultiplier: 1.0 },
        { dayOffset: 3, qualityPct: 95, status: FreshnessStatus.FRESH, priceMultiplier: 1.0 },
        { dayOffset: 7, qualityPct: 85, status: FreshnessStatus.GOOD_FRESH, priceMultiplier: 0.95 },
        { dayOffset: 10, qualityPct: 70, status: FreshnessStatus.WATCH, priceMultiplier: 0.82 },
        { dayOffset: 12, qualityPct: 50, status: FreshnessStatus.MARKDOWN, priceMultiplier: 0.65 },
        { dayOffset: 14, qualityPct: 30, status: FreshnessStatus.LIKELY_LOSS, priceMultiplier: 0.35 },
      ],
    },
  ];

  for (const productData of products) {
    const { freshnessProfile, ...productFields } = productData;
    const product = await prisma.product.create({
      data: {
        businessId: business.id,
        ...productFields,
      },
    });

    for (const fp of freshnessProfile) {
      await prisma.freshnessProfile.create({
        data: {
          productId: product.id,
          ...fp,
        },
      });
    }
  }
  console.log('✅ Products created:', products.length, 'with freshness profiles');

  // 7. Create sample customers
  const customers = [
    { name: 'Metro Fruits Mart', phone: '+919111222333', businessName: 'Metro Fruits', creditLimit: 100000, creditTermsDays: 7 },
    { name: 'Sharma Traders', phone: '+919222333444', businessName: 'Sharma Trading Co.', creditLimit: 50000, creditTermsDays: 7 },
    { name: 'Fresh Corner', phone: '+919333444555', businessName: 'Fresh Corner Retail', creditLimit: 30000, creditTermsDays: 3 },
    { name: 'Aman Fruits', phone: '+919444555666', businessName: 'Aman Fruit Centre', creditLimit: 75000, creditTermsDays: 15 },
    { name: 'Deshmukh Retail', phone: '+919555666777', businessName: 'Deshmukh & Sons', creditLimit: 40000, creditTermsDays: 7 },
  ];

  for (const c of customers) {
    await prisma.customer.create({
      data: { businessId: business.id, ...c },
    });
  }
  console.log('✅ Customers created:', customers.length);

  // 8. Create sample suppliers
  const suppliers = [
    { name: 'Merchant A — Apple Supplier', phone: '+919666777888', businessName: 'Kashmir Apple Traders', paymentTermsDays: 7 },
    { name: 'Merchant B — Mango Supplier', phone: '+919777888999', businessName: 'Ratnagiri Mango Farm', paymentTermsDays: 3 },
    { name: 'Merchant C — Mixed Fruits', phone: '+919888999000', businessName: 'Nashik Fresh Fruits', paymentTermsDays: 14 },
  ];

  for (const s of suppliers) {
    await prisma.supplier.create({
      data: { businessId: business.id, ...s },
    });
  }
  console.log('✅ Suppliers created:', suppliers.length);

  console.log('\n🍎 Rajdeep Fruits OS seeded successfully!');
  console.log('   Login: admin@rajdeepfruits.com / admin123\n');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

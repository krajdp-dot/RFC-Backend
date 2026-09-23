export enum UserRole {
  OWNER = "OWNER",
  MANAGER = "MANAGER",
  STAFF = "STAFF"
}

export enum UnitType {
  BOX = "BOX",
  KG = "KG",
  PIECE = "PIECE",
  CRATE = "CRATE",
  BAG = "BAG",
  OTHER = "OTHER"
}

export enum QualityGrade {
  EXCELLENT = "EXCELLENT",
  GOOD = "GOOD",
  FAIR = "FAIR",
  POOR = "POOR"
}

export enum FreshnessStatus {
  FRESH = "FRESH",
  GOOD_FRESH = "GOOD_FRESH",
  WATCH = "WATCH",
  MARKDOWN = "MARKDOWN",
  URGENT = "URGENT",
  LIKELY_LOSS = "LIKELY_LOSS"
}

export enum LotStatus {
  ACTIVE = "ACTIVE",
  DEPLETED = "DEPLETED",
  WASTED = "WASTED",
  RETURNED = "RETURNED"
}

export enum TransactionStatus {
  PENDING = "PENDING",
  COMPLETED = "COMPLETED",
  FAILED = "FAILED",
  REVERSED = "REVERSED",
  VOID = "VOID"
}

export enum PaymentMethod {
  CASH = "CASH",
  BANK_TRANSFER = "BANK_TRANSFER",
  UPI = "UPI",
  CHEQUE = "CHEQUE",
  CREDIT = "CREDIT"
}

export enum PaymentTransactionType {
  CUSTOMER_PAYMENT = "CUSTOMER_PAYMENT",
  SUPPLIER_PAYMENT = "SUPPLIER_PAYMENT",
  EXPENSE = "EXPENSE",
  OWNER_WITHDRAWAL = "OWNER_WITHDRAWAL",
  OWNER_CONTRIBUTION = "OWNER_CONTRIBUTION",
  REFUND = "REFUND",
  ADJUSTMENT = "ADJUSTMENT"
}

export enum UpiSettlementStatus {
  PENDING = "PENDING",
  SETTLED = "SETTLED",
  FAILED = "FAILED"
}

export enum InventoryMovementType {
  PURCHASE = "PURCHASE",
  SALE = "SALE",
  RETURN_TO_SUPPLIER = "RETURN_TO_SUPPLIER",
  RETURN_FROM_CUSTOMER = "RETURN_FROM_CUSTOMER",
  WASTAGE = "WASTAGE",
  ADJUSTMENT = "ADJUSTMENT"
}

export enum AccountType {
  CASH = "CASH",
  BANK = "BANK",
  DIGITAL = "DIGITAL",
  CUSTOMER_RECEIVABLE = "CUSTOMER_RECEIVABLE",
  SUPPLIER_PAYABLE = "SUPPLIER_PAYABLE",
  REVENUE = "REVENUE",
  EXPENSE = "EXPENSE",
  EQUITY = "EQUITY"
}

export enum AuditAction {
  CREATE = "CREATE",
  UPDATE = "UPDATE",
  DELETE = "DELETE",
  REVERSE = "REVERSE"
}

export enum PriceSource {
  MANUAL = "MANUAL",
  MARKET_AVG = "MARKET_AVG",
  SYSTEM_COMPUTED = "SYSTEM_COMPUTED"
}

export enum BoxStatus {
  IN_STOCK = "IN_STOCK",
  SOLD = "SOLD",
  WASTED = "WASTED",
  RETURNED = "RETURNED"
}

export enum MovementType {
  IN = "IN",
  OUT = "OUT"
}

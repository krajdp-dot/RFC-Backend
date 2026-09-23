-- Phase 12 — WhatsApp communication layer.
--
-- All new: four tables, plus four nullable/defaulted columns on
-- "customers". Nothing existing is altered or renamed, so this is safe
-- to run against a database with live data — every new customer column
-- is nullable or has a safe default (whatsappOptIn defaults false: never
-- assume consent, section 8).
--
-- Written idempotently (IF NOT EXISTS), matching the Phase 10 migration
-- in this same directory — see README.md here for how to apply it.

ALTER TABLE "customers"
  ADD COLUMN IF NOT EXISTS "whatsappNumber" TEXT,
  ADD COLUMN IF NOT EXISTS "whatsappOptIn" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "whatsappOptInAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "whatsappOptOutAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "whatsapp_messages" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "customerId"        TEXT,
  "userId"            TEXT,
  "provider"          TEXT NOT NULL,
  "providerMessageId" TEXT,
  "messageType"       TEXT NOT NULL,
  "templateName"      TEXT,
  "templateVariables" JSONB,
  "recipient"         TEXT NOT NULL,
  "contentSnapshot"   TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'QUEUED',
  "idempotencyKey"    TEXT NOT NULL,
  "relatedEntityType" TEXT,
  "relatedEntityId"   TEXT,
  "attemptCount"      INTEGER NOT NULL DEFAULT 0,
  "failureCode"       TEXT,
  "failureReason"     TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt"            TIMESTAMP(3),
  "deliveredAt"       TIMESTAMP(3),
  "readAt"            TIMESTAMP(3),
  "failedAt"          TIMESTAMP(3),
  CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_messages_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id"),
  CONSTRAINT "whatsapp_messages_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_messages_businessId_idempotencyKey_key"
  ON "whatsapp_messages" ("businessId", "idempotencyKey");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_businessId_status_idx" ON "whatsapp_messages" ("businessId", "status");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_businessId_customerId_idx" ON "whatsapp_messages" ("businessId", "customerId");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_businessId_relatedEntityType_relatedEntityId_idx"
  ON "whatsapp_messages" ("businessId", "relatedEntityType", "relatedEntityId");
CREATE INDEX IF NOT EXISTS "whatsapp_messages_providerMessageId_idx" ON "whatsapp_messages" ("providerMessageId");

CREATE TABLE IF NOT EXISTS "whatsapp_incoming_messages" (
  "id"                TEXT NOT NULL,
  "businessId"        TEXT NOT NULL,
  "customerId"        TEXT,
  "fromNumber"        TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "content"           TEXT NOT NULL,
  "receivedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_incoming_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_incoming_messages_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id"),
  CONSTRAINT "whatsapp_incoming_messages_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "customers"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_incoming_messages_providerMessageId_key"
  ON "whatsapp_incoming_messages" ("providerMessageId");
CREATE INDEX IF NOT EXISTS "whatsapp_incoming_messages_businessId_customerId_idx"
  ON "whatsapp_incoming_messages" ("businessId", "customerId");
CREATE INDEX IF NOT EXISTS "whatsapp_incoming_messages_businessId_receivedAt_idx"
  ON "whatsapp_incoming_messages" ("businessId", "receivedAt");

CREATE TABLE IF NOT EXISTS "whatsapp_webhook_events" (
  "id"              TEXT NOT NULL,
  "providerEventId" TEXT NOT NULL,
  "eventType"       TEXT NOT NULL,
  "processedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "whatsapp_webhook_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_webhook_events_providerEventId_key"
  ON "whatsapp_webhook_events" ("providerEventId");

CREATE TABLE IF NOT EXISTS "whatsapp_automation_settings" (
  "id"                          TEXT NOT NULL,
  "businessId"                  TEXT NOT NULL,
  "saleConfirmationEnabled"     BOOLEAN NOT NULL DEFAULT false,
  "paymentReceiptEnabled"       BOOLEAN NOT NULL DEFAULT false,
  "outstandingReminderEnabled"  BOOLEAN NOT NULL DEFAULT false,
  "updatedAt"                   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedBy"                   TEXT,
  CONSTRAINT "whatsapp_automation_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "whatsapp_automation_settings_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_automation_settings_businessId_key"
  ON "whatsapp_automation_settings" ("businessId");

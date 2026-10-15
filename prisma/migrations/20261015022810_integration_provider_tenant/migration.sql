-- Records which Microsoft tenant issued a connection, for the multi-tenant
-- authority. Nullable: existing connections were made under a pinned tenant,
-- where the configured value is the answer and there is nothing to record.
ALTER TABLE "Integration" ADD COLUMN "providerTenantId" TEXT;

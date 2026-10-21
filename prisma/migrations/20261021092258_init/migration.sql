-- CreateEnum
CREATE TYPE "EntryType" AS ENUM ('CREDIT_SALE', 'PAYMENT');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "shopName" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Entry" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "type" "EntryType" NOT NULL,
    "amountPaise" INTEGER NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_apiKeyHash_key" ON "Merchant"("apiKeyHash");

-- CreateIndex
CREATE INDEX "Customer_merchantId_name_idx" ON "Customer"("merchantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_merchantId_phone_key" ON "Customer"("merchantId", "phone");

-- CreateIndex
CREATE INDEX "Entry_customerId_createdAt_idx" ON "Entry"("customerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Entry_merchantId_idempotencyKey_key" ON "Entry"("merchantId", "idempotencyKey");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entry" ADD CONSTRAINT "Entry_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Entry" ADD CONSTRAINT "Entry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp, hashKey } from "../src/app.ts";
import { makePrisma } from "../src/db.ts";
import { TEST_DB } from "./global-setup.ts";

const db = makePrisma(TEST_DB);
const app = buildApp(db);

async function newMerchant(shopName = "Sharma Hardware") {
  const key = randomBytes(24).toString("hex");
  await db.merchant.create({ data: { shopName, apiKeyHash: hashKey(key) } });
  return { "x-api-key": key };
}

const call = (method: "GET" | "POST", url: string, headers: Record<string, string>, payload?: object) =>
  app.inject({ method, url, headers, payload });

async function newCustomer(h: Record<string, string>, name = "Ramesh", phone = "98765 43210") {
  return (await call("POST", "/customers", h, { name, phone })).json();
}

const entry = (h: Record<string, string>, id: string, type: string, amountPaise: number, key = randomUUID()) =>
  call("POST", `/customers/${id}/entries`, { ...h, "idempotency-key": key }, { type, amountPaise });

beforeEach(async () => {
  await db.$executeRawUnsafe(`TRUNCATE "Entry", "Customer", "Merchant" CASCADE`);
});
afterAll(async () => {
  await app.close();
  await db.$disconnect();
});

describe("udhaar-api", () => {
  it("rejects requests without a valid api key", async () => {
    expect((await call("GET", "/customers", {})).statusCode).toBe(401);
    expect((await call("GET", "/customers", { "x-api-key": "x".repeat(48) })).statusCode).toBe(401);
  });

  it("normalises phone numbers and blocks duplicates per shop", async () => {
    const h = await newMerchant();
    const c = await newCustomer(h, "Ramesh", "+91 98765-43210");
    expect(c.phone).toBe("+919876543210");
    const dup = await call("POST", "/customers", h, { name: "Ramesh again", phone: "09876543210" });
    expect(dup.statusCode).toBe(409);
    const bad = await call("POST", "/customers", h, { name: "X", phone: "12345" });
    expect(bad.statusCode).toBe(400);
  });

  it("tracks outstanding across credit sales and payments", async () => {
    const h = await newMerchant();
    const c = await newCustomer(h);
    expect((await entry(h, c.id, "CREDIT_SALE", 120_000)).json().outstandingPaise).toBe(120_000); // cement bags
    expect((await entry(h, c.id, "PAYMENT", 50_000)).json().outstandingPaise).toBe(70_000);
    const detail = (await call("GET", `/customers/${c.id}`, h)).json();
    expect(detail.outstandingPaise).toBe(70_000);
    expect(detail.entries).toHaveLength(2);
  });

  it("refuses a payment larger than what is owed", async () => {
    const h = await newMerchant();
    const c = await newCustomer(h);
    await entry(h, c.id, "CREDIT_SALE", 10_000);
    const r = await entry(h, c.id, "PAYMENT", 10_001);
    expect(r.statusCode).toBe(422);
  });

  it("is idempotent: a retried request records once", async () => {
    const h = await newMerchant();
    const c = await newCustomer(h);
    const key = randomUUID();
    const a = await entry(h, c.id, "CREDIT_SALE", 5_000, key);
    const b = await entry(h, c.id, "CREDIT_SALE", 5_000, key);
    expect([a.statusCode, b.statusCode]).toEqual([201, 200]);
    expect(b.json().entry.id).toBe(a.json().entry.id);
    expect((await call("GET", `/customers/${c.id}`, h)).json().outstandingPaise).toBe(5_000);
    expect((await entry(h, c.id, "CREDIT_SALE", 6_000, key)).statusCode).toBe(409);
  });

  it("keeps shops isolated from each other", async () => {
    const shopA = await newMerchant("A");
    const shopB = await newMerchant("B");
    const c = await newCustomer(shopA);
    await entry(shopA, c.id, "CREDIT_SALE", 9_000);
    expect((await call("GET", `/customers/${c.id}`, shopB)).statusCode).toBe(404);
    expect((await entry(shopB, c.id, "PAYMENT", 1_000)).statusCode).toBe(404);
    expect((await call("GET", "/customers", shopB)).json()).toEqual([]);
    expect((await call("GET", "/reports/outstanding", shopB)).json().totalOutstandingPaise).toBe(0);
    // same phone number is fine in a different shop
    expect((await call("POST", "/customers", shopB, { name: "Ramesh", phone: "9876543210" })).statusCode).toBe(201);
  });

  it("reports the biggest debtors", async () => {
    const h = await newMerchant();
    const a = await newCustomer(h, "Anil", "9000000001");
    const b = await newCustomer(h, "Bina", "9000000002");
    const z = await newCustomer(h, "Zero", "9000000003");
    await entry(h, a.id, "CREDIT_SALE", 30_000);
    await entry(h, b.id, "CREDIT_SALE", 80_000);
    await entry(h, b.id, "PAYMENT", 10_000);
    await entry(h, z.id, "CREDIT_SALE", 5_000);
    await entry(h, z.id, "PAYMENT", 5_000);
    const r = (await call("GET", "/reports/outstanding", h)).json();
    expect(r.totalOutstandingPaise).toBe(100_000);
    expect(r.customersOwing).toBe(2);
    expect(r.top.map((t: { name: string }) => t.name)).toEqual(["Bina", "Anil"]);
  });

  it("builds a WhatsApp reminder only when money is owed", async () => {
    const h = await newMerchant("Sharma Hardware");
    const c = await newCustomer(h, "Ramesh", "9876543210");
    expect((await call("GET", `/customers/${c.id}/reminder`, h)).statusCode).toBe(422);
    await entry(h, c.id, "CREDIT_SALE", 123_450);
    const r = (await call("GET", `/customers/${c.id}/reminder`, h)).json();
    expect(r.text).toContain("Rs 1,234.5");
    expect(r.whatsappUrl.startsWith("https://wa.me/919876543210?text=")).toBe(true);
  });

  it("validates input", async () => {
    const h = await newMerchant();
    const c = await newCustomer(h);
    expect((await entry(h, c.id, "CREDIT_SALE", -5)).statusCode).toBe(400);
    expect((await entry(h, c.id, "GIFT", 5)).statusCode).toBe(400);
    expect((await call("POST", `/customers/${c.id}/entries`, h, { type: "PAYMENT", amountPaise: 5 })).statusCode).toBe(400); // no key
  });

  it("never lets concurrent payments exceed what is owed", async () => {
    const h = await newMerchant();
    const c = await newCustomer(h);
    await entry(h, c.id, "CREDIT_SALE", 500);
    const results = await Promise.all(Array.from({ length: 12 }, () => entry(h, c.id, "PAYMENT", 100)));
    const codes = results.map((r) => r.statusCode);
    expect(codes.filter((s) => s === 201)).toHaveLength(5);
    expect(codes.filter((s) => s === 422)).toHaveLength(7);
    expect((await call("GET", `/customers/${c.id}`, h)).json().outstandingPaise).toBe(0);
  });

  it("collapses concurrent retries with one key into a single entry", async () => {
    const h = await newMerchant();
    const c = await newCustomer(h);
    const key = randomUUID();
    const results = await Promise.all(Array.from({ length: 8 }, () => entry(h, c.id, "CREDIT_SALE", 2_500, key)));
    expect(new Set(results.map((r) => r.json().entry.id)).size).toBe(1);
    expect((await call("GET", `/customers/${c.id}`, h)).json().outstandingPaise).toBe(2_500);
  });
});

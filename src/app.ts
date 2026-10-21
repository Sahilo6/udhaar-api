import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import type { DB } from "./db.ts";
import { HttpError, addEntry, outstanding, reminderText } from "./ledger.ts";
import { CustomerIn, EntryIn, IdParam, IdempotencyKey, ListQuery } from "./schemas.ts";

export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");

export function buildApp(db: DB) {
  const app = Fastify({ logger: false });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.status(400).send({ error: "invalid request", issues: err.issues });
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode === 400) return reply.status(400).send({ error: e.message });
    app.log.error(err);
    return reply.status(500).send({ error: "internal error" });
  });

  /** Every route is tenant-scoped: the API key identifies the merchant, and queries filter by it. */
  async function merchant(req: FastifyRequest) {
    const key = req.headers["x-api-key"];
    if (typeof key !== "string" || key.length < 16) throw new HttpError(401, "valid x-api-key required");
    const m = await db.merchant.findUnique({ where: { apiKeyHash: hashKey(key) } });
    if (!m || !timingSafeEqual(Buffer.from(m.apiKeyHash), Buffer.from(hashKey(key)))) {
      throw new HttpError(401, "valid x-api-key required");
    }
    return m;
  }

  async function ownedCustomer(merchantId: string, id: string) {
    const c = await db.customer.findFirst({ where: { id, merchantId } });
    if (!c) throw new HttpError(404, "customer not found"); // same answer whether it doesn't exist or isn't yours
    return c;
  }

  app.get("/health", async () => ({ ok: true }));

  app.post("/customers", async (req, reply) => {
    const m = await merchant(req);
    const body = CustomerIn.parse(req.body);
    const clash = await db.customer.findUnique({ where: { merchantId_phone: { merchantId: m.id, phone: body.phone } } });
    if (clash) throw new HttpError(409, `a customer with phone ${body.phone} already exists`);
    const c = await db.customer.create({ data: { ...body, merchantId: m.id } });
    return reply.status(201).send({ ...c, outstandingPaise: 0 });
  });

  app.get("/customers", async (req) => {
    const m = await merchant(req);
    const q = ListQuery.parse(req.query);
    const customers = await db.customer.findMany({
      where: { merchantId: m.id, ...(q.search ? { name: { contains: q.search, mode: "insensitive" } } : {}) },
      orderBy: { name: "asc" },
      take: q.limit,
    });
    return Promise.all(customers.map(async (c) => ({ ...c, outstandingPaise: await outstanding(db, c.id) })));
  });

  app.get("/customers/:id", async (req) => {
    const m = await merchant(req);
    const c = await ownedCustomer(m.id, IdParam.parse(req.params).id);
    const entries = await db.entry.findMany({ where: { customerId: c.id }, orderBy: { createdAt: "desc" }, take: 20 });
    return { ...c, outstandingPaise: await outstanding(db, c.id), entries };
  });

  app.post("/customers/:id/entries", async (req, reply) => {
    const m = await merchant(req);
    const { id } = IdParam.parse(req.params);
    const key = IdempotencyKey.parse(req.headers["idempotency-key"]);
    const res = await addEntry(db, m.id, id, EntryIn.parse(req.body), key);
    return reply.status(res.replayed ? 200 : 201).send(res);
  });

  app.get("/customers/:id/reminder", async (req) => {
    const m = await merchant(req);
    const c = await ownedCustomer(m.id, IdParam.parse(req.params).id);
    const owed = await outstanding(db, c.id);
    if (owed <= 0) throw new HttpError(422, "nothing outstanding");
    const text = reminderText(m.shopName, c.name, owed);
    return { text, whatsappUrl: `https://wa.me/${c.phone.replace("+", "")}?text=${encodeURIComponent(text)}` };
  });

  app.get("/reports/outstanding", async (req) => {
    const m = await merchant(req);
    const sums = await db.entry.groupBy({ by: ["customerId", "type"], where: { merchantId: m.id }, _sum: { amountPaise: true } });
    const owed = new Map<string, number>();
    for (const s of sums) {
      const v = s._sum.amountPaise ?? 0;
      owed.set(s.customerId, (owed.get(s.customerId) ?? 0) + (s.type === "CREDIT_SALE" ? v : -v));
    }
    const debtors = [...owed].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    const names = new Map((await db.customer.findMany({ where: { id: { in: debtors.slice(0, 10).map(([id]) => id) } } }))
      .map((c) => [c.id, c.name]));
    return {
      totalOutstandingPaise: debtors.reduce((t, [, v]) => t + v, 0),
      customersOwing: debtors.length,
      top: debtors.slice(0, 10).map(([id, v]) => ({ customerId: id, name: names.get(id), outstandingPaise: v })),
    };
  });

  return app;
}

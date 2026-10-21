import type { DB } from "./db.ts";
import { Prisma } from "./generated/prisma/client.ts";

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Outstanding = credit sales minus payments, in paise. */
export async function outstanding(db: DB | Prisma.TransactionClient, customerId: string): Promise<number> {
  const rows = await db.entry.groupBy({ by: ["type"], where: { customerId }, _sum: { amountPaise: true } });
  const sum = (t: string) => rows.find((r) => r.type === t)?._sum.amountPaise ?? 0;
  return sum("CREDIT_SALE") - sum("PAYMENT");
}

type EntryInput = { type: "CREDIT_SALE" | "PAYMENT"; amountPaise: number; note: string };

/**
 * Record a credit sale or a payment. Scoped to the merchant, idempotent on the merchant's key,
 * and safe under concurrent requests: the customer row is locked while the outstanding is checked,
 * so two payments can't both pass the "not more than outstanding" check.
 */
export async function addEntry(db: DB, merchantId: string, customerId: string, input: EntryInput, key: string) {
  const replay = await db.entry.findUnique({ where: { merchantId_idempotencyKey: { merchantId, idempotencyKey: key } } });
  if (replay) return checkReplay(replay, customerId, input);

  try {
    return await db.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Customer" WHERE id = ${customerId} AND "merchantId" = ${merchantId} FOR UPDATE`;
      if (locked.length === 0) throw new HttpError(404, "customer not found");
      const owed = await outstanding(tx, customerId);
      if (input.type === "PAYMENT" && input.amountPaise > owed) {
        throw new HttpError(422, `payment exceeds outstanding (${owed} paise)`);
      }
      const entry = await tx.entry.create({
        data: { merchantId, customerId, type: input.type, amountPaise: input.amountPaise, note: input.note, idempotencyKey: key },
      });
      const after = owed + (input.type === "CREDIT_SALE" ? input.amountPaise : -input.amountPaise);
      return { entry, outstandingPaise: after, replayed: false };
    });
  } catch (e) {
    // A concurrent retry with the same key won the race; the unique index caught this one.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const prior = await db.entry.findUniqueOrThrow({ where: { merchantId_idempotencyKey: { merchantId, idempotencyKey: key } } });
      return checkReplay(prior, customerId, input);
    }
    throw e;
  }
}

async function checkReplay(prior: { customerId: string; type: string; amountPaise: number }, customerId: string, input: EntryInput) {
  if (prior.customerId !== customerId || prior.type !== input.type || prior.amountPaise !== input.amountPaise) {
    throw new HttpError(409, "Idempotency-Key already used for a different entry");
  }
  return { entry: prior, outstandingPaise: null, replayed: true };
}

export function reminderText(shopName: string, customerName: string, owedPaise: number) {
  const rupees = (owedPaise / 100).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return `Namaste ${customerName}, a friendly reminder from ${shopName}: Rs ${rupees} is pending on your account. Thank you!`;
}

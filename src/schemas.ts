import { z } from "zod";

/** Indian mobile numbers, normalised to +91XXXXXXXXXX so "98xxx", "+91 98xxx" and "098xxx" are one customer. */
export const phone = z
  .string()
  .transform((s) => s.replace(/[\s-]/g, ""))
  .transform((s) => s.replace(/^(\+91|91|0)(?=\d{10}$)/, ""))
  .pipe(z.string().regex(/^[6-9]\d{9}$/, "must be a 10-digit Indian mobile number"))
  .transform((s) => `+91${s}`);

export const CustomerIn = z.object({
  name: z.string().trim().min(1).max(80),
  phone,
});

export const EntryIn = z.object({
  type: z.enum(["CREDIT_SALE", "PAYMENT"]),
  amountPaise: z.number().int().positive().max(100_000_000), // up to INR 10 lakh per entry
  note: z.string().trim().max(200).default(""),
});

export const IdempotencyKey = z.string().min(8).max(64);

export const IdParam = z.object({ id: z.string().min(1).max(40) });

export const ListQuery = z.object({
  search: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

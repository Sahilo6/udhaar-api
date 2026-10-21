import "dotenv/config";
import { randomBytes } from "node:crypto";
import { buildApp, hashKey } from "./app.ts";
import { makePrisma } from "./db.ts";

const db = makePrisma();

// `npm start -- --create-merchant "Sharma Hardware"` prints a new API key once (only its hash is stored).
const i = process.argv.indexOf("--create-merchant");
if (i !== -1) {
  const key = randomBytes(24).toString("hex");
  const m = await db.merchant.create({ data: { shopName: process.argv[i + 1] ?? "My shop", apiKeyHash: hashKey(key) } });
  console.log(`merchant ${m.id} (${m.shopName})\nx-api-key: ${key}`);
  await db.$disconnect();
} else {
  const app = buildApp(db);
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: "0.0.0.0" });
  console.log(`udhaar-api on :${process.env.PORT ?? 3000}`);
}

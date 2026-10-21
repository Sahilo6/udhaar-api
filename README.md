# udhaar-api

A backend for a shop's credit book ("udhaar khata"): customers take goods on credit, pay back over time, and
the shop sees who owes what and can send a WhatsApp reminder. Built with Node.js, TypeScript, Fastify, Zod,
Prisma and PostgreSQL, tested with Vitest against a real Postgres.

Built as a focused example of the work in Credsetu's Full Stack Development internship: their app, Patrata,
helps hardware, cement and building-material merchants keep records of credit sales, payments and
outstanding balances, on a Node.js + TypeScript + Fastify + Zod + Prisma + PostgreSQL + Vitest stack.

## API

All routes need `x-api-key`; the key identifies the shop, and every query is scoped to that shop.

| Method | Path | Notes |
|---|---|---|
| POST | `/customers` | `{name, phone}`; phone normalised to `+91XXXXXXXXXX`; unique per shop |
| GET | `/customers?search=&limit=` | with each customer's outstanding |
| GET | `/customers/:id` | outstanding + last 20 entries |
| POST | `/customers/:id/entries` | `{type: CREDIT_SALE \| PAYMENT, amountPaise, note}` + `idempotency-key` header. 201 new, 200 replay, 409 key reused for something else, 422 payment above what's owed |
| GET | `/customers/:id/reminder` | reminder text + a `wa.me` link (nothing is sent automatically) |
| GET | `/reports/outstanding` | total owed, number of customers owing, top 10 debtors |

## Things done carefully

- **Money in integer paise**, never floats. The database also refuses non-positive amounts (`CHECK` in its own migration).
- **Concurrency.** Recording an entry locks the customer row (`SELECT ... FOR UPDATE` inside a Prisma
  interactive transaction) before checking the outstanding, so two payments arriving together can't both pass
  the "not more than owed" check.
- **Idempotency.** `(merchantId, idempotencyKey)` is unique. A retry on a flaky shop connection returns the
  first result instead of recording the sale twice; concurrent retries collapse to one entry.
- **Tenant isolation.** A shop gets a 404 for another shop's customer, whether or not it exists. The same phone
  number can be a customer at two different shops.
- **Validation at the edge** with Zod (phone format, amount limits, enum types); errors come back as 400s with the
  issues listed. API keys are stored as SHA-256 hashes only.

## Tests

```bash
docker run -d --name udhaar-pg -p 5433:5432 -e POSTGRES_USER=udhaar -e POSTGRES_PASSWORD=udhaar-dev-only \
  -e POSTGRES_DB=udhaar postgres:16-alpine
docker exec udhaar-pg psql -U udhaar -d udhaar -c "CREATE DATABASE udhaar_test"
cp .env.example .env && npm install
npm test            # 11 passed (migrations are applied to udhaar_test first)
npm run typecheck
```

The concurrency test fires 12 simultaneous INR 1 payments at a customer who owes INR 5. With the row lock,
exactly 5 succeed and the outstanding ends at 0. With `FOR UPDATE` removed, 10 of them succeeded (the shop
would show a customer who "overpaid"), so the test is checked against the bug it guards.

## Run it

```bash
npx prisma migrate deploy
npm start -- --create-merchant "Sharma Hardware"     # prints an x-api-key once
npm start                                            # http://localhost:3000
```

## Not included

- The React Native app. This is the API it would talk to.
- Sending reminders: the API builds the message and link; the shopkeeper taps send.
- Prisma 7 generates the client into `src/generated/prisma` (git-ignored; `npm install` regenerates it).

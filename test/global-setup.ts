import { execSync } from "node:child_process";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgresql://udhaar:udhaar-dev-only@127.0.0.1:5433/udhaar_test";

export default function setup() {
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: TEST_DB }, stdio: "pipe" });
}

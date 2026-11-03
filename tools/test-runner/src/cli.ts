import { spawn } from "node:child_process";
import { startTempPostgres, type TempPostgres } from "./temp-postgres.ts";

const PATTERNS = [
  "tools/**/test/*.test.ts",
  "packages/**/test/*.test.ts",
  "services/**/test/*.test.ts",
];

let temp: TempPostgres | undefined;
const env = { ...process.env };

if (!env.TEST_DATABASE_ADMIN_URL) {
  console.log("Pas de TEST_DATABASE_ADMIN_URL : démarrage d'un PostgreSQL temporaire…");
  temp = await startTempPostgres();
  env.TEST_DATABASE_ADMIN_URL = temp.adminUrl;
}

const cleanup = () => {
  temp?.stop();
  temp = undefined;
};
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(143);
});

const extra = process.argv.slice(2);
const child = spawn(process.execPath, ["--test", ...extra, ...(extra.length ? [] : PATTERNS)], {
  stdio: "inherit",
  env,
});
const code: number = await new Promise((resolve) => child.on("close", (c) => resolve(c ?? 1)));
cleanup();
process.exit(code);

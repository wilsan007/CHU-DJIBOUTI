import { execFileSync, spawnSync } from "node:child_process";
import { chownSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempPostgres {
  adminUrl: string;
  stop: () => void;
}

/** Dossier des binaires PostgreSQL : variable PG_BIN, sinon /usr/lib/postgresql/<version>/bin. */
function findBinDir(): string {
  const fromEnv = process.env.PG_BIN;
  if (fromEnv && existsSync(join(fromEnv, "initdb"))) return fromEnv;
  const root = "/usr/lib/postgresql";
  if (existsSync(root)) {
    const versions = readdirSync(root)
      .filter((v) => existsSync(join(root, v, "bin", "initdb")))
      .sort((a, b) => Number(b) - Number(a));
    if (versions[0]) return join(root, versions[0], "bin");
  }
  throw new Error(
    "PostgreSQL introuvable. Installez-le, indiquez PG_BIN, ou fournissez TEST_DATABASE_ADMIN_URL.",
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/**
 * Démarre un PostgreSQL jetable (sans sauvegarde sur disque, très rapide) pour les tests.
 * PostgreSQL refuse de tourner sous le compte root : dans ce cas on passe par le compte `postgres`.
 */
export async function startTempPostgres(): Promise<TempPostgres> {
  const bin = findBinDir();
  const asRoot = typeof process.getuid === "function" && process.getuid() === 0;
  const root = mkdtempSync(join(tmpdir(), "chu-pg-"));
  const data = join(root, "data");
  const sock = join(root, "sock");
  mkdirSync(sock);
  let wrap: (cmd: string, args: string[]) => [string, string[]] = (cmd, args) => [cmd, args];
  if (asRoot) {
    const uid = Number(execFileSync("id", ["-u", "postgres"], { encoding: "utf8" }).trim());
    const gid = Number(execFileSync("id", ["-g", "postgres"], { encoding: "utf8" }).trim());
    chownSync(root, uid, gid);
    chownSync(sock, uid, gid);
    wrap = (cmd, args) => ["runuser", ["-u", "postgres", "--", cmd, ...args]];
  }
  const run = (cmd: string, args: string[]) => {
    const [c, a] = wrap(cmd, args);
    return spawnSync(c, a, { encoding: "utf8" });
  };

  let init = run(join(bin, "initdb"), [
    "-D",
    data,
    "-U",
    "postgres",
    "--auth=trust",
    "-E",
    "UTF8",
    "--locale=C.UTF-8",
  ]);
  if (init.status !== 0) {
    rmSync(data, { recursive: true, force: true });
    init = run(join(bin, "initdb"), [
      "-D",
      data,
      "-U",
      "postgres",
      "--auth=trust",
      "-E",
      "UTF8",
      "--locale=en_US.UTF-8",
    ]);
  }
  if (init.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`initdb a échoué : ${init.stderr}`);
  }
  const port = await freePort();
  const options = [
    `-p ${port}`,
    `-k ${sock}`,
    "-c listen_addresses=127.0.0.1",
    "-c fsync=off",
    "-c synchronous_commit=off",
    "-c full_page_writes=off",
    "-c max_connections=200",
  ].join(" ");
  const start = run(join(bin, "pg_ctl"), [
    "-D",
    data,
    "-l",
    join(root, "log"),
    "-w",
    "-o",
    options,
    "start",
  ]);
  if (start.status !== 0) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`Démarrage de PostgreSQL impossible : ${start.stderr || start.stdout}`);
  }
  return {
    adminUrl: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: () => {
      run(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "-w", "stop"]);
      rmSync(root, { recursive: true, force: true });
    },
  };
}

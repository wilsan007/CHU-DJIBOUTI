import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from "node:fs";
import { join } from "node:path";
import { toText, type InternalMessage } from "./astm.ts";

export interface TokenSource {
  token(forceRefresh?: boolean): Promise<string>;
}

/** Jeton du compte de service du pont (client_credentials), gardé jusqu'à une minute avant son expiration. */
export function clientCredentials(o: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}): TokenSource {
  let cached: { value: string; until: number } | undefined;
  return {
    async token(force = false) {
      if (!force && cached && cached.until > Date.now()) return cached.value;
      const res = await fetch(o.tokenUrl, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: o.clientId,
          client_secret: o.clientSecret,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`jeton refusé (${res.status})`);
      const j = (await res.json()) as { access_token: string; expires_in: number };
      cached = { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 };
      return j.access_token;
    },
  };
}

export interface ForwarderOptions {
  spoolDir: string;
  apiUrl: string;
  tokens: TokenSource;
  log?: (event: Record<string, unknown>) => void;
  retryMs?: number;
}

interface Spooled {
  id: string;
  receivedAt: string;
  message: InternalMessage;
}

/**
 * File d'attente durable : un résultat est écrit sur disque (et synchronisé) AVANT d'être acquitté à l'automate, puis
 * envoyé à l'API. Si l'API ou le réseau tombe, rien n'est perdu et l'ordre est conservé. Les refus définitifs de l'API
 * (échantillon inconnu, message illisible, mauvais analyseur) vont dans `rejected/` pour être traités par une personne.
 */
export function createForwarder(o: ForwarderOptions) {
  const pending = join(o.spoolDir, "pending");
  const rejected = join(o.spoolDir, "rejected");
  const done = join(o.spoolDir, "done");
  for (const d of [pending, rejected, done]) mkdirSync(d, { recursive: true });
  const log = o.log ?? (() => {});
  let flushing: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let seq = 0;

  const files = (): string[] =>
    readdirSync(pending)
      .filter((f) => f.endsWith(".json"))
      .sort();

  async function sendOne(file: string): Promise<"sent" | "retry"> {
    const item = JSON.parse(readFileSync(join(pending, file), "utf8")) as Spooled;
    const url = `${o.apiUrl}/api/lab/analyzers/${encodeURIComponent(item.message.analyzer)}/messages`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${await o.tokens.token(attempt > 0)}`,
          },
          body: JSON.stringify({ message: toText(item.message) }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        log({ event: "api_unreachable", error: String(error) });
        return "retry";
      }
      if (res.status === 401 && attempt === 0) continue; // jeton expiré : un nouveau, une seule fois
      const body = (await res.json().catch(() => ({}))) as {
        accepted?: unknown[];
        rejected?: { code: string; reason: string }[];
        error?: { code?: string; message?: string };
      };
      if (res.ok) {
        const refused = body.rejected ?? [];
        writeFileSync(join(done, file), JSON.stringify({ ...item, response: body }, null, 1));
        unlinkSync(join(pending, file));
        log({
          event: "delivered",
          id: item.id,
          accepted: body.accepted?.length ?? 0,
          rejected: refused.length,
          skipped: item.message.skipped,
        });
        // Des résultats refusés (code non relié, échantillon non reçu…) ne doivent pas se perdre en silence.
        if (refused.length) {
          writeFileSync(
            join(rejected, `partial-${file}`),
            JSON.stringify({ ...item, response: body }, null, 1),
          );
          log({ event: "partially_rejected", id: item.id, rejected: refused });
        }
        return "sent";
      }
      if (res.status >= 500 || res.status === 401 || res.status === 403 || res.status === 429) {
        log({ event: "api_error", status: res.status });
        return "retry";
      }
      renameSync(join(pending, file), join(rejected, file));
      writeFileSync(join(rejected, `${file}.reason`), JSON.stringify(body));
      log({ event: "rejected", id: item.id, status: res.status, code: body.error?.code });
      return "sent";
    }
    return "retry";
  }

  async function runFlush(): Promise<void> {
    for (const file of files()) {
      if ((await sendOne(file)) === "retry") {
        schedule();
        return;
      }
    }
  }
  function schedule(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, o.retryMs ?? 10_000);
    timer.unref();
  }
  function flush(): Promise<void> {
    flushing ??= runFlush().finally(() => {
      flushing = undefined;
    });
    return flushing;
  }

  return {
    /** Écrit sur disque, synchronise, puis lance l'envoi. Retourne dès que le message est en sécurité. */
    submit(message: InternalMessage): string {
      const id = randomUUID();
      seq += 1;
      const file = `${Date.now().toString().padStart(14, "0")}-${String(seq).padStart(6, "0")}-${id}.json`;
      const path = join(pending, file);
      const fd = openSync(path, "w");
      try {
        writeFileSync(
          fd,
          JSON.stringify({ id, receivedAt: new Date().toISOString(), message } satisfies Spooled),
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      void flush();
      return id;
    },
    flush,
    pendingCount: (): number => files().length,
    rejectedCount: (): number =>
      readdirSync(rejected).filter((f) => f.endsWith(".json") && !f.startsWith("partial-")).length,
    /** Remet en file les messages refusés (après correction : analyse reliée, échantillon reçu…). */
    requeueRejected(): number {
      let n = 0;
      for (const f of readdirSync(rejected).filter(
        (x) => x.endsWith(".json") && !x.startsWith("partial-"),
      )) {
        renameSync(join(rejected, f), join(pending, f));
        try {
          unlinkSync(join(rejected, `${f}.reason`));
        } catch {
          // pas de fichier de motif
        }
        n += 1;
      }
      if (n) void flush();
      return n;
    },
    stop(): void {
      if (timer) clearTimeout(timer);
    },
  };
}

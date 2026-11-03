import { parseEvent, type DomainEvent, type EventType } from "@chu/events";
import type { RequestContext } from "../audit/audit.ts";
import type { Db, Tx } from "../db.ts";

/**
 * Distributeur d'événements (plan, étapes 6.3 à 6.5).
 *
 * - Chaque consommateur a son curseur : un consommateur lent ou en panne ne bloque pas les autres.
 * - L'effet du consommateur, la marque « déjà traité » et l'avancement du curseur sont validés dans
 *   la même transaction : un événement n'a jamais un effet à moitié.
 * - Idempotence : un événement déjà traité par un consommateur n'est jamais rejoué, même si le
 *   curseur est remis à zéro.
 * - En cas d'échec : nouvel essai avec des délais croissants ; après `maxAttempts`, l'événement est
 *   abandonné (file des échecs) et signalé, et les suivants continuent.
 */

export interface Consumer {
  name: string;
  types: readonly EventType[];
  handle: (event: DomainEvent, tx: Tx, ctx: RequestContext) => Promise<void>;
}

export interface DeadLetterInfo {
  consumer: string;
  eventId: string;
  attempts: number;
  error: string;
}

export interface DispatcherOptions {
  db: Db;
  consumers: readonly Consumer[];
  maxAttempts?: number;
  baseDelayMs?: number;
  now?: () => Date;
  onDead?: (info: DeadLetterInfo) => void;
  onError?: (consumer: string, error: unknown) => void;
}

interface OutboxRow {
  id: string;
  event_id: string;
  type: string;
  version: number;
  occurred_at: Date;
  patient_id: string | null;
  actor: unknown;
  payload: unknown;
}

type StepResult = "processed" | "skipped" | "idle" | "blocked";

/** Contexte d'une action automatique : l'identifiant de l'événement sert de numéro de corrélation. */
export function systemContext(consumer: string, event: DomainEvent): RequestContext {
  return {
    user: { id: `system:${consumer}`, name: `système (${consumer})`, roles: [] },
    requestId: event.eventId,
  };
}

function toEvent(row: OutboxRow): DomainEvent {
  return parseEvent({
    eventId: row.event_id,
    type: row.type,
    version: row.version,
    occurredAt: row.occurred_at.toISOString(),
    patientId: row.patient_id,
    actor: row.actor,
    payload: row.payload,
  });
}

export class Dispatcher {
  private readonly db: Db;
  private readonly consumers: readonly Consumer[];
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly now: () => Date;
  private readonly onDead: (info: DeadLetterInfo) => void;
  private readonly onError: (consumer: string, error: unknown) => void;
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(options: DispatcherOptions) {
    this.db = options.db;
    this.consumers = options.consumers;
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseDelayMs = options.baseDelayMs ?? 1000;
    this.now = options.now ?? (() => new Date());
    this.onDead = options.onDead ?? (() => {});
    this.onError = options.onError ?? (() => {});
    const names = new Set<string>();
    for (const c of options.consumers) {
      if (names.has(c.name)) throw new Error(`Consommateur en double : ${c.name}`);
      names.add(c.name);
    }
  }

  /** Traite au plus un événement pour un consommateur. */
  private async step(consumer: Consumer): Promise<StepResult> {
    const tx = await this.db.connect();
    try {
      await tx.query("begin");
      // Un seul exemplaire du distributeur travaille sur un consommateur à la fois.
      const lock = await tx.query<{ ok: boolean }>(
        "select pg_try_advisory_xact_lock(hashtext($1)) as ok",
        [`events:${consumer.name}`],
      );
      if (!lock.rows[0]?.ok) {
        await tx.query("rollback");
        return "blocked";
      }
      await tx.query(
        "insert into events.consumer_cursor (consumer, last_id) values ($1, 0) on conflict do nothing",
        [consumer.name],
      );
      const cursor = await tx.query<{ last_id: string }>(
        "select last_id from events.consumer_cursor where consumer = $1",
        [consumer.name],
      );
      const lastId = cursor.rows[0]?.last_id ?? "0";
      const next = await tx.query<OutboxRow>(
        `select id, event_id, type, version, occurred_at, patient_id, actor, payload
           from events.outbox where id > $1 order by id limit 1`,
        [lastId],
      );
      const row = next.rows[0];
      if (!row) {
        await tx.query("rollback");
        return "idle";
      }
      const advance = () =>
        tx.query(
          "update events.consumer_cursor set last_id = $2, updated_at = now() where consumer = $1",
          [consumer.name, row.id],
        );

      if (!(consumer.types as readonly string[]).includes(row.type)) {
        await advance();
        await tx.query("commit");
        return "skipped";
      }

      const failure = await tx.query<{ attempts: number; dead: boolean; next_attempt_at: Date }>(
        "select attempts, dead, next_attempt_at from events.failures where consumer = $1 and event_id = $2",
        [consumer.name, row.event_id],
      );
      const failed = failure.rows[0];
      if (failed?.dead) {
        await advance();
        await tx.query("commit");
        return "skipped";
      }
      if (failed && failed.next_attempt_at > this.now()) {
        await tx.query("rollback");
        return "blocked"; // on attend l'heure du prochain essai ; l'ordre est conservé
      }

      await tx.query("savepoint handling");
      try {
        const marked = await tx.query(
          "insert into events.processed (consumer, event_id) values ($1, $2) on conflict do nothing",
          [consumer.name, row.event_id],
        );
        if (marked.rowCount) {
          const event = toEvent(row);
          await consumer.handle(event, tx, systemContext(consumer.name, event));
        }
        await tx.query("delete from events.failures where consumer = $1 and event_id = $2", [
          consumer.name,
          row.event_id,
        ]);
        await advance();
        await tx.query("commit");
        return "processed";
      } catch (error) {
        await tx.query("rollback to savepoint handling");
        const attempts = (failed?.attempts ?? 0) + 1;
        const dead = attempts >= this.maxAttempts;
        const message = error instanceof Error ? error.message : String(error);
        const delay = this.baseDelayMs * 2 ** (attempts - 1);
        await tx.query(
          `insert into events.failures (consumer, event_id, attempts, last_error, next_attempt_at, dead)
           values ($1, $2, $3, $4, $5, $6)
           on conflict (consumer, event_id) do update
             set attempts = excluded.attempts, last_error = excluded.last_error,
                 next_attempt_at = excluded.next_attempt_at, dead = excluded.dead, updated_at = now()`,
          [
            consumer.name,
            row.event_id,
            attempts,
            message,
            new Date(this.now().getTime() + delay),
            dead,
          ],
        );
        if (dead) await advance(); // l'événement abandonné ne bloque plus les suivants
        await tx.query("commit");
        this.onError(consumer.name, error);
        if (dead)
          this.onDead({ consumer: consumer.name, eventId: row.event_id, attempts, error: message });
        return dead ? "skipped" : "blocked";
      }
    } catch (error) {
      try {
        await tx.query("rollback");
      } catch {
        // connexion perdue
      }
      throw error;
    } finally {
      tx.release();
    }
  }

  /** Traite tout ce qui est disponible pour un consommateur ; renvoie le nombre d'événements traités. */
  private async runConsumer(consumer: Consumer): Promise<number> {
    let processed = 0;
    for (;;) {
      const result = await this.step(consumer);
      if (result === "processed") processed += 1;
      else if (result !== "skipped") return processed;
    }
  }

  /** Un passage : chaque consommateur avance de son côté, en parallèle. */
  async runOnce(): Promise<number> {
    const counts = await Promise.all(this.consumers.map((c) => this.runConsumer(c)));
    return counts.reduce((a, b) => a + b, 0);
  }

  /** Répète les passages jusqu'à ce que plus rien ne bouge (utile aux tests et à l'arrêt propre). */
  async drain(): Promise<number> {
    let total = 0;
    for (;;) {
      const n = await this.runOnce();
      if (n === 0) return total;
      total += n;
    }
  }

  start(intervalMs = 500): void {
    if (this.timer) return;
    const tick = async () => {
      if (this.running) return;
      this.running = true;
      try {
        await this.runOnce();
      } catch (error) {
        this.onError("dispatcher", error);
      } finally {
        this.running = false;
      }
    };
    this.timer = setInterval(() => void tick(), intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise((r) => setTimeout(r, 10));
  }
}

/** Événements abandonnés après trop d'essais, à traiter par l'équipe technique (alerte). */
export async function listDeadLetters(db: Db): Promise<DeadLetterInfo[]> {
  const res = await db.query<{
    consumer: string;
    event_id: string;
    attempts: number;
    last_error: string;
  }>(
    "select consumer, event_id, attempts, last_error from events.failures where dead order by updated_at",
  );
  return res.rows.map((r) => ({
    consumer: r.consumer,
    eventId: r.event_id,
    attempts: r.attempts,
    error: r.last_error,
  }));
}

/** Remet un événement abandonné en file pour un nouvel essai, après correction de la cause. */
export async function retryDeadLetter(db: Db, consumer: string, eventId: string): Promise<boolean> {
  const res = await db.query(
    `update events.failures set dead = false, attempts = 0, next_attempt_at = now(), updated_at = now()
      where consumer = $1 and event_id = $2 and dead`,
    [consumer, eventId],
  );
  if (!res.rowCount) return false;
  // Le curseur avait dépassé l'événement : on le ramène juste avant pour qu'il soit relu.
  await db.query(
    `update events.consumer_cursor set last_id = least(last_id, (select id - 1 from events.outbox where event_id = $2))
      where consumer = $1`,
    [consumer, eventId],
  );
  return true;
}

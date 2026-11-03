import { randomUUID } from "node:crypto";
import { parseEvent, type DomainEvent } from "@chu/events";
import type { RequestContext } from "../audit/audit.ts";
import type { Tx } from "../db.ts";

type EventInput = {
  [T in DomainEvent["type"]]: {
    type: T;
    patientId: string | null;
    payload: Extract<DomainEvent, { type: T }>["payload"];
  };
}[DomainEvent["type"]];

/**
 * Ajoute un événement à l'outbox, dans la transaction de la donnée qu'il décrit.
 * Le message est validé contre son schéma avant l'écriture : un contrat violé lève une erreur
 * et annule toute la transaction.
 */
export async function appendEvent(
  tx: Tx,
  ctx: RequestContext,
  input: EventInput,
): Promise<DomainEvent> {
  const event = parseEvent({
    eventId: randomUUID(),
    version: 1,
    occurredAt: new Date().toISOString(),
    patientId: input.patientId,
    actor: {
      userId: ctx.user.id,
      role: ctx.user.roles[0] ?? (ctx.user.id.startsWith("system:") ? "system" : "unknown"),
    },
    type: input.type,
    payload: input.payload,
  });
  await tx.query(
    `insert into events.outbox (event_id, type, version, occurred_at, patient_id, actor, payload)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      event.eventId,
      event.type,
      event.version,
      event.occurredAt,
      event.patientId,
      JSON.stringify(event.actor),
      JSON.stringify(event.payload),
    ],
  );
  return event;
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { parseEvent } from "../src/index.ts";

const base = () => ({
  eventId: randomUUID(),
  version: 1,
  occurredAt: "2026-11-03T09:30:00Z",
  actor: { userId: "u1", role: "reception" },
});

test("un événement PatientCreated valide est accepté", () => {
  const patientId = randomUUID();
  const event = parseEvent({
    ...base(),
    type: "PatientCreated",
    patientId,
    payload: { fhirResource: `Patient/${patientId}`, identifier: "000123", kind: "regular" },
  });
  assert.equal(event.type, "PatientCreated");
});

test("un message qui ne respecte pas le contrat est rejeté", () => {
  const patientId = randomUUID();
  assert.throws(() =>
    parseEvent({ ...base(), type: "PatientCreated", patientId, payload: { identifier: "000123" } }),
  );
  assert.throws(() => parseEvent({ ...base(), type: "Inconnu", patientId, payload: {} }));
  assert.throws(() =>
    parseEvent({
      ...base(),
      version: 0,
      type: "PatientMerged",
      patientId,
      payload: {
        survivorId: patientId,
        mergedId: randomUUID(),
        survivorIdentifier: "000123",
        mergedIdentifier: "000124",
      },
    }),
  );
});

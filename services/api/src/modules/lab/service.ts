import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { parseCsv } from "../../common/csv.ts";
import { nextNumber } from "../../common/numbering.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import { checkDigits, parseCardPayload } from "../identity/card.ts";
import { patientSummaries, relatedPatientIds } from "../identity/interface.ts";
import { completeTicketIn, startTicketIn, ticketContext } from "../orders/service.ts";
import { esc } from "../../common/html.ts";
import { qrSvg } from "../../common/qr.ts";
import { renderReport } from "./report.ts";

export type Flag = "normal" | "low" | "high" | "critical_low" | "critical_high" | "none";

const person = (ctx: RequestContext) => ({ userId: ctx.user.id, name: ctx.user.name });
const has = (ctx: RequestContext, role: string): boolean => ctx.user.roles.some((r) => r === role);
/** Les rôles du laboratoire voient tout ; le médecin ne voit que les résultats validés. */
const seesUnvalidated = (ctx: RequestContext): boolean => has(ctx, "lab") || has(ctx, "biologist");

export const specimenPayload = (number: string): string => `SP1.${number}.${checkDigits(number)}`;
export function parseSpecimenPayload(payload: string): string | null {
  const m = /^SP1\.(S-\d{6,})\.(\d{2})$/.exec(payload.trim());
  return m && m[1] && checkDigits(m[1]) === m[2] ? m[1] : null;
}

/* ------------------------------------------------------------------ catalogue d'analyses */

const TEST_HEADER =
  "code,loinc,act_code,libelle_fr,libelle_ar,echantillon,unite,type_valeur,responsable,date_maj";

export interface LabTestImport {
  applied: boolean;
  total: number;
  imported: number;
  rejected: { line: number; code: string; errors: string[] }[];
}

/** Import du catalogue d'analyses : chaque ligne relie un acte facturable à un code LOINC. */
export async function importTests(
  db: Db,
  ctx: RequestContext,
  csv: string,
): Promise<LabTestImport> {
  const rows = parseCsv(csv);
  const header = (rows.shift() ?? []).map((c) => c.trim()).join(",");
  if (header !== TEST_HEADER)
    throw new DomainError("bad_header", `En-tête attendu : ${TEST_HEADER}`, 400);
  return withTransaction(db, async (tx) => {
    const report: LabTestImport = { applied: true, total: rows.length, imported: 0, rejected: [] };
    const seen = new Set<string>();
    for (const [index, cells] of rows.entries()) {
      const [code, loinc, actCode, fr, ar, specimen, unit, kind, responsible, updatedOn] =
        cells.map((c) => c.trim());
      const errors: string[] = [];
      if (!code) errors.push("code manquant");
      if (code && seen.has(code)) errors.push("code en double dans le fichier");
      if (!loinc || !/^\d{1,7}-\d$/.test(loinc)) errors.push("code LOINC invalide (forme 2345-7)");
      if (!fr || !ar) errors.push("libellés français et arabe obligatoires");
      if (!specimen) errors.push("type d'échantillon manquant");
      if (kind !== "numeric" && kind !== "text") errors.push("type_valeur : numeric ou text");
      if (!responsible) errors.push("responsable manquant");
      if (!updatedOn || !/^\d{4}-\d{2}-\d{2}$/.test(updatedOn))
        errors.push("date de mise à jour invalide");
      const act = actCode
        ? await tx.query("select 1 from catalog.acts where code = $1 and category = 'laboratory'", [
            actCode,
          ])
        : { rowCount: 0 };
      if (!act.rowCount)
        errors.push("acte inconnu ou qui n'est pas une analyse du catalogue des actes");
      if (errors.length) {
        report.rejected.push({ line: index + 2, code: code ?? "", errors });
        continue;
      }
      seen.add(code as string);
      await tx.query(
        `insert into lab.tests (code, loinc, act_code, label_fr, label_ar, specimen_type, unit, value_kind, responsible, updated_on)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (code) do update set loinc = $2, act_code = $3, label_fr = $4, label_ar = $5, specimen_type = $6,
           unit = $7, value_kind = $8, responsible = $9, updated_on = $10, active = true`,
        [code, loinc, actCode, fr, ar, specimen, unit || null, kind, responsible, updatedOn],
      );
      report.imported += 1;
    }
    await writeAudit(tx, ctx, {
      action: "lab.tests.import",
      entityType: "lab_tests",
      detail: { total: report.total, imported: report.imported, rejected: report.rejected.length },
    });
    return report;
  });
}

export async function listTests(db: Db) {
  const res = await db.query<{
    code: string;
    loinc: string;
    act_code: string;
    label_fr: string;
    label_ar: string;
    specimen_type: string;
    unit: string | null;
    value_kind: string;
  }>(
    "select code, loinc, act_code, label_fr, label_ar, specimen_type, unit, value_kind from lab.tests where active order by code",
  );
  return res.rows.map((r) => ({
    code: r.code,
    loinc: r.loinc,
    actCode: r.act_code,
    labelFr: r.label_fr,
    labelAr: r.label_ar,
    specimenType: r.specimen_type,
    unit: r.unit,
    valueKind: r.value_kind,
  }));
}

export interface RangeInput {
  sex: "any" | "male" | "female";
  ageMinDays: number;
  ageMaxDays: number;
  low?: number | undefined;
  high?: number | undefined;
  criticalLow?: number | undefined;
  criticalHigh?: number | undefined;
}

/** Remplace les valeurs de référence d'une analyse. Données du biologiste : son nom et la date sont conservés. */
export async function setRanges(
  db: Db,
  ctx: RequestContext,
  testCode: string,
  input: { ranges: RangeInput[]; validatedBy: string; validatedOn: string },
) {
  return withTransaction(db, async (tx) => {
    const t = await tx.query("select 1 from lab.tests where code = $1", [testCode]);
    if (!t.rowCount) throw notFound("Analyse");
    for (const r of input.ranges) {
      const bounds = [r.criticalLow, r.low, r.high, r.criticalHigh].filter(
        (v) => v !== undefined,
      ) as number[];
      if (bounds.some((v, i) => i > 0 && v < (bounds[i - 1] as number)))
        throw new DomainError(
          "bad_range",
          "Les bornes doivent être croissantes : critique bas, bas, haut, critique haut.",
          400,
        );
    }
    await tx.query("delete from lab.reference_ranges where test_code = $1", [testCode]);
    for (const r of input.ranges) {
      await tx.query(
        `insert into lab.reference_ranges (test_code, sex, age_min_days, age_max_days, low, high, critical_low, critical_high, validated_by, validated_on)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          testCode,
          r.sex,
          r.ageMinDays,
          r.ageMaxDays,
          r.low ?? null,
          r.high ?? null,
          r.criticalLow ?? null,
          r.criticalHigh ?? null,
          input.validatedBy,
          input.validatedOn,
        ],
      );
    }
    await writeAudit(tx, ctx, {
      action: "lab.ranges",
      entityType: "lab_test",
      entityId: testCode,
      detail: { count: input.ranges.length, validatedBy: input.validatedBy },
    });
    return { testCode, ranges: input.ranges.length };
  });
}

interface RangeRow {
  low: string | null;
  high: string | null;
  critical_low: string | null;
  critical_high: string | null;
}

const num = (v: string | null): number | null => (v === null ? null : Number(v));

/** Valeur de référence applicable : la plus précise (sexe donné avant « any »). Aucune plage = pas de drapeau. */
async function applicableRange(
  tx: Tx | Db,
  testCode: string,
  sex: string | null,
  ageDays: number | null,
) {
  const res = await tx.query<RangeRow>(
    `select low, high, critical_low, critical_high from lab.reference_ranges
      where test_code = $1 and (sex = 'any' or sex = $2) and ($3::int is null or ($3 between age_min_days and age_max_days))
      order by (sex = 'any'), (age_max_days - age_min_days) limit 1`,
    [testCode, sex, ageDays],
  );
  return res.rows[0] ?? null;
}

export function flagFor(value: number, r: ReturnType<typeof rangeNumbers> | null): Flag {
  if (!r) return "none";
  if (r.criticalLow !== null && value < r.criticalLow) return "critical_low";
  if (r.criticalHigh !== null && value > r.criticalHigh) return "critical_high";
  if (r.low !== null && value < r.low) return "low";
  if (r.high !== null && value > r.high) return "high";
  return r.low === null && r.high === null ? "none" : "normal";
}
const rangeNumbers = (r: RangeRow) => ({
  low: num(r.low),
  high: num(r.high),
  criticalLow: num(r.critical_low),
  criticalHigh: num(r.critical_high),
});

function ageInDays(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const ms = Date.now() + 3 * 3600_000 - new Date(`${birthDate}T00:00:00Z`).getTime();
  return Math.max(0, Math.floor(ms / 86_400_000));
}

/* ------------------------------------------------------------------ demandes (F7-1) */

/** Appelé par le consommateur du ticket LAB : crée la demande du laboratoire. */
export async function createRequestFromTicket(tx: Tx, ctx: RequestContext, ticketId: string) {
  const c = await ticketContext(tx, ticketId);
  if (c.ticket.departmentCode !== "LAB") return null;
  const dup = await tx.query("select 1 from lab.requests where ticket_id = $1", [ticketId]);
  if (dup.rowCount) return null;
  const number = await nextNumber(tx, "lab", "request", "R");
  const created = await tx.query<{ id: string }>(
    `insert into lab.requests (number, ticket_id, ticket_code, order_id, patient_id, prescriber_id, prescriber_name)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [number, ticketId, c.ticket.code, c.orderId, c.patientId, c.placedBy.id, c.placedBy.name],
  );
  const requestId = (created.rows[0] as { id: string }).id;
  const loinc: string[] = [];
  let count = 0;
  for (const item of c.items) {
    for (let i = 0; i < item.quantity; i += 1) {
      const t = await tx.query<{ code: string; loinc: string }>(
        "select code, loinc from lab.tests where act_code = $1 and active",
        [item.actCode],
      );
      await tx.query(
        "insert into lab.request_tests (request_id, act_code, test_code) values ($1, $2, $3)",
        [requestId, item.actCode, t.rows[0]?.code ?? null],
      );
      if (t.rows[0]) loinc.push(t.rows[0].loinc);
      count += 1;
    }
  }
  await writeAudit(tx, ctx, {
    action: "lab.request.create",
    entityType: "lab_request",
    entityId: requestId,
    patientId: c.patientId,
    detail: { number, ticket: c.ticket.code, tests: count },
  });
  await appendEvent(tx, ctx, {
    type: "LabOrderCreated",
    patientId: c.patientId,
    payload: {
      requestId,
      requestNumber: number,
      orderId: c.orderId,
      ticketCode: c.ticket.code,
      loincCodes: loinc,
      testCount: count,
    },
  });
  return requestId;
}

interface ReqRow {
  id: string;
  number: string;
  ticket_id: string;
  ticket_code: string;
  order_id: string;
  patient_id: string;
  prescriber_id: string;
  prescriber_name: string | null;
  status: string;
  created_at: Date;
}
const REQ_COLS =
  "id, number, ticket_id, ticket_code, order_id, patient_id, prescriber_id, prescriber_name, status, created_at";

async function testsOf(tx: Tx | Db, requestId: string) {
  const res = await tx.query<{
    id: string;
    act_code: string;
    test_code: string | null;
    specimen_id: string | null;
    label_fr: string | null;
    specimen_type: string | null;
    rstatus: string | null;
  }>(
    `select rt.id, rt.act_code, rt.test_code, rt.specimen_id, t.label_fr, t.specimen_type, r.status as rstatus
       from lab.request_tests rt left join lab.tests t on t.code = rt.test_code left join lab.results r on r.request_test_id = rt.id
      where rt.request_id = $1 order by rt.id`,
    [requestId],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    actCode: r.act_code,
    testCode: r.test_code,
    labelFr: r.label_fr,
    specimenType: r.specimen_type,
    specimenId: r.specimen_id,
    resultStatus: r.rstatus,
  }));
}

export async function listRequests(
  db: Db,
  filter: { status?: string | undefined; patientId?: string | undefined },
) {
  const ids = filter.patientId ? await relatedPatientIds(db, filter.patientId) : null;
  const res = await db.query<ReqRow>(
    `select ${REQ_COLS} from lab.requests where ($1::text is null or status = $1) and ($2::uuid[] is null or patient_id = any($2))
      order by created_at, number limit 200`,
    [filter.status ?? null, ids],
  );
  const people = await patientSummaries(
    db,
    res.rows.map((r) => r.patient_id),
  );
  const out = [];
  for (const r of res.rows) {
    out.push({
      id: r.id,
      number: r.number,
      ticketCode: r.ticket_code,
      status: r.status,
      createdAt: r.created_at.toISOString(),
      prescriber: { id: r.prescriber_id, name: r.prescriber_name },
      patient: people.get(r.patient_id) ?? null,
      tests: await testsOf(db, r.id),
    });
  }
  return out;
}

/**
 * Échantillons du laboratoire avec leurs analyses et résultats : la liste de travail du technicien et du biologiste.
 * Filtre `status` : collected (à réceptionner), received (résultats à saisir ou à valider), rejected.
 */
export async function listSpecimens(db: Db, filter: { status?: string | undefined }) {
  const res = await db.query<{
    id: string;
    number: string;
    status: string;
    specimen_type: string;
    collected_at: Date;
    request_id: string;
    request_number: string;
    patient_id: string;
    ticket_code: string;
  }>(
    `select s.id, s.number, s.status, s.specimen_type, s.collected_at, s.request_id, q.number as request_number, q.patient_id, q.ticket_code
       from lab.specimens s join lab.requests q on q.id = s.request_id
      where ($1::text is null or s.status = $1) order by s.collected_at, s.number limit 200`,
    [filter.status ?? null],
  );
  const people = await patientSummaries(
    db,
    res.rows.map((r) => r.patient_id),
  );
  const out = [];
  for (const r of res.rows) {
    const tests = await db.query<{
      test_code: string;
      label_fr: string;
      label_ar: string;
      unit: string | null;
      value_kind: string;
      value_numeric: string | null;
      value_text: string | null;
      flag: Flag | null;
      rstatus: string | null;
    }>(
      `select t.code as test_code, t.label_fr, t.label_ar, t.unit, t.value_kind, r.value_numeric, r.value_text, r.flag, r.status as rstatus
         from lab.request_tests rt join lab.tests t on t.code = rt.test_code left join lab.results r on r.request_test_id = rt.id
        where rt.specimen_id = $1 order by rt.id`,
      [r.id],
    );
    out.push({
      id: r.id,
      number: r.number,
      payload: specimenPayload(r.number),
      status: r.status,
      specimenType: r.specimen_type,
      collectedAt: r.collected_at.toISOString(),
      requestId: r.request_id,
      requestNumber: r.request_number,
      ticketCode: r.ticket_code,
      patient: people.get(r.patient_id) ?? null,
      tests: tests.rows.map((t) => ({
        testCode: t.test_code,
        labelFr: t.label_fr,
        labelAr: t.label_ar,
        unit: t.unit,
        valueKind: t.value_kind,
        value: t.value_numeric !== null ? Number(t.value_numeric) : t.value_text,
        flag: t.flag,
        resultStatus: t.rstatus,
      })),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ prélèvement et étiquettes (F7-2) */

async function patientMatches(tx: Tx, patientId: string, scan: string): Promise<boolean> {
  const identifier = parseCardPayload(scan);
  if (!identifier) return false;
  const family = await relatedPatientIds(tx, patientId);
  const people = await patientSummaries(tx, family);
  return [...people.values()].some((p) => p.identifier === identifier);
}

/**
 * Prélèvement. Le scan de la carte du patient doit correspondre au patient de la demande, sinon le système refuse.
 * La première étape démarre le ticket du laboratoire (trace : qui a commencé).
 */
export async function collectSpecimen(
  db: Db,
  ctx: RequestContext,
  requestId: string,
  input: { patientScan: string; specimenType: string },
) {
  let refusedPatient: string | null = null;
  try {
    return await collectIn(db, ctx, requestId, input, (patientId) => {
      refusedPatient = patientId;
    });
  } catch (error) {
    // Le refus est écrit dans l'audit, hors de la transaction annulée.
    if (error instanceof DomainError && error.code === "identity_mismatch") {
      await withTransaction(db, (tx) =>
        writeAudit(tx, ctx, {
          action: "lab.identity-refused",
          entityType: "lab_request",
          entityId: requestId,
          patientId: refusedPatient,
          detail: { stage: "collection" },
        }),
      );
    }
    throw error;
  }
}

async function collectIn(
  db: Db,
  ctx: RequestContext,
  requestId: string,
  input: { patientScan: string; specimenType: string },
  onRefused: (patientId: string) => void,
) {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<ReqRow>(
      `select ${REQ_COLS} from lab.requests where id = $1 for update`,
      [requestId],
    );
    const req = found.rows[0];
    if (!req) throw notFound("Demande");
    if (req.status === "cancelled")
      throw new DomainError("request_cancelled", "Cette demande est annulée.", 409);
    if (req.status === "completed")
      throw new DomainError("request_completed", "Cette demande est terminée.", 409);
    if (!(await patientMatches(tx, req.patient_id, input.patientScan))) {
      onRefused(req.patient_id);
      throw new DomainError(
        "identity_mismatch",
        "La carte scannée n'est pas celle du patient de cette demande : prélèvement refusé.",
        409,
      );
    }
    const pending = await tx.query<{ id: string; test_code: string }>(
      `select rt.id, rt.test_code from lab.request_tests rt join lab.tests t on t.code = rt.test_code
        where rt.request_id = $1 and rt.specimen_id is null and t.specimen_type = $2 order by rt.id for update of rt`,
      [requestId, input.specimenType],
    );
    if (pending.rows.length === 0)
      throw new DomainError(
        "nothing_to_collect",
        "Aucune analyse en attente pour ce type d'échantillon.",
        409,
      );
    await startTicketIn(tx, ctx, req.ticket_id).catch((e: unknown) => {
      if (!(e instanceof DomainError && e.code === "already_started")) throw e;
    });
    const number = await nextNumber(tx, "lab", "specimen", "S");
    const sp = await tx.query<{ id: string }>(
      `insert into lab.specimens (number, request_id, specimen_type, collected_by, collected_by_name) values ($1, $2, $3, $4, $5) returning id`,
      [number, requestId, input.specimenType, ctx.user.id, ctx.user.name],
    );
    const specimenId = (sp.rows[0] as { id: string }).id;
    await tx.query("update lab.request_tests set specimen_id = $1 where id = any($2::bigint[])", [
      specimenId,
      pending.rows.map((r) => r.id),
    ]);
    await tx.query(
      "update lab.requests set status = 'in_progress' where id = $1 and status = 'pending'",
      [requestId],
    );
    await writeAudit(tx, ctx, {
      action: "lab.collect",
      entityType: "lab_specimen",
      entityId: specimenId,
      patientId: req.patient_id,
      detail: { number, tests: pending.rows.map((r) => r.test_code) },
    });
    return {
      id: specimenId,
      number,
      payload: specimenPayload(number),
      specimenType: input.specimenType,
      tests: pending.rows.map((r) => r.test_code),
    };
  });
}

export async function printLabel(db: Db, ctx: RequestContext, specimenId: string) {
  const res = await db.query<{
    number: string;
    specimen_type: string;
    patient_id: string;
    request_number: string;
  }>(
    `select s.number, s.specimen_type, r.patient_id, r.number as request_number from lab.specimens s join lab.requests r on r.id = s.request_id where s.id = $1`,
    [specimenId],
  );
  const s = res.rows[0];
  if (!s) throw notFound("Échantillon");
  const p = (await patientSummaries(db, [s.patient_id])).get(s.patient_id);
  const payload = specimenPayload(s.number);
  void ctx;
  return {
    number: s.number,
    payload,
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Étiquette ${esc(s.number)}</title><style>@page{size:6cm 4cm;margin:2mm}body{font-family:sans-serif;width:6cm;font-size:10px}</style></head><body>
<strong>${esc(p?.name ?? "—")}</strong><br>${esc(p?.identifier ?? "")} · ${esc(p?.birthDate ?? "")} · ${esc(p?.sex ?? "")}<br>${esc(s.specimen_type)} · ${esc(s.request_number)}<br>
<div data-qr="specimen">${qrSvg(payload, 96)}</div><code>${esc(payload)}</code></body></html>`,
  };
}

/* ------------------------------------------------------------------ réception et rejets (F7-3) */

export async function receiveSpecimen(db: Db, ctx: RequestContext, scan: string) {
  return withTransaction(db, async (tx) => {
    const number = parseSpecimenPayload(scan);
    if (!number)
      throw new DomainError("invalid_scan", "Code d'échantillon illisible ou invalide.", 400);
    const found = await tx.query<{ id: string; status: string; request_id: string }>(
      "select id, status, request_id from lab.specimens where number = $1 for update",
      [number],
    );
    const s = found.rows[0];
    if (!s) throw notFound("Échantillon");
    if (s.status !== "collected")
      throw new DomainError("already_received", "Cet échantillon a déjà été reçu ou rejeté.", 409);
    await tx.query(
      "update lab.specimens set status = 'received', received_by = $2, received_at = now() where id = $1",
      [s.id, ctx.user.id],
    );
    const r = await tx.query<{ patient_id: string }>(
      "select patient_id from lab.requests where id = $1",
      [s.request_id],
    );
    await writeAudit(tx, ctx, {
      action: "lab.receive",
      entityType: "lab_specimen",
      entityId: s.id,
      patientId: r.rows[0]?.patient_id ?? null,
      detail: { number },
    });
    return { id: s.id, number, status: "received" };
  });
}

export async function rejectSpecimen(
  db: Db,
  ctx: RequestContext,
  specimenId: string,
  reason: string,
) {
  return withTransaction(db, async (tx) => {
    const found = await tx.query<{
      id: string;
      number: string;
      status: string;
      request_id: string;
    }>("select id, number, status, request_id from lab.specimens where id = $1 for update", [
      specimenId,
    ]);
    const s = found.rows[0];
    if (!s) throw notFound("Échantillon");
    if (s.status === "rejected")
      throw new DomainError("already_rejected", "Cet échantillon est déjà rejeté.", 409);
    const results = await tx.query("select 1 from lab.results where specimen_id = $1", [s.id]);
    if (results.rowCount)
      throw new DomainError(
        "has_results",
        "Des résultats existent déjà pour cet échantillon.",
        409,
      );
    await tx.query(
      "update lab.specimens set status = 'rejected', rejected_by = $2, rejected_at = now(), rejected_reason = $3 where id = $1",
      [s.id, ctx.user.id, reason],
    );
    // Les analyses redeviennent à prélever.
    await tx.query("update lab.request_tests set specimen_id = null where specimen_id = $1", [
      s.id,
    ]);
    const r = (
      await tx.query<ReqRow>(`select ${REQ_COLS} from lab.requests where id = $1`, [s.request_id])
    ).rows[0] as ReqRow;
    await tx.query(
      `insert into lab.notifications (recipient_id, kind, request_id, patient_id, message) values ($1, 'rejection', $2, $3, $4)`,
      [
        r.prescriber_id,
        r.id,
        r.patient_id,
        `Échantillon ${s.number} rejeté : ${reason}. Un nouveau prélèvement est nécessaire.`,
      ],
    );
    await writeAudit(tx, ctx, {
      action: "lab.reject",
      entityType: "lab_specimen",
      entityId: s.id,
      patientId: r.patient_id,
      detail: { number: s.number, reason },
    });
    await appendEvent(tx, ctx, {
      type: "LabSpecimenRejected",
      patientId: r.patient_id,
      payload: {
        requestId: r.id,
        specimenId: s.id,
        specimenNumber: s.number,
        reason,
        rejectedBy: person(ctx),
        prescriberId: r.prescriber_id,
      },
    });
    return { id: s.id, number: s.number, status: "rejected" };
  });
}

/* ------------------------------------------------------------------ résultats (F7-4, F7-5) */

export interface ResultInput {
  testCode: string;
  value?: number | undefined;
  text?: string | undefined;
}

interface TargetRow {
  rt_id: string;
  value_kind: string;
  unit: string | null;
  label_fr: string;
}

/** Enregistre ou corrige un résultat tant qu'il n'est pas validé techniquement. Calcule le drapeau. */
export async function enterResultIn(
  tx: Tx,
  ctx: RequestContext,
  specimenId: string,
  input: ResultInput,
  source: string,
) {
  const sp = await tx.query<{ id: string; status: string; request_id: string }>(
    "select id, status, request_id from lab.specimens where id = $1",
    [specimenId],
  );
  const s = sp.rows[0];
  if (!s) throw notFound("Échantillon");
  if (s.status !== "received")
    throw new DomainError(
      "specimen_not_received",
      "L'échantillon doit d'abord être reçu au laboratoire.",
      409,
    );
  const t = await tx.query<TargetRow>(
    `select rt.id as rt_id, t.value_kind, t.unit, t.label_fr from lab.request_tests rt join lab.tests t on t.code = rt.test_code
      where rt.specimen_id = $1 and rt.test_code = $2`,
    [specimenId, input.testCode],
  );
  const target = t.rows[0];
  if (!target)
    throw new DomainError(
      "test_not_on_specimen",
      "Cette analyse n'est pas demandée sur cet échantillon.",
      409,
    );
  if (target.value_kind === "numeric" && input.value === undefined)
    throw new DomainError("numeric_required", "Cette analyse attend une valeur numérique.", 400);
  if (target.value_kind === "text" && !input.text)
    throw new DomainError("text_required", "Cette analyse attend un résultat en texte.", 400);
  const req = (
    await tx.query<ReqRow>(`select ${REQ_COLS} from lab.requests where id = $1`, [s.request_id])
  ).rows[0] as ReqRow;
  const patient = (await patientSummaries(tx, [req.patient_id])).get(req.patient_id);
  let flag: Flag = "none";
  let range: RangeRow | null = null;
  if (target.value_kind === "numeric") {
    range = await applicableRange(
      tx,
      input.testCode,
      patient?.sex ?? null,
      ageInDays(patient?.birthDate ?? null),
    );
    flag = flagFor(input.value as number, range ? rangeNumbers(range) : null);
  }
  const existing = await tx.query<{
    id: string;
    status: string;
    value_numeric: string | null;
    value_text: string | null;
  }>(
    "select id, status, value_numeric, value_text from lab.results where request_test_id = $1 for update",
    [target.rt_id],
  );
  const prev = existing.rows[0];
  if (prev && prev.status !== "entered")
    throw new DomainError(
      "result_locked",
      "Ce résultat est déjà validé techniquement : il ne se corrige plus ici.",
      409,
    );
  let resultId: number;
  if (prev) {
    await tx.query(
      `update lab.results set value_numeric = $2, value_text = $3, flag = $4, ref_low = $5, ref_high = $6, source = $7,
         entered_by = $8, entered_by_name = $9, entered_at = now() where id = $1`,
      [
        prev.id,
        input.value ?? null,
        input.text ?? null,
        flag,
        range?.low ?? null,
        range?.high ?? null,
        source,
        ctx.user.id,
        ctx.user.name,
      ],
    );
    resultId = Number(prev.id);
  } else {
    const ins = await tx.query<{ id: string }>(
      `insert into lab.results (request_test_id, specimen_id, test_code, value_numeric, value_text, unit, flag, ref_low, ref_high, source, entered_by, entered_by_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
      [
        target.rt_id,
        specimenId,
        input.testCode,
        input.value ?? null,
        input.text ?? null,
        target.unit,
        flag,
        range?.low ?? null,
        range?.high ?? null,
        source,
        ctx.user.id,
        ctx.user.name,
      ],
    );
    resultId = Number((ins.rows[0] as { id: string }).id);
  }
  await writeAudit(tx, ctx, {
    action: prev ? "lab.result.correct" : "lab.result.enter",
    entityType: "lab_result",
    entityId: String(resultId),
    patientId: req.patient_id,
    detail: {
      testCode: input.testCode,
      flag,
      source,
      previous: prev ? { value: prev.value_numeric ?? prev.value_text } : null,
    },
  });
  if (flag === "critical_low" || flag === "critical_high") {
    const open = await tx.query(
      "select 1 from lab.notifications where result_id = $1 and kind = 'critical' and acknowledged_at is null",
      [resultId],
    );
    if (!open.rowCount)
      await tx.query(
        `insert into lab.notifications (recipient_id, kind, request_id, result_id, patient_id, message) values ($1, 'critical', $2, $3, $4, $5)`,
        [
          req.prescriber_id,
          req.id,
          resultId,
          req.patient_id,
          `Valeur critique : ${target.label_fr} = ${input.value}${target.unit ? ` ${target.unit}` : ""} (${flag === "critical_low" ? "trop bas" : "trop haut"}). Accusé de réception demandé.`,
        ],
      );
  }
  return { id: resultId, testCode: input.testCode, flag, status: "entered" };
}

export async function enterResult(
  db: Db,
  ctx: RequestContext,
  specimenId: string,
  input: ResultInput,
) {
  return withTransaction(db, (tx) => enterResultIn(tx, ctx, specimenId, input, "manual"));
}

/* Interface avec un analyseur (F7-5). Le pilote lit un message texte ; le simulateur de test produit le même format :
     H|<analyseur>
     O|<code d'échantillon scanné>
     R|<code analyseur>|<valeur>|<unité>
   Un résultat n'est jamais enregistré si l'échantillon est inconnu, non reçu, ou ne porte pas l'analyse. */
export function parseAnalyzerMessage(message: string) {
  const lines = message
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const header = lines.find((l) => l.startsWith("H|"));
  const order = lines.find((l) => l.startsWith("O|"));
  if (!header || !order || lines.filter((l) => l.startsWith("O|")).length !== 1)
    throw new DomainError(
      "bad_message",
      "Message d'analyseur illisible : un en-tête H et exactement un échantillon O sont attendus.",
      400,
    );
  const results = lines
    .filter((l) => l.startsWith("R|"))
    .map((l) => {
      const [, code, value, unit] = l.split("|");
      return { code: code ?? "", value: value ?? "", unit: unit ?? "" };
    });
  return { analyzer: header.split("|")[1] ?? "", specimenScan: order.split("|")[1] ?? "", results };
}

export async function ingestAnalyzer(
  db: Db,
  ctx: RequestContext,
  analyzer: string,
  message: string,
) {
  const parsed = parseAnalyzerMessage(message);
  if (parsed.analyzer !== analyzer)
    throw new DomainError(
      "analyzer_mismatch",
      "Le message vient d'un autre analyseur que celui de l'URL.",
      409,
    );
  return withTransaction(db, async (tx) => {
    const number = parseSpecimenPayload(parsed.specimenScan);
    if (!number)
      throw new DomainError(
        "invalid_scan",
        "Code d'échantillon illisible : aucun résultat enregistré.",
        400,
      );
    const sp = await tx.query<{ id: string }>("select id from lab.specimens where number = $1", [
      number,
    ]);
    const specimenId = sp.rows[0]?.id;
    if (!specimenId)
      throw new DomainError(
        "unknown_specimen",
        "Échantillon inconnu : aucun résultat enregistré.",
        404,
      );
    const accepted: { testCode: string; flag: Flag }[] = [];
    const rejected: { code: string; reason: string }[] = [];
    for (const r of parsed.results) {
      const map = await tx.query<{ test_code: string }>(
        "select test_code from lab.analyzer_mappings where analyzer = $1 and analyzer_code = $2",
        [analyzer, r.code],
      );
      const testCode = map.rows[0]?.test_code;
      const value = Number(r.value);
      if (!testCode) {
        rejected.push({ code: r.code, reason: "code analyseur non correspondu à une analyse" });
        continue;
      }
      if (r.value.trim() === "" || !Number.isFinite(value)) {
        rejected.push({ code: r.code, reason: "valeur illisible" });
        continue;
      }
      await tx.query("savepoint one");
      try {
        const res = await enterResultIn(
          tx,
          ctx,
          specimenId,
          { testCode, value },
          `analyzer:${analyzer}`,
        );
        accepted.push({ testCode, flag: res.flag });
        await tx.query("release savepoint one");
      } catch (e) {
        await tx.query("rollback to savepoint one");
        if (!(e instanceof DomainError)) throw e;
        rejected.push({ code: r.code, reason: e.message });
      }
    }
    await writeAudit(tx, ctx, {
      action: "lab.analyzer",
      entityType: "lab_specimen",
      entityId: specimenId,
      detail: { analyzer, accepted: accepted.length, rejected: rejected.length },
    });
    return { specimen: number, accepted, rejected };
  });
}

export async function setAnalyzerMappings(
  db: Db,
  ctx: RequestContext,
  analyzer: string,
  mappings: { analyzerCode: string; testCode: string }[],
) {
  return withTransaction(db, async (tx) => {
    for (const m of mappings) {
      const t = await tx.query("select 1 from lab.tests where code = $1", [m.testCode]);
      if (!t.rowCount)
        throw new DomainError("unknown_test", `Analyse inconnue : ${m.testCode}`, 400);
    }
    await tx.query("delete from lab.analyzer_mappings where analyzer = $1", [analyzer]);
    for (const m of mappings)
      await tx.query(
        "insert into lab.analyzer_mappings (analyzer, analyzer_code, test_code) values ($1, $2, $3)",
        [analyzer, m.analyzerCode, m.testCode],
      );
    await writeAudit(tx, ctx, {
      action: "lab.analyzer.mappings",
      entityType: "analyzer",
      entityId: analyzer,
      detail: { count: mappings.length },
    });
    return { analyzer, mappings: mappings.length };
  });
}

/* ------------------------------------------------------------------ validation en deux temps (F7-6) */

async function specimenResults(tx: Tx, specimenId: string) {
  const tests = await tx.query<{ n: string }>(
    "select count(*) as n from lab.request_tests where specimen_id = $1",
    [specimenId],
  );
  const results = await tx.query<{
    id: string;
    status: string;
    test_code: string;
    flag: Flag;
    tech_by: string | null;
    tech_by_name: string | null;
  }>(
    "select id, status, test_code, flag, tech_by, tech_by_name from lab.results where specimen_id = $1 order by id for update",
    [specimenId],
  );
  return { expected: Number(tests.rows[0]?.n), results: results.rows };
}

export async function technicalValidation(db: Db, ctx: RequestContext, specimenId: string) {
  return withTransaction(db, async (tx) => {
    const { expected, results } = await specimenResults(tx, specimenId);
    if (results.length < expected)
      throw new DomainError(
        "results_missing",
        `Il manque ${expected - results.length} résultat(s) sur cet échantillon.`,
        409,
      );
    if (results.every((r) => r.status !== "entered"))
      throw new DomainError("already_validated", "La validation technique est déjà faite.", 409);
    await tx.query(
      "update lab.results set status = 'tech_validated', tech_by = $2, tech_by_name = $3, tech_at = now() where specimen_id = $1 and status = 'entered'",
      [specimenId, ctx.user.id, ctx.user.name],
    );
    const req = (
      await tx.query<{ patient_id: string }>(
        "select r.patient_id from lab.specimens s join lab.requests r on r.id = s.request_id where s.id = $1",
        [specimenId],
      )
    ).rows[0];
    await writeAudit(tx, ctx, {
      action: "lab.validate-tech",
      entityType: "lab_specimen",
      entityId: specimenId,
      patientId: req?.patient_id ?? null,
      detail: { results: results.length },
    });
    return { specimenId, status: "tech_validated", results: results.length };
  });
}

export async function biologicalValidation(db: Db, ctx: RequestContext, specimenId: string) {
  return withTransaction(db, async (tx) => {
    const sp = await tx.query<{ request_id: string }>(
      "select request_id from lab.specimens where id = $1",
      [specimenId],
    );
    const requestId = sp.rows[0]?.request_id;
    if (!requestId) throw notFound("Échantillon");
    const { results } = await specimenResults(tx, specimenId);
    const waiting = results.filter((r) => r.status === "tech_validated");
    if (waiting.length === 0)
      throw new DomainError(
        "not_tech_validated",
        "La validation technique doit précéder la validation biologique.",
        409,
      );
    if (waiting.some((r) => r.tech_by === ctx.user.id))
      throw new DomainError(
        "same_person",
        "La validation biologique doit être faite par une autre personne que la validation technique.",
        409,
      );
    await tx.query(
      "update lab.results set status = 'validated', bio_by = $2, bio_by_name = $3, bio_at = now() where specimen_id = $1 and status = 'tech_validated'",
      [specimenId, ctx.user.id, ctx.user.name],
    );
    const req = (
      await tx.query<ReqRow>(`select ${REQ_COLS} from lab.requests where id = $1 for update`, [
        requestId,
      ])
    ).rows[0] as ReqRow;
    const open = await tx.query(
      "select 1 from lab.request_tests rt left join lab.results r on r.request_test_id = rt.id where rt.request_id = $1 and (r.id is null or r.status <> 'validated')",
      [requestId],
    );
    const complete = !open.rowCount;
    if (complete) {
      await tx.query("update lab.requests set status = 'completed' where id = $1", [requestId]);
      await completeTicketIn(tx, ctx, req.ticket_id);
    }
    const loinc = await tx.query<{ loinc: string; flag: Flag }>(
      "select t.loinc, r.flag from lab.results r join lab.tests t on t.code = r.test_code where r.id = any($1::bigint[])",
      [waiting.map((w) => w.id)],
    );
    await writeAudit(tx, ctx, {
      action: "lab.validate-bio",
      entityType: "lab_specimen",
      entityId: specimenId,
      patientId: req.patient_id,
      detail: { results: waiting.length, requestComplete: complete },
    });
    await appendEvent(tx, ctx, {
      type: "LabResultValidated",
      patientId: req.patient_id,
      payload: {
        requestId,
        specimenId,
        orderId: req.order_id,
        results: loinc.rows.map((l) => ({ loincCode: l.loinc, flag: l.flag })),
        hasCritical: loinc.rows.some(
          (l) => l.flag === "critical_low" || l.flag === "critical_high",
        ),
        technicalBy: {
          userId: waiting[0]?.tech_by ?? "?",
          ...(waiting[0]?.tech_by_name ? { name: waiting[0].tech_by_name } : {}),
        },
        biologicalBy: person(ctx),
        requestComplete: complete,
      },
    });
    return { specimenId, status: "validated", requestComplete: complete };
  });
}

/* ------------------------------------------------------------------ lecture des résultats */

export async function patientResults(db: Db, ctx: RequestContext, patientId: string) {
  const family = await relatedPatientIds(db, patientId);
  const all = seesUnvalidated(ctx);
  const res = await db.query<{
    id: string;
    request_number: string;
    request_id: string;
    test_code: string;
    label_fr: string;
    label_ar: string;
    loinc: string;
    value_numeric: string | null;
    value_text: string | null;
    unit: string | null;
    flag: Flag;
    ref_low: string | null;
    ref_high: string | null;
    status: string;
    entered_at: Date;
    bio_at: Date | null;
  }>(
    `select r.id, q.number as request_number, q.id as request_id, r.test_code, t.label_fr, t.label_ar, t.loinc, r.value_numeric, r.value_text, r.unit,
            r.flag, r.ref_low, r.ref_high, r.status, r.entered_at, r.bio_at
       from lab.results r join lab.specimens s on s.id = r.specimen_id join lab.requests q on q.id = s.request_id join lab.tests t on t.code = r.test_code
      where q.patient_id = any($1::uuid[]) and ($2 or r.status = 'validated') order by r.entered_at desc, r.id`,
    [family, all],
  );
  await writeAudit(db as unknown as Tx, ctx, {
    action: "lab.read",
    entityType: "patient",
    entityId: patientId,
    patientId,
  });
  return res.rows.map((r) => ({
    id: Number(r.id),
    requestNumber: r.request_number,
    requestId: r.request_id,
    testCode: r.test_code,
    labelFr: r.label_fr,
    labelAr: r.label_ar,
    loinc: r.loinc,
    value: r.value_numeric !== null ? Number(r.value_numeric) : r.value_text,
    unit: r.unit,
    flag: r.flag,
    refLow: num(r.ref_low),
    refHigh: num(r.ref_high),
    status: r.status,
    validatedAt: r.bio_at?.toISOString() ?? null,
  }));
}

/* ------------------------------------------------------------------ valeurs critiques (F7-7) */

async function setting(tx: Tx | Db, key: string): Promise<string> {
  return (
    (await tx.query<{ value: string }>("select value from lab.settings where key = $1", [key]))
      .rows[0]?.value ?? ""
  );
}

export async function updateSettings(
  db: Db,
  ctx: RequestContext,
  input: { criticalAckMinutes?: number | undefined; escalationUser?: string | undefined },
) {
  return withTransaction(db, async (tx) => {
    const put = (key: string, value: string) =>
      tx.query(
        "insert into lab.settings (key, value, updated_by) values ($1, $2, $3) on conflict (key) do update set value = $2, updated_by = $3, updated_at = now()",
        [key, value, ctx.user.id],
      );
    if (input.criticalAckMinutes !== undefined)
      await put("critical_ack_minutes", String(input.criticalAckMinutes));
    if (input.escalationUser !== undefined) await put("escalation_user", input.escalationUser);
    await writeAudit(tx, ctx, {
      action: "lab.settings",
      entityType: "lab_settings",
      detail: input,
    });
    return {
      criticalAckMinutes: Number(await setting(tx, "critical_ack_minutes")),
      escalationUser: await setting(tx, "escalation_user"),
    };
  });
}

export async function myNotifications(db: Db, ctx: RequestContext, onlyOpen: boolean) {
  const res = await db.query<{
    id: string;
    kind: string;
    request_id: string;
    patient_id: string;
    message: string;
    created_at: Date;
    acknowledged_at: Date | null;
    escalated_at: Date | null;
  }>(
    `select id, kind, request_id, patient_id, message, created_at, acknowledged_at, escalated_at from lab.notifications
      where recipient_id = $1 and (not $2 or acknowledged_at is null) order by created_at desc limit 100`,
    [ctx.user.id, onlyOpen],
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    requestId: r.request_id,
    patientId: r.patient_id,
    message: r.message,
    createdAt: r.created_at.toISOString(),
    acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
    escalatedAt: r.escalated_at?.toISOString() ?? null,
  }));
}

/** Accusé de réception : seul le destinataire peut le donner. */
export async function acknowledge(db: Db, ctx: RequestContext, id: number) {
  return withTransaction(db, async (tx) => {
    const n = await tx.query<{
      recipient_id: string;
      acknowledged_at: Date | null;
      patient_id: string;
    }>(
      "select recipient_id, acknowledged_at, patient_id from lab.notifications where id = $1 for update",
      [id],
    );
    const row = n.rows[0];
    if (!row) throw notFound("Notification");
    if (row.recipient_id !== ctx.user.id)
      throw new DomainError(
        "not_recipient",
        "Cette notification est adressée à un autre utilisateur.",
        403,
      );
    if (row.acknowledged_at) return { id, acknowledged: true };
    await tx.query(
      "update lab.notifications set acknowledged_at = now(), acknowledged_by = $2 where id = $1",
      [id, ctx.user.id],
    );
    await writeAudit(tx, ctx, {
      action: "lab.acknowledge",
      entityType: "lab_notification",
      entityId: String(id),
      patientId: row.patient_id,
    });
    return { id, acknowledged: true };
  });
}

/** Valeurs critiques non acquittées après le délai fixé par le biologiste : escalade vers le responsable désigné. */
export async function escalateOverdue(db: Db, now = new Date()): Promise<number> {
  return withTransaction(db, async (tx) => {
    const minutes = Number(await setting(tx, "critical_ack_minutes")) || 30;
    const target = await setting(tx, "escalation_user");
    if (!target) return 0;
    const due = await tx.query<{
      id: string;
      request_id: string;
      patient_id: string;
      message: string;
      recipient_id: string;
    }>(
      `select id, request_id, patient_id, message, recipient_id from lab.notifications
        where kind = 'critical' and acknowledged_at is null and escalated_at is null and created_at <= $1::timestamptz - make_interval(mins => $2) for update`,
      [now.toISOString(), minutes],
    );
    for (const n of due.rows) {
      await tx.query("update lab.notifications set escalated_at = $2 where id = $1", [
        n.id,
        now.toISOString(),
      ]);
      await tx.query(
        `insert into lab.notifications (recipient_id, kind, request_id, patient_id, message) values ($1, 'escalation', $2, $3, $4)`,
        [
          target,
          n.request_id,
          n.patient_id,
          `ESCALADE : non acquittée après ${minutes} min par ${n.recipient_id}. ${n.message}`,
        ],
      );
      await tx.query(
        `insert into audit.log (actor_id, actor_roles, action, entity_type, entity_id, patient_id, request_id, detail)
         values ('system:lab', '{}', 'lab.escalate', 'lab_notification', $1, $2, 'escalation', $3)`,
        [String(n.id), n.patient_id, JSON.stringify({ minutes, to: target })],
      );
    }
    return due.rows.length;
  });
}

/* ------------------------------------------------------------------ compte rendu et qualité (F7-8) */

export async function printReport(db: Db, ctx: RequestContext, requestId: string) {
  const r = (
    await db.query<ReqRow>(`select ${REQ_COLS} from lab.requests where id = $1`, [requestId])
  ).rows[0];
  if (!r) throw notFound("Demande");
  const results = (
    await patientResults(db, { ...ctx, user: { ...ctx.user, roles: [] } }, r.patient_id)
  ).filter((x) => x.requestId === requestId);
  if (results.length === 0)
    throw new DomainError(
      "nothing_validated",
      "Aucun résultat validé à imprimer pour cette demande.",
      409,
    );
  const p = (await patientSummaries(db, [r.patient_id])).get(r.patient_id);
  await writeAudit(db as unknown as Tx, ctx, {
    action: "lab.report",
    entityType: "lab_request",
    entityId: requestId,
    patientId: r.patient_id,
  });
  return {
    number: r.number,
    html: renderReport({
      number: r.number,
      patient: p ?? null,
      prescriber: r.prescriber_name ?? r.prescriber_id,
      results,
    }),
  };
}

export async function setQcTarget(
  db: Db,
  ctx: RequestContext,
  input: { testCode: string; level: string; mean: number; sd: number; setOn: string },
) {
  return withTransaction(db, async (tx) => {
    const t = await tx.query("select 1 from lab.tests where code = $1", [input.testCode]);
    if (!t.rowCount) throw notFound("Analyse");
    await tx.query(
      `insert into lab.qc_targets (test_code, level, mean, sd, set_by, set_on) values ($1, $2, $3, $4, $5, $6)
       on conflict (test_code, level) do update set mean = $3, sd = $4, set_by = $5, set_on = $6`,
      [input.testCode, input.level, input.mean, input.sd, ctx.user.id, input.setOn],
    );
    await writeAudit(tx, ctx, {
      action: "lab.qc.target",
      entityType: "lab_test",
      entityId: input.testCode,
      detail: input,
    });
    return input;
  });
}

/** Contrôle qualité : écart à la cible en nombre d'écarts-types ; au-delà de 2 alerte, au-delà de 3 rejet. */
export async function recordQc(
  db: Db,
  ctx: RequestContext,
  input: { testCode: string; level: string; value: number },
) {
  return withTransaction(db, async (tx) => {
    const t = await tx.query<{ mean: string; sd: string }>(
      "select mean, sd from lab.qc_targets where test_code = $1 and level = $2",
      [input.testCode, input.level],
    );
    const target = t.rows[0];
    if (!target)
      throw new DomainError(
        "no_qc_target",
        "Aucune cible de contrôle définie par le biologiste pour cette analyse et ce niveau.",
        409,
      );
    const z = (input.value - Number(target.mean)) / Number(target.sd);
    const status = Math.abs(z) > 3 ? "reject" : Math.abs(z) > 2 ? "warning" : "ok";
    await tx.query(
      "insert into lab.qc_runs (test_code, level, value, z_score, status, run_by) values ($1, $2, $3, $4, $5, $6)",
      [input.testCode, input.level, input.value, z, status, ctx.user.id],
    );
    await writeAudit(tx, ctx, {
      action: "lab.qc.run",
      entityType: "lab_test",
      entityId: input.testCode,
      detail: { level: input.level, value: input.value, z, status },
    });
    return {
      testCode: input.testCode,
      level: input.level,
      value: input.value,
      zScore: Math.round(z * 100) / 100,
      status,
    };
  });
}

export async function qcSeries(db: Db, testCode: string, level: string) {
  const target = (
    await db.query<{ mean: string; sd: string }>(
      "select mean, sd from lab.qc_targets where test_code = $1 and level = $2",
      [testCode, level],
    )
  ).rows[0];
  if (!target) throw notFound("Cible de contrôle");
  const runs = await db.query<{ value: string; z_score: string; status: string; run_at: Date }>(
    "select value, z_score, status, run_at from lab.qc_runs where test_code = $1 and level = $2 order by run_at, id limit 200",
    [testCode, level],
  );
  const mean = Number(target.mean);
  const sd = Number(target.sd);
  return {
    testCode,
    level,
    mean,
    sd,
    limits: {
      warningLow: mean - 2 * sd,
      warningHigh: mean + 2 * sd,
      rejectLow: mean - 3 * sd,
      rejectHigh: mean + 3 * sd,
    },
    points: runs.rows.map((r) => ({
      at: r.run_at.toISOString(),
      value: Number(r.value),
      zScore: Number(r.z_score),
      status: r.status,
    })),
  };
}

/** Analyses dont le contrôle du jour n'a pas été fait (ou a été rejeté). */
export async function qcStatusToday(db: Db) {
  const res = await db.query<{ test_code: string; level: string; last_status: string | null }>(
    `select q.test_code, q.level,
            (select r.status from lab.qc_runs r where r.test_code = q.test_code and r.level = q.level
                and (r.run_at at time zone 'UTC' + interval '3 hours')::date = (now() at time zone 'UTC' + interval '3 hours')::date
              order by r.run_at desc, r.id desc limit 1) as last_status
       from lab.qc_targets q order by q.test_code, q.level`,
  );
  return res.rows.map((r) => ({
    testCode: r.test_code,
    level: r.level,
    doneToday: r.last_status !== null,
    lastStatus: r.last_status,
    ok: r.last_status === "ok" || r.last_status === "warning",
  }));
}

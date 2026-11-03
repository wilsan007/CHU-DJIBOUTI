import { createHash } from "node:crypto";
import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { SIGNATURES } from "../../common/files.ts";
import { nextNumber } from "../../common/numbering.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import { patientSummaries, relatedPatientIds } from "../identity/interface.ts";
import { completeTicketIn, startTicketIn, ticketContext } from "../orders/service.ts";

export const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 10 * 1024 * 1024);

const person = (ctx: RequestContext) => ({ userId: ctx.user.id, name: ctx.user.name });
const isImagingStaff = (ctx: RequestContext): boolean => ctx.user.roles.includes("imaging");

/** Appelé par le consommateur : une demande par examen du ticket d'imagerie libéré par la caisse. */
export async function createRequestsFromTicket(tx: Tx, ctx: RequestContext, ticketId: string) {
  const c = await ticketContext(tx, ticketId);
  if (c.ticket.departmentCode !== "IMG") return [];
  const dup = await tx.query("select 1 from imaging.requests where ticket_id = $1", [ticketId]);
  if (dup.rowCount) return [];
  const ids: string[] = [];
  for (const item of c.items) {
    for (let i = 0; i < item.quantity; i += 1) {
      const number = await nextNumber(tx, "imaging", "request", "X");
      const res = await tx.query<{ id: string }>(
        `insert into imaging.requests (number, ticket_id, ticket_code, order_id, patient_id, prescriber_id, prescriber_name, act_code, label_fr, label_ar)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [
          number,
          ticketId,
          c.ticket.code,
          c.orderId,
          c.patientId,
          c.placedBy.id,
          c.placedBy.name,
          item.actCode,
          item.labelFr,
          item.labelAr,
        ],
      );
      const id = (res.rows[0] as { id: string }).id;
      ids.push(id);
      await writeAudit(tx, ctx, {
        action: "imaging.request.create",
        entityType: "imaging_request",
        entityId: id,
        patientId: c.patientId,
        detail: { number, act: item.actCode, ticket: c.ticket.code },
      });
    }
  }
  return ids;
}

interface Row {
  id: string;
  number: string;
  ticket_id: string;
  ticket_code: string;
  order_id: string;
  patient_id: string;
  prescriber_id: string;
  prescriber_name: string | null;
  act_code: string;
  label_fr: string;
  label_ar: string;
  status: "pending" | "scheduled" | "in_progress" | "reported";
  scheduled_for: Date | null;
  accession: string | null;
  created_at: Date;
}
const COLS =
  "id, number, ticket_id, ticket_code, order_id, patient_id, prescriber_id, prescriber_name, act_code, label_fr, label_ar, status, scheduled_for, accession, created_at";

const view = (r: Row) => ({
  id: r.id,
  number: r.number,
  ticketCode: r.ticket_code,
  actCode: r.act_code,
  labelFr: r.label_fr,
  labelAr: r.label_ar,
  status: r.status,
  scheduledFor: r.scheduled_for?.toISOString() ?? null,
  accession: r.accession,
  createdAt: r.created_at.toISOString(),
  prescriber: { id: r.prescriber_id, name: r.prescriber_name },
});

export async function listRequests(
  db: Db,
  filter: { status?: string | undefined; patientId?: string | undefined },
) {
  const ids = filter.patientId ? await relatedPatientIds(db, filter.patientId) : null;
  const res = await db.query<Row>(
    `select ${COLS} from imaging.requests where ($1::text is null or status = $1) and ($2::uuid[] is null or patient_id = any($2)) order by coalesce(scheduled_for, created_at), number limit 200`,
    [filter.status ?? null, ids],
  );
  const people = await patientSummaries(
    db,
    res.rows.map((r) => r.patient_id),
  );
  return res.rows.map((r) => ({ ...view(r), patient: people.get(r.patient_id) ?? null }));
}

async function lockRequest(tx: Tx, id: string): Promise<Row> {
  const res = await tx.query<Row>(`select ${COLS} from imaging.requests where id = $1 for update`, [
    id,
  ]);
  const r = res.rows[0];
  if (!r) throw notFound("Examen");
  return r;
}

/** Programmation : date et heure de l'examen, tracées. */
export async function schedule(db: Db, ctx: RequestContext, id: string, scheduledFor: string) {
  return withTransaction(db, async (tx) => {
    const r = await lockRequest(tx, id);
    if (r.status === "in_progress" || r.status === "reported")
      throw new DomainError("already_performed", "Cet examen est déjà commencé.", 409);
    if (new Date(scheduledFor).getTime() < Date.now() - 60_000)
      throw new DomainError("past_date", "La date de l'examen est déjà passée.", 400);
    await tx.query(
      "update imaging.requests set status = 'scheduled', scheduled_for = $2, scheduled_by = $3 where id = $1",
      [id, scheduledFor, ctx.user.id],
    );
    await writeAudit(tx, ctx, {
      action: "imaging.schedule",
      entityType: "imaging_request",
      entityId: id,
      patientId: r.patient_id,
      detail: { number: r.number, scheduledFor },
    });
    return view(await lockRequest(tx, id));
  });
}

/** Début de l'examen : démarre le ticket d'imagerie (qui a commencé) et attribue le numéro d'accession. */
export async function perform(db: Db, ctx: RequestContext, id: string) {
  return withTransaction(db, async (tx) => {
    const r = await lockRequest(tx, id);
    if (r.status === "in_progress" || r.status === "reported")
      throw new DomainError("already_performed", "Cet examen est déjà commencé.", 409);
    const ticket = await tx.query<{ status: string }>(
      "select status from orders.department_tickets where id = $1",
      [r.ticket_id],
    );
    if (ticket.rows[0]?.status === "sent") await startTicketIn(tx, ctx, r.ticket_id);
    else if (ticket.rows[0]?.status === "cancelled")
      throw new DomainError("ticket_cancelled", "Le ticket de cet examen est annulé.", 409);
    const accession = await nextNumber(tx, "imaging", "accession", "ACC", 8);
    await tx.query(
      "update imaging.requests set status = 'in_progress', accession = $2, performed_by = $3, performed_at = now() where id = $1",
      [id, accession, ctx.user.id],
    );
    await writeAudit(tx, ctx, {
      action: "imaging.perform",
      entityType: "imaging_request",
      entityId: id,
      patientId: r.patient_id,
      detail: { number: r.number, accession },
    });
    return view(await lockRequest(tx, id));
  });
}

export async function addImage(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: { filename: string; mime: string; dataBase64: string },
) {
  const data = Buffer.from(input.dataBase64, "base64");
  if (data.length === 0) throw new DomainError("empty_file", "Fichier vide.", 400);
  if (data.length > MAX_IMAGE_BYTES)
    throw new DomainError(
      "image_too_large",
      `Fichier trop volumineux (maximum ${Math.floor(MAX_IMAGE_BYTES / 1024)} Ko).`,
      413,
    );
  const check = SIGNATURES[input.mime];
  if (!check)
    throw new DomainError(
      "unsupported_type",
      "Seuls les images PNG ou JPEG et les PDF sont acceptés pour l'instant (DICOM : question Q28).",
      415,
    );
  if (!check(data))
    throw new DomainError("mime_mismatch", "Le contenu ne correspond pas au type annoncé.", 400);
  return withTransaction(db, async (tx) => {
    const r = await lockRequest(tx, id);
    if (r.status !== "in_progress")
      throw new DomainError(
        "not_in_progress",
        "Les images s'ajoutent pendant l'examen, après son début et avant le compte rendu.",
        409,
      );
    const res = await tx.query<{ id: string }>(
      "insert into imaging.images (request_id, filename, mime, size, sha256, data, uploaded_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [
        id,
        input.filename,
        input.mime,
        data.length,
        createHash("sha256").update(data).digest("hex"),
        data,
        ctx.user.id,
      ],
    );
    await writeAudit(tx, ctx, {
      action: "imaging.image",
      entityType: "imaging_request",
      entityId: id,
      patientId: r.patient_id,
      detail: { filename: input.filename, size: data.length },
    });
    return {
      id: (res.rows[0] as { id: string }).id,
      filename: input.filename,
      mime: input.mime,
      size: data.length,
    };
  });
}

/** Lecture d'une image : audit de chaque accès (donnée de santé). */
export async function getImage(db: Db, ctx: RequestContext, imageId: string) {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<{
      filename: string;
      mime: string;
      data: Buffer;
      request_id: string;
    }>("select filename, mime, data, request_id from imaging.images where id = $1", [imageId]);
    const img = res.rows[0];
    if (!img) throw notFound("Image");
    const r = (
      await tx.query<{ patient_id: string; status: string }>(
        "select patient_id, status from imaging.requests where id = $1",
        [img.request_id],
      )
    ).rows[0];
    if (!isImagingStaff(ctx) && r?.status !== "reported")
      throw new DomainError(
        "not_reported",
        "Les images sont visibles par le prescripteur après le compte rendu.",
        403,
      );
    await writeAudit(tx, ctx, {
      action: "imaging.image.read",
      entityType: "imaging_image",
      entityId: imageId,
      patientId: r?.patient_id ?? null,
    });
    return img;
  });
}

/** Compte rendu. Le premier termine l'examen et clôture le ticket ; un compte rendu corrigé ajoute une version. */
export async function report(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: { findings: string; conclusion: string },
) {
  return withTransaction(db, async (tx) => {
    const r = await lockRequest(tx, id);
    if (r.status === "pending" || r.status === "scheduled")
      throw new DomainError("not_performed", "L'examen n'est pas encore commencé.", 409);
    const last = await tx.query<{ v: number | null }>(
      "select max(version) as v from imaging.reports where request_id = $1",
      [id],
    );
    const version = (last.rows[0]?.v ?? 0) + 1;
    await tx.query(
      "insert into imaging.reports (request_id, version, findings, conclusion, reported_by, reported_by_name) values ($1, $2, $3, $4, $5, $6)",
      [id, version, input.findings, input.conclusion, ctx.user.id, ctx.user.name],
    );
    if (version === 1) {
      await tx.query("update imaging.requests set status = 'reported' where id = $1", [id]);
      // Le ticket se clôt quand tous les examens de ce ticket ont un compte rendu.
      const open = await tx.query(
        "select 1 from imaging.requests where ticket_id = $1 and status <> 'reported'",
        [r.ticket_id],
      );
      if (!open.rowCount) await completeTicketIn(tx, ctx, r.ticket_id);
      const images = await tx.query<{ n: string }>(
        "select count(*) as n from imaging.images where request_id = $1",
        [id],
      );
      await appendEvent(tx, ctx, {
        type: "ImagingReportFinalized",
        patientId: r.patient_id,
        payload: {
          requestId: id,
          requestNumber: r.number,
          accession: r.accession as string,
          actCode: r.act_code,
          orderId: r.order_id,
          imageCount: Number(images.rows[0]?.n),
          reportedBy: person(ctx),
        },
      });
    }
    await writeAudit(tx, ctx, {
      action: version === 1 ? "imaging.report" : "imaging.report.amend",
      entityType: "imaging_request",
      entityId: id,
      patientId: r.patient_id,
      detail: { number: r.number, version },
    });
    return { requestId: id, version };
  });
}

/** Lecture d'un examen : le prescripteur ne voit le compte rendu et les images qu'une fois l'examen rapporté. */
export async function getRequest(db: Db, ctx: RequestContext, id: string) {
  const res = await db.query<Row>(`select ${COLS} from imaging.requests where id = $1`, [id]);
  const r = res.rows[0];
  if (!r) throw notFound("Examen");
  const staff = isImagingStaff(ctx);
  const reported = r.status === "reported";
  const reports =
    staff || reported
      ? (
          await db.query<{
            version: number;
            findings: string;
            conclusion: string;
            reported_by_name: string | null;
            reported_at: Date;
          }>(
            "select version, findings, conclusion, reported_by_name, reported_at from imaging.reports where request_id = $1 order by version desc",
            [id],
          )
        ).rows
      : [];
  const images =
    staff || reported
      ? (
          await db.query<{ id: string; filename: string; mime: string; size: number }>(
            "select id, filename, mime, size from imaging.images where request_id = $1 order by uploaded_at",
            [id],
          )
        ).rows
      : [];
  const person = (await patientSummaries(db, [r.patient_id])).get(r.patient_id) ?? null;
  await writeAudit(db as unknown as Tx, ctx, {
    action: "imaging.read",
    entityType: "imaging_request",
    entityId: id,
    patientId: r.patient_id,
  });
  return {
    ...view(r),
    patient: person,
    reports: reports.map((x) => ({
      version: x.version,
      findings: x.findings,
      conclusion: x.conclusion,
      by: x.reported_by_name,
      at: x.reported_at.toISOString(),
    })),
    images,
  };
}

import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { nextNumber } from "../../common/numbering.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { appendEvent } from "../../events/outbox.ts";
import { checkThreshold, requireDepot, today, usableTotal, move } from "../stock/service.ts";

const person = (ctx: RequestContext) => ({ userId: ctx.user.id, name: ctx.user.name });

/* ------------------------------------------------------------------ délivrance (F6-2) */

export interface DispenseInput {
  prescriptionId: string;
  depot: string;
  /** Sans lignes : tout le reste à délivrer. */
  lines?: { lineNo: number; quantity: number }[] | undefined;
}

interface RxLine {
  line_no: number;
  drug_code: string;
  dci: string;
  strength: string;
  quantity: number;
}

async function remainingLines(tx: Tx | Db, prescriptionId: string) {
  const res = await tx.query<RxLine & { dispensed: string }>(
    `select l.line_no, l.drug_code, l.dci, l.strength, l.quantity,
            coalesce((select sum(dl.quantity) from pharmacy.dispensation_lines dl
                        join pharmacy.dispensations d on d.id = dl.dispensation_id
                       where d.prescription_id = l.prescription_id and dl.line_no = l.line_no), 0) as dispensed
       from prescriptions.lines l where l.prescription_id = $1 order by l.line_no`,
    [prescriptionId],
  );
  return res.rows.map((r) => ({
    lineNo: r.line_no,
    drugCode: r.drug_code,
    dci: r.dci,
    strength: r.strength,
    prescribed: r.quantity,
    dispensed: Number(r.dispensed),
    remaining: r.quantity - Number(r.dispensed),
  }));
}

/** Etat de délivrance : pour chaque ligne, ce qui est prescrit, servi et restant. */
export async function dispensationStatus(db: Db, ctx: RequestContext, prescriptionId: string) {
  const p = await db.query<{ id: string; number: string; status: string; patient_id: string }>(
    "select id, number, status, patient_id from prescriptions.prescriptions where id = $1",
    [prescriptionId],
  );
  const row = p.rows[0];
  if (!row) throw notFound("Ordonnance");
  const lines = await remainingLines(db, prescriptionId);
  const list = await db.query<{
    id: string;
    number: string;
    created_at: Date;
    pharmacist_id: string;
    depot_code: string;
  }>(
    "select id, number, created_at, pharmacist_id, depot_code from pharmacy.dispensations where prescription_id = $1 order by created_at",
    [prescriptionId],
  );
  void ctx;
  return {
    prescriptionId: row.id,
    number: row.number,
    status: row.status,
    lines,
    dispensations: list.rows.map((d) => ({
      id: d.id,
      number: d.number,
      at: d.created_at.toISOString(),
      pharmacistId: d.pharmacist_id,
      depot: d.depot_code,
    })),
  };
}

/**
 * Délivrance totale ou partielle. Chaque ligne est servie lot par lot selon « premier périmé, premier sorti » ;
 * un lot périmé n'est jamais servi. Tout est annulé si une ligne ne peut pas être servie.
 */
export async function dispense(db: Db, ctx: RequestContext, input: DispenseInput) {
  return withTransaction(db, async (tx) => {
    await requireDepot(tx, input.depot);
    const kind = await tx.query<{ kind: string }>("select kind from stock.depots where code = $1", [
      input.depot,
    ]);
    if (kind.rows[0]?.kind !== "pharmacy")
      throw new DomainError(
        "wrong_depot_kind",
        "La délivrance sur ordonnance se fait depuis un dépôt de pharmacie.",
        400,
      );
    const found = await tx.query<{
      id: string;
      number: string;
      status: string;
      patient_id: string;
    }>(
      "select id, number, status, patient_id from prescriptions.prescriptions where id = $1 for update",
      [input.prescriptionId],
    );
    const rx = found.rows[0];
    if (!rx) throw notFound("Ordonnance");
    if (rx.status === "superseded") {
      const next = await tx.query<{ id: string }>(
        "select id from prescriptions.prescriptions where supersedes = $1",
        [rx.id],
      );
      throw new DomainError(
        "prescription_superseded",
        "Cette ordonnance a été remplacée par une nouvelle version : servez la version en vigueur.",
        409,
        { currentId: next.rows[0]?.id ?? null },
      );
    }
    if (rx.status === "cancelled")
      throw new DomainError("prescription_cancelled", "Cette ordonnance est annulée.", 409);
    if (rx.status === "dispensed")
      throw new DomainError(
        "already_dispensed",
        "Cette ordonnance a déjà été entièrement servie.",
        409,
      );

    const remaining = await remainingLines(tx, rx.id);
    const wanted = input.lines
      ? input.lines
      : remaining
          .filter((l) => l.remaining > 0)
          .map((l) => ({ lineNo: l.lineNo, quantity: l.remaining }));
    if (wanted.length === 0)
      throw new DomainError("nothing_to_dispense", "Il ne reste rien à délivrer.", 409);
    const seen = new Set<number>();
    for (const w of wanted) {
      if (seen.has(w.lineNo))
        throw new DomainError("duplicate_line", "Une ligne est répétée dans la délivrance.", 400);
      seen.add(w.lineNo);
    }

    const number = await nextNumber(tx, "pharmacy", "dispensation", "D");
    const created = await tx.query<{ id: string }>(
      `insert into pharmacy.dispensations (number, prescription_id, patient_id, depot_code, pharmacist_id, pharmacist_name)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [number, rx.id, rx.patient_id, input.depot, ctx.user.id, ctx.user.name],
    );
    const dispensationId = created.rows[0]?.id as string;
    const served: {
      lineNo: number;
      drugCode: string;
      lotNumber: string;
      expiresOn: string;
      quantity: number;
    }[] = [];
    const before = new Map<string, number>();

    for (const w of wanted) {
      const line = remaining.find((r) => r.lineNo === w.lineNo);
      if (!line)
        throw new DomainError(
          "unknown_line",
          `La ligne ${w.lineNo} n'existe pas sur cette ordonnance.`,
          400,
        );
      if (w.quantity > line.remaining)
        throw new DomainError(
          "exceeds_prescription",
          `La ligne ${w.lineNo} (${line.dci}) : ${w.quantity} demandé, ${line.remaining} restant à délivrer.`,
          409,
        );
      if (!before.has(line.drugCode))
        before.set(line.drugCode, await usableTotal(tx, line.drugCode));
      // Lots utilisables, du plus proche de la péremption au plus lointain ; lignes de stock verrouillées.
      const lots = await tx.query<{
        lot_id: string;
        lot_number: string;
        expires_on: string;
        quantity: number;
      }>(
        `select s.lot_id, l.lot_number, l.expires_on::text as expires_on, s.quantity
           from stock.stock_levels s join stock.lots l on l.id = s.lot_id
          where s.depot_code = $1 and l.item_code = $2 and s.quantity > 0 and l.expires_on >= $3::date
          order by l.expires_on, l.lot_number, l.id for update of s`,
        [input.depot, line.drugCode, today()],
      );
      const available = lots.rows.reduce((n, r) => n + r.quantity, 0);
      if (available < w.quantity)
        throw new DomainError(
          "insufficient_stock",
          `Stock insuffisant pour ${line.dci} ${line.strength} : ${available} disponible, ${w.quantity} demandé.`,
          409,
          { drugCode: line.drugCode, available, requested: w.quantity },
        );
      let need = w.quantity;
      for (const lot of lots.rows) {
        if (need === 0) break;
        const take = Math.min(need, lot.quantity);
        await move(tx, ctx, {
          depot: input.depot,
          lotId: lot.lot_id,
          quantity: -take,
          kind: "dispense",
          refType: "dispensation",
          refId: dispensationId,
          patientId: rx.patient_id,
        });
        await tx.query(
          `insert into pharmacy.dispensation_lines (dispensation_id, line_no, drug_code, lot_id, quantity)
           values ($1, $2, $3, $4, $5)`,
          [dispensationId, w.lineNo, line.drugCode, lot.lot_id, take],
        );
        served.push({
          lineNo: w.lineNo,
          drugCode: line.drugCode,
          lotNumber: lot.lot_number,
          expiresOn: lot.expires_on,
          quantity: take,
        });
        need -= take;
      }
    }

    const after = await remainingLines(tx, rx.id);
    const status = after.every((l) => l.remaining === 0) ? "dispensed" : "partially_dispensed";
    await tx.query("update prescriptions.prescriptions set status = $2 where id = $1", [
      rx.id,
      status,
    ]);
    await writeAudit(tx, ctx, {
      action: "pharmacy.dispense",
      entityType: "prescription",
      entityId: rx.id,
      patientId: rx.patient_id,
      detail: { number, prescription: rx.number, depot: input.depot, lines: served },
    });
    await appendEvent(tx, ctx, {
      type: "MedicationDispensed",
      patientId: rx.patient_id,
      payload: {
        dispensationId,
        number,
        prescriptionId: rx.id,
        prescriptionStatus: status,
        lines: served.map((s) => ({
          drugCode: s.drugCode,
          lotNumber: s.lotNumber,
          quantity: s.quantity,
        })),
        dispensedBy: person(ctx),
      },
    });
    for (const [drugCode, was] of before) await checkThreshold(tx, ctx, drugCode, was);
    return { id: dispensationId, number, prescriptionStatus: status, lines: served };
  });
}

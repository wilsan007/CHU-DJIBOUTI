import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { can } from "../../auth/permissions.ts";
import { nextNumber } from "../../common/numbering.ts";
import { localDate } from "../../common/time.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import { setAccountStatusIn } from "../admin/service.ts";

export const CATEGORIES = [
  "physician",
  "nurse",
  "midwife",
  "lab_technician",
  "imaging_technician",
  "pharmacist",
  "biologist",
  "cashier",
  "reception",
  "storekeeper",
  "administration",
  "support",
  "management",
] as const;
export type Category = (typeof CATEGORIES)[number];

/** Catégories qui exigent une licence d'exercice en cours de validité pour être planifiées (A-VALIDER-RH, question Q30). */
const LICENSE_REQUIRED: readonly Category[] = [
  "physician",
  "nurse",
  "midwife",
  "pharmacist",
  "biologist",
];

type MemberStatus = "active" | "on_leave" | "suspended" | "left";

interface MemberRow {
  id: string;
  matricule: string;
  given_name: string;
  family_name: string;
  sex: "female" | "male" | null;
  birth_date: string | null;
  phone: string | null;
  email: string | null;
  category: Category;
  job_title: string;
  department_code: string | null;
  status: MemberStatus;
  hired_on: string;
  left_on: string | null;
  user_id: string | null;
}
const COLS = `id, matricule, given_name, family_name, sex, birth_date::text as birth_date, phone, email, category, job_title,
  department_code, status, hired_on::text as hired_on, left_on::text as left_on, user_id`;

/** Vue annuaire : visible de tout agent. Les données personnelles ne sortent que pour les ressources humaines. */
const directoryView = (r: MemberRow) => ({
  id: r.id,
  matricule: r.matricule,
  name: `${r.given_name} ${r.family_name}`,
  givenName: r.given_name,
  familyName: r.family_name,
  category: r.category,
  jobTitle: r.job_title,
  departmentCode: r.department_code,
  status: r.status,
});
const fullView = (r: MemberRow) => ({
  ...directoryView(r),
  sex: r.sex,
  birthDate: r.birth_date,
  phone: r.phone,
  email: r.email,
  hiredOn: r.hired_on,
  leftOn: r.left_on,
  userId: r.user_id,
});
const viewFor = (ctx: RequestContext, r: MemberRow) =>
  can(ctx.user.roles, "staff:manage") ? fullView(r) : directoryView(r);

async function lockMember(tx: Tx, id: string): Promise<MemberRow> {
  const res = await tx.query<MemberRow>(
    `select ${COLS} from staff.members where id = $1 for update`,
    [id],
  );
  if (!res.rows[0]) throw notFound("Agent");
  return res.rows[0];
}

async function requireDepartment(tx: Tx | Db, code: string): Promise<void> {
  const res = await tx.query("select 1 from catalog.departments where code = $1", [code]);
  if (!res.rowCount) throw new DomainError("unknown_department", `Service inconnu : ${code}.`, 400);
}

/* ------------------------------------------------------------------ registre */

export interface MemberInput {
  givenName: string;
  familyName: string;
  sex?: "female" | "male" | undefined;
  birthDate?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  category: Category;
  jobTitle: string;
  departmentCode?: string | undefined;
  hiredOn: string;
}

export async function createMember(db: Db, ctx: RequestContext, input: MemberInput) {
  return withTransaction(db, async (tx) => {
    if (input.departmentCode) await requireDepartment(tx, input.departmentCode);
    const matricule = await nextNumber(tx, "staff", "member", "M");
    const res = await tx.query<MemberRow>(
      `insert into staff.members (matricule, given_name, family_name, sex, birth_date, phone, email, category, job_title, department_code, hired_on, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning ${COLS}`,
      [
        matricule,
        input.givenName,
        input.familyName,
        input.sex ?? null,
        input.birthDate ?? null,
        input.phone ?? null,
        input.email ?? null,
        input.category,
        input.jobTitle,
        input.departmentCode ?? null,
        input.hiredOn,
        ctx.user.id,
      ],
    );
    const m = res.rows[0] as MemberRow;
    await writeAudit(tx, ctx, {
      action: "staff.create",
      entityType: "staff_member",
      entityId: m.id,
      detail: { matricule, category: m.category },
    });
    return fullView(m);
  });
}

export async function updateMember(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: { [K in keyof MemberInput]?: MemberInput[K] | undefined },
) {
  return withTransaction(db, async (tx) => {
    const m = await lockMember(tx, id);
    if (input.departmentCode) await requireDepartment(tx, input.departmentCode);
    const next = {
      given_name: input.givenName ?? m.given_name,
      family_name: input.familyName ?? m.family_name,
      sex: input.sex ?? m.sex,
      birth_date: input.birthDate ?? m.birth_date,
      phone: input.phone ?? m.phone,
      email: input.email ?? m.email,
      category: input.category ?? m.category,
      job_title: input.jobTitle ?? m.job_title,
      department_code: input.departmentCode ?? m.department_code,
      hired_on: input.hiredOn ?? m.hired_on,
    };
    const res = await tx.query<MemberRow>(
      `update staff.members set given_name = $2, family_name = $3, sex = $4, birth_date = $5, phone = $6, email = $7, category = $8,
         job_title = $9, department_code = $10, hired_on = $11 where id = $1 returning ${COLS}`,
      [
        id,
        next.given_name,
        next.family_name,
        next.sex,
        next.birth_date,
        next.phone,
        next.email,
        next.category,
        next.job_title,
        next.department_code,
        next.hired_on,
      ],
    );
    await writeAudit(tx, ctx, {
      action: "staff.update",
      entityType: "staff_member",
      entityId: id,
      detail: { fields: Object.keys(input) },
    });
    return fullView(res.rows[0] as MemberRow);
  });
}

export async function listMembers(
  db: Db,
  ctx: RequestContext,
  filter: {
    category?: string | undefined;
    department?: string | undefined;
    status?: string | undefined;
    q?: string | undefined;
  },
) {
  const res = await db.query<MemberRow>(
    `select ${COLS} from staff.members
      where ($1::text is null or category = $1) and ($2::text is null or department_code = $2)
        and ($3::text is null or status = $3)
        and ($4::text is null or lower(family_name || ' ' || given_name) like '%' || lower($4) || '%' or matricule ilike $4 || '%')
      order by family_name, given_name limit 300`,
    [
      filter.category ?? null,
      filter.department ?? null,
      filter.status ?? null,
      filter.q?.trim() || null,
    ],
  );
  return res.rows.map((r) => viewFor(ctx, r));
}

export async function getMember(db: Db, ctx: RequestContext, id: string) {
  const res = await db.query<MemberRow>(`select ${COLS} from staff.members where id = $1`, [id]);
  const m = res.rows[0];
  if (!m) throw notFound("Agent");
  const full = can(ctx.user.roles, "staff:manage");
  if (full) {
    await withTransaction(db, (tx) =>
      writeAudit(tx, ctx, { action: "staff.read", entityType: "staff_member", entityId: id }),
    );
    return { ...fullView(m), qualifications: await qualificationsOf(db, id) };
  }
  return directoryView(m);
}

/** Changement de situation. Un agent suspendu ou parti perd l'accès à tous les modules (compte désactivé) et ses gardes futures sont retirées. */
export async function setStatus(
  db: Db,
  ctx: RequestContext,
  id: string,
  input: { status: MemberStatus; effectiveOn: string; reason: string },
) {
  return withTransaction(db, async (tx) => {
    const m = await lockMember(tx, id);
    if (m.status === "left")
      throw new DomainError(
        "member_left",
        "Cet agent a quitté l'établissement : sa situation ne change plus.",
        409,
      );
    if (m.status === input.status)
      throw new DomainError("no_change", "L'agent est déjà dans cette situation.", 409);
    const leaving = input.status === "left";
    await tx.query("update staff.members set status = $2, left_on = $3 where id = $1", [
      id,
      input.status,
      leaving ? input.effectiveOn : null,
    ]);
    let removedShifts = 0;
    if (input.status === "suspended" || leaving) {
      const rm = await tx.query(
        "delete from staff.shifts where member_id = $1 and starts_at > now() and starts_at >= $2::date",
        [id, input.effectiveOn],
      );
      removedShifts = rm.rowCount ?? 0;
    }
    let account: "disabled" | "enabled" | null = null;
    if (m.user_id) {
      if (input.status === "suspended" || leaving) {
        await setAccountStatusIn(
          tx,
          ctx,
          m.user_id,
          "disable",
          `Situation de l'agent : ${input.status} (${input.reason})`,
        );
        account = "disabled";
      } else if (m.status === "suspended") {
        await setAccountStatusIn(tx, ctx, m.user_id, "enable", "fin de suspension");
        account = "enabled";
      }
    }
    await writeAudit(tx, ctx, {
      action: "staff.status",
      entityType: "staff_member",
      entityId: id,
      detail: {
        from: m.status,
        to: input.status,
        effectiveOn: input.effectiveOn,
        reason: input.reason,
        removedShifts,
        account,
      },
    });
    return { id, status: input.status, removedShifts, account, userId: m.user_id };
  });
}

/** Rattache un compte de connexion à l'agent (un compte pour un seul agent). */
export async function linkAccount(db: Db, ctx: RequestContext, id: string, userId: string) {
  return withTransaction(db, async (tx) => {
    const m = await lockMember(tx, id);
    const taken = await tx.query<{ id: string }>(
      "select id from staff.members where user_id = $1 and id <> $2",
      [userId, id],
    );
    if (taken.rowCount)
      throw new DomainError("account_taken", "Ce compte est déjà rattaché à un autre agent.", 409);
    await tx.query("update staff.members set user_id = $2 where id = $1", [id, userId]);
    if (m.status === "suspended" || m.status === "left")
      await setAccountStatusIn(tx, ctx, userId, "disable", `Situation de l'agent : ${m.status}`);
    await writeAudit(tx, ctx, {
      action: "staff.link",
      entityType: "staff_member",
      entityId: id,
      detail: { userId },
    });
    return { id, userId };
  });
}

/** Détache le compte de connexion de l'agent (remplacement, erreur de rattachement). Le compte lui-même n'est pas désactivé. */
export async function unlinkAccount(db: Db, ctx: RequestContext, id: string) {
  return withTransaction(db, async (tx) => {
    const m = await lockMember(tx, id);
    if (!m.user_id)
      throw new DomainError("no_account", "Aucun compte n'est rattaché à cet agent.", 409);
    await tx.query("update staff.members set user_id = null where id = $1", [id]);
    await writeAudit(tx, ctx, {
      action: "staff.unlink",
      entityType: "staff_member",
      entityId: id,
      detail: { userId: m.user_id },
    });
    return { id, userId: null, previousUserId: m.user_id };
  });
}

/* ------------------------------------------------------------------ qualifications */

export interface QualificationInput {
  kind: "diploma" | "license" | "certification";
  title: string;
  number?: string | undefined;
  issuer?: string | undefined;
  issuedOn?: string | undefined;
  expiresOn?: string | undefined;
}

async function qualificationsOf(db: Db | Tx, memberId: string) {
  const res = await db.query<{
    id: string;
    kind: string;
    title: string;
    number: string | null;
    issuer: string | null;
    issued_on: string | null;
    expires_on: string | null;
    revoked_at: Date | null;
  }>(
    `select id, kind, title, number, issuer, issued_on::text as issued_on, expires_on::text as expires_on, revoked_at from staff.qualifications where member_id = $1 order by kind, expires_on nulls last, id`,
    [memberId],
  );
  return res.rows.map((q) => ({
    id: Number(q.id),
    kind: q.kind,
    title: q.title,
    number: q.number,
    issuer: q.issuer,
    issuedOn: q.issued_on,
    expiresOn: q.expires_on,
    revoked: q.revoked_at !== null,
  }));
}

export async function addQualification(
  db: Db,
  ctx: RequestContext,
  memberId: string,
  input: QualificationInput,
) {
  return withTransaction(db, async (tx) => {
    await lockMember(tx, memberId);
    if (input.expiresOn && input.issuedOn && input.expiresOn < input.issuedOn)
      throw new DomainError("bad_dates", "L'expiration précède la délivrance.", 400);
    const res = await tx.query<{ id: string }>(
      `insert into staff.qualifications (member_id, kind, title, number, issuer, issued_on, expires_on, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
      [
        memberId,
        input.kind,
        input.title,
        input.number ?? null,
        input.issuer ?? null,
        input.issuedOn ?? null,
        input.expiresOn ?? null,
        ctx.user.id,
      ],
    );
    await writeAudit(tx, ctx, {
      action: "staff.qualification",
      entityType: "staff_member",
      entityId: memberId,
      detail: { kind: input.kind, title: input.title, expiresOn: input.expiresOn ?? null },
    });
    return { id: Number(res.rows[0]?.id), ...input };
  });
}

export async function revokeQualification(
  db: Db,
  ctx: RequestContext,
  qualificationId: number,
  reason: string,
) {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<{ member_id: string; revoked_at: Date | null }>(
      "select member_id, revoked_at from staff.qualifications where id = $1 for update",
      [qualificationId],
    );
    const q = res.rows[0];
    if (!q) throw notFound("Qualification");
    if (q.revoked_at)
      throw new DomainError("already_revoked", "Cette qualification est déjà retirée.", 409);
    await tx.query(
      "update staff.qualifications set revoked_at = now(), revoked_reason = $2 where id = $1",
      [qualificationId, reason],
    );
    await writeAudit(tx, ctx, {
      action: "staff.qualification.revoke",
      entityType: "staff_member",
      entityId: q.member_id,
      detail: { qualificationId, reason },
    });
    return { id: qualificationId, revoked: true };
  });
}

/** Licences et certifications qui expirent bientôt (ou déjà expirées) : à renouveler avant de planifier. */
export async function expiringQualifications(db: Db, days: number) {
  const limit = new Date(Date.now() + days * 86_400_000 + 3 * 3600_000).toISOString().slice(0, 10);
  const res = await db.query<{
    id: string;
    member_id: string;
    name: string;
    kind: string;
    title: string;
    expires_on: string;
  }>(
    `select q.id, q.member_id, m.given_name || ' ' || m.family_name as name, q.kind, q.title, q.expires_on::text as expires_on
       from staff.qualifications q join staff.members m on m.id = q.member_id
      where q.revoked_at is null and q.expires_on is not null and q.expires_on <= $1::date and m.status in ('active', 'on_leave')
      order by q.expires_on, name`,
    [limit],
  );
  const today = localDate(new Date());
  return res.rows.map((r) => ({
    id: Number(r.id),
    memberId: r.member_id,
    name: r.name,
    kind: r.kind,
    title: r.title,
    expiresOn: r.expires_on,
    expired: r.expires_on < today,
  }));
}

async function licenseValidOn(tx: Tx, memberId: string, date: string): Promise<boolean> {
  const res = await tx.query(
    `select 1 from staff.qualifications where member_id = $1 and kind = 'license' and revoked_at is null
        and (issued_on is null or issued_on <= $2::date) and (expires_on is null or expires_on >= $2::date) limit 1`,
    [memberId, date],
  );
  return (res.rowCount ?? 0) > 0;
}

/* ------------------------------------------------------------------ planning de garde */

export interface ShiftInput {
  memberId: string;
  departmentCode: string;
  kind: "day" | "night" | "on_call";
  startsAt: string;
  endsAt: string;
}

async function minRestHours(tx: Tx): Promise<number> {
  const r = await tx.query<{ value: string }>(
    "select value from staff.settings where key = 'min_rest_hours'",
  );
  return Number(r.rows[0]?.value ?? 0);
}

/**
 * Création d'une garde. Refusée si l'agent n'est pas en activité, si sa licence d'exercice n'est pas valide ce jour-là,
 * s'il est en congé approuvé, s'il est déjà de garde, ou si le repos minimal entre deux gardes n'est pas respecté.
 */
export async function createShift(db: Db, ctx: RequestContext, input: ShiftInput) {
  return withTransaction(db, async (tx) => {
    const m = await lockMember(tx, input.memberId);
    await requireDepartment(tx, input.departmentCode);
    if (m.status !== "active")
      throw new DomainError(
        "member_not_active",
        `Cet agent n'est pas en activité (${m.status}) : il ne peut pas être planifié.`,
        409,
      );
    if (new Date(input.endsAt).getTime() - new Date(input.startsAt).getTime() > 26 * 3600_000)
      throw new DomainError("shift_too_long", "Une garde ne dépasse pas 26 heures.", 400);
    const startDate = localDate(new Date(input.startsAt));
    const endDate = localDate(new Date(input.endsAt));
    if (LICENSE_REQUIRED.includes(m.category))
      for (const d of new Set([startDate, endDate]))
        if (!(await licenseValidOn(tx, m.id, d)))
          throw new DomainError(
            "license_invalid",
            `Licence d'exercice absente, retirée ou expirée le ${d} : planification refusée.`,
            409,
            { date: d },
          );
    const leave = await tx.query<{ id: string; starts_on: string; ends_on: string }>(
      `select id, starts_on::text as starts_on, ends_on::text as ends_on from staff.leaves
        where member_id = $1 and status = 'approved' and starts_on <= $3::date and ends_on >= $2::date limit 1`,
      [m.id, startDate, endDate],
    );
    if (leave.rows[0])
      throw new DomainError(
        "on_leave",
        `Congé approuvé du ${leave.rows[0].starts_on} au ${leave.rows[0].ends_on} : planification refusée.`,
        409,
        { leaveId: leave.rows[0].id },
      );
    const rest = await minRestHours(tx);
    const near = await tx.query<{ id: string; starts_at: Date; ends_at: Date }>(
      `select id, starts_at, ends_at from staff.shifts where member_id = $1
         and starts_at < $3::timestamptz + make_interval(hours => $4) and ends_at > $2::timestamptz - make_interval(hours => $4) limit 1`,
      [m.id, input.startsAt, input.endsAt, rest],
    );
    if (near.rows[0]) {
      const o = near.rows[0];
      const overlaps = o.starts_at < new Date(input.endsAt) && o.ends_at > new Date(input.startsAt);
      throw new DomainError(
        overlaps ? "shift_overlap" : "rest_violation",
        overlaps
          ? "L'agent est déjà de garde sur ce créneau."
          : `Repos minimal de ${rest} h entre deux gardes non respecté.`,
        409,
        { conflictingShiftId: o.id, minRestHours: rest },
      );
    }
    let id: string;
    try {
      const res = await tx.query<{ id: string }>(
        `insert into staff.shifts (member_id, department_code, kind, starts_at, ends_at, created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
        [m.id, input.departmentCode, input.kind, input.startsAt, input.endsAt, ctx.user.id],
      );
      id = (res.rows[0] as { id: string }).id;
    } catch (e) {
      if ((e as { code?: string }).code === "23P01")
        throw new DomainError("shift_overlap", "L'agent est déjà de garde sur ce créneau.", 409);
      throw e;
    }
    await writeAudit(tx, ctx, {
      action: "staff.shift",
      entityType: "staff_member",
      entityId: m.id,
      detail: {
        shiftId: id,
        department: input.departmentCode,
        kind: input.kind,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
      },
    });
    return { id, ...input };
  });
}

export async function deleteShift(db: Db, ctx: RequestContext, shiftId: string) {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<{ member_id: string; starts_at: Date }>(
      "select member_id, starts_at from staff.shifts where id = $1 for update",
      [shiftId],
    );
    const s = res.rows[0];
    if (!s) throw notFound("Garde");
    if (s.starts_at <= new Date())
      throw new DomainError(
        "shift_started",
        "Cette garde est commencée ou passée : elle ne se supprime plus.",
        409,
      );
    await tx.query("delete from staff.shifts where id = $1", [shiftId]);
    await writeAudit(tx, ctx, {
      action: "staff.shift.delete",
      entityType: "staff_member",
      entityId: s.member_id,
      detail: { shiftId },
    });
    return { id: shiftId, deleted: true };
  });
}

interface ShiftRow {
  id: string;
  member_id: string;
  name: string;
  category: Category;
  department_code: string;
  kind: string;
  starts_at: Date;
  ends_at: Date;
}
const shiftView = (r: ShiftRow) => ({
  id: r.id,
  memberId: r.member_id,
  name: r.name,
  category: r.category,
  departmentCode: r.department_code,
  kind: r.kind,
  startsAt: r.starts_at.toISOString(),
  endsAt: r.ends_at.toISOString(),
});

export async function listShifts(
  db: Db,
  filter: {
    from: string;
    to: string;
    department?: string | undefined;
    memberId?: string | undefined;
  },
) {
  const res = await db.query<ShiftRow>(
    `select s.id, s.member_id, m.given_name || ' ' || m.family_name as name, m.category, s.department_code, s.kind, s.starts_at, s.ends_at
       from staff.shifts s join staff.members m on m.id = s.member_id
      where s.starts_at < $2::timestamptz and s.ends_at > $1::timestamptz
        and ($3::text is null or s.department_code = $3) and ($4::uuid is null or s.member_id = $4)
      order by s.starts_at, name limit 1000`,
    [filter.from, filter.to, filter.department ?? null, filter.memberId ?? null],
  );
  return res.rows.map(shiftView);
}

/** Qui est de garde maintenant (ou à un instant donné), par service. */
export async function onDuty(db: Db, department?: string, at: Date = new Date()) {
  const res = await db.query<ShiftRow>(
    `select s.id, s.member_id, m.given_name || ' ' || m.family_name as name, m.category, s.department_code, s.kind, s.starts_at, s.ends_at
       from staff.shifts s join staff.members m on m.id = s.member_id
      where s.starts_at <= $1::timestamptz and s.ends_at > $1::timestamptz and m.status = 'active'
        and ($2::text is null or s.department_code = $2) order by s.department_code, m.family_name`,
    [at.toISOString(), department ?? null],
  );
  return res.rows.map(shiftView);
}

/* ------------------------------------------------------------------ congés */

export interface LeaveInput {
  kind: "annual" | "sick" | "maternity" | "unpaid" | "other";
  startsOn: string;
  endsOn: string;
  reason?: string | undefined;
}

async function memberOfUser(tx: Tx | Db, userId: string): Promise<MemberRow> {
  const res = await tx.query<MemberRow>(`select ${COLS} from staff.members where user_id = $1`, [
    userId,
  ]);
  if (!res.rows[0])
    throw new DomainError(
      "no_staff_record",
      "Aucune fiche d'agent n'est rattachée à votre compte : voyez les ressources humaines.",
      404,
    );
  return res.rows[0];
}

export async function requestLeave(db: Db, ctx: RequestContext, input: LeaveInput) {
  return withTransaction(db, async (tx) => {
    const m = await memberOfUser(tx, ctx.user.id);
    if (m.status === "left" || m.status === "suspended")
      throw new DomainError(
        "member_not_active",
        "Votre situation ne permet pas de demander un congé.",
        409,
      );
    if (input.endsOn < input.startsOn)
      throw new DomainError("bad_dates", "La fin précède le début.", 400);
    const overlap = await tx.query(
      "select 1 from staff.leaves where member_id = $1 and status in ('requested', 'approved') and starts_on <= $3::date and ends_on >= $2::date",
      [m.id, input.startsOn, input.endsOn],
    );
    if (overlap.rowCount)
      throw new DomainError(
        "leave_overlap",
        "Un congé demandé ou approuvé couvre déjà une partie de cette période.",
        409,
      );
    const res = await tx.query<{ id: string }>(
      "insert into staff.leaves (member_id, kind, starts_on, ends_on, reason, requested_by) values ($1, $2, $3, $4, $5, $6) returning id",
      [m.id, input.kind, input.startsOn, input.endsOn, input.reason ?? null, ctx.user.id],
    );
    const id = (res.rows[0] as { id: string }).id;
    await writeAudit(tx, ctx, {
      action: "leave.request",
      entityType: "staff_member",
      entityId: m.id,
      detail: { leaveId: id, kind: input.kind, startsOn: input.startsOn, endsOn: input.endsOn },
    });
    return { id, status: "requested", ...input };
  });
}

interface LeaveRow {
  id: string;
  member_id: string;
  name: string;
  kind: string;
  starts_on: string;
  ends_on: string;
  status: string;
  reason: string | null;
  decided_by: string | null;
  decision_note: string | null;
}
const leaveView = (r: LeaveRow) => ({
  id: r.id,
  memberId: r.member_id,
  name: r.name,
  kind: r.kind,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  status: r.status,
  reason: r.reason,
  decidedBy: r.decided_by,
  decisionNote: r.decision_note,
});
const LEAVE_SQL = `select l.id, l.member_id, m.given_name || ' ' || m.family_name as name, l.kind, l.starts_on::text as starts_on, l.ends_on::text as ends_on,
  l.status, l.reason, l.decided_by, l.decision_note from staff.leaves l join staff.members m on m.id = l.member_id`;

export async function listLeaves(
  db: Db,
  filter: { status?: string | undefined; memberId?: string | undefined },
) {
  const res = await db.query<LeaveRow>(
    `${LEAVE_SQL} where ($1::text is null or l.status = $1) and ($2::uuid is null or l.member_id = $2) order by l.starts_on desc limit 300`,
    [filter.status ?? null, filter.memberId ?? null],
  );
  return res.rows.map(leaveView);
}

export async function decideLeave(
  db: Db,
  ctx: RequestContext,
  leaveId: string,
  input: { approve: boolean; note: string },
) {
  return withTransaction(db, async (tx) => {
    const res = await tx.query<{
      member_id: string;
      status: string;
      starts_on: string;
      ends_on: string;
      requested_by: string;
    }>(
      "select member_id, status, starts_on::text as starts_on, ends_on::text as ends_on, requested_by from staff.leaves where id = $1 for update",
      [leaveId],
    );
    const l = res.rows[0];
    if (!l) throw notFound("Congé");
    if (l.status !== "requested")
      throw new DomainError("already_decided", "Cette demande a déjà reçu une décision.", 409);
    if (l.requested_by === ctx.user.id)
      throw new DomainError(
        "cannot_decide_own",
        "Vous ne pouvez pas décider de votre propre demande de congé.",
        403,
      );
    if (input.approve) {
      // Des gardes sur la période doivent être retirées ou réaffectées d'abord : le congé ne laisse pas de service sans personne.
      const shifts = await tx.query<{ id: string; department_code: string; starts_at: Date }>(
        `select id, department_code, starts_at from staff.shifts where member_id = $1
            and (starts_at at time zone 'UTC' + interval '3 hours')::date between $2::date and $3::date order by starts_at`,
        [l.member_id, l.starts_on, l.ends_on],
      );
      if (shifts.rowCount)
        throw new DomainError(
          "shifts_in_period",
          "Des gardes sont planifiées pendant ce congé : retirez-les ou réaffectez-les d'abord.",
          409,
          {
            shifts: shifts.rows.map((s) => ({
              id: s.id,
              departmentCode: s.department_code,
              startsAt: s.starts_at.toISOString(),
            })),
          },
        );
    }
    await tx.query(
      "update staff.leaves set status = $2, decided_by = $3, decided_at = now(), decision_note = $4 where id = $1",
      [leaveId, input.approve ? "approved" : "rejected", ctx.user.id, input.note],
    );
    await writeAudit(tx, ctx, {
      action: input.approve ? "leave.approve" : "leave.reject",
      entityType: "staff_member",
      entityId: l.member_id,
      detail: { leaveId, note: input.note },
    });
    return { id: leaveId, status: input.approve ? "approved" : "rejected" };
  });
}

/** L'agent annule sa propre demande tant que le congé n'a pas commencé. */
export async function cancelLeave(db: Db, ctx: RequestContext, leaveId: string) {
  return withTransaction(db, async (tx) => {
    const m = await memberOfUser(tx, ctx.user.id);
    const res = await tx.query<{ status: string; starts_on: string }>(
      "select status, starts_on::text as starts_on from staff.leaves where id = $1 and member_id = $2 for update",
      [leaveId, m.id],
    );
    const l = res.rows[0];
    if (!l) throw notFound("Congé");
    if (l.status !== "requested" && l.status !== "approved")
      throw new DomainError("not_cancellable", "Ce congé ne peut plus être annulé.", 409);
    if (l.starts_on <= localDate(new Date()))
      throw new DomainError(
        "leave_started",
        "Le congé a commencé : voyez les ressources humaines.",
        409,
      );
    await tx.query("update staff.leaves set status = 'cancelled' where id = $1", [leaveId]);
    await writeAudit(tx, ctx, {
      action: "leave.cancel",
      entityType: "staff_member",
      entityId: m.id,
      detail: { leaveId },
    });
    return { id: leaveId, status: "cancelled" };
  });
}

/** Ma fiche, mes prochaines gardes et mes congés. */
export async function myRecord(db: Db, ctx: RequestContext) {
  const m = await memberOfUser(db, ctx.user.id);
  const now = new Date();
  const shifts = await listShifts(db, {
    from: now.toISOString(),
    to: new Date(now.getTime() + 60 * 86_400_000).toISOString(),
    memberId: m.id,
  });
  const leaves = await listLeaves(db, { memberId: m.id });
  return { member: fullView(m), shifts, leaves, qualifications: await qualificationsOf(db, m.id) };
}

/* ------------------------------------------------------------------ effectifs (tableau de bord) */

export async function headcount(db: Db, day: string) {
  const byCat = await db.query<{ category: string; n: string }>(
    "select category, count(*) as n from staff.members where status = 'active' group by category order by category",
  );
  const leave = await db.query<{ n: string }>(
    "select count(distinct member_id) as n from staff.leaves where status = 'approved' and starts_on <= $1::date and ends_on >= $1::date",
    [day],
  );
  const duty = await db.query<{ department_code: string; n: string }>(
    "select s.department_code, count(*) as n from staff.shifts s where s.starts_at <= now() and s.ends_at > now() group by s.department_code order by s.department_code",
  );
  const expiring = await db.query<{ n: string }>(
    "select count(*) as n from staff.qualifications q join staff.members m on m.id = q.member_id where q.revoked_at is null and q.expires_on is not null and q.expires_on <= ($1::date + 90) and m.status in ('active', 'on_leave')",
    [day],
  );
  return {
    active: byCat.rows.reduce((n, r) => n + Number(r.n), 0),
    byCategory: Object.fromEntries(byCat.rows.map((r) => [r.category, Number(r.n)])),
    onLeaveToday: Number(leave.rows[0]?.n ?? 0),
    onDutyNow: Object.fromEntries(duty.rows.map((r) => [r.department_code, Number(r.n)])),
    qualificationsExpiring: Number(expiring.rows[0]?.n ?? 0),
  };
}

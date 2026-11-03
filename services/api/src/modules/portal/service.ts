import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { writeAudit, type RequestContext } from "../../audit/audit.ts";
import { withTransaction, type Db, type Tx } from "../../db.ts";
import { DomainError, notFound } from "../../errors.ts";
import {
  cancelAppointment,
  bookAppointment,
  listAppointments,
  type Appointment,
} from "../appointments/service.ts";
import type { NotificationProvider } from "../appointments/reminders.ts";
import { listPractitioners, slotsFor } from "../appointments/schedule.ts";
import { listInvoices } from "../billing/service.ts";
import {
  findActiveByIdentifier,
  getReminderContact,
  patientSummaries,
  relatedPatientIds,
} from "../identity/interface.ts";
import { patientResults } from "../lab/service.ts";

export const OTP_VALID_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_PER_PATIENT_PER_HOUR = 3;
export const REQUESTS_PER_IP_PER_HOUR = 20;
export const SESSION_MINUTES = 30;
export const MAX_ACTIVE_APPOINTMENTS = 3;
export const MIN_CANCEL_HOURS = 2;
const AUDIENCE = "chu-patient";
const ISSUER = "chu-portal";

export interface PortalConfig {
  provider: NotificationProvider;
  /** Clé de signature des sessions (32 octets au moins). Absente : portail désactivé. */
  secret: Uint8Array | null;
  resultDelayHours: number;
}

export function portalConfigFromEnv(
  env: NodeJS.ProcessEnv,
  provider: NotificationProvider,
): PortalConfig {
  const raw = env.PORTAL_JWT_SECRET;
  if (raw !== undefined && raw.length < 32)
    throw new Error("PORTAL_JWT_SECRET doit faire 32 caractères au moins");
  return {
    provider,
    secret: raw ? new TextEncoder().encode(raw) : null,
    resultDelayHours: Number(env.PORTAL_RESULT_DELAY_HOURS ?? 24),
  };
}

const tooMany = () =>
  new DomainError("too_many_requests", "Trop de demandes. Réessayez plus tard.", 429);
const invalidCode = () =>
  new DomainError("invalid_code", "Code ou numéro de dossier incorrect, ou code expiré.", 401);

const hashCode = (salt: string, code: string): Buffer =>
  createHash("sha256").update(`${salt}:${code}`).digest();

async function countRecent(db: Db | Tx, kind: string, ip: string, now: Date): Promise<number> {
  const r = await db.query<{ n: number }>(
    "select count(*)::int n from portal.request_log where kind = $1 and ip = $2 and at > $3::timestamptz - interval '1 hour'",
    [kind, ip, now],
  );
  return r.rows[0]?.n ?? 0;
}

/**
 * Demande d'un code de connexion. La réponse est TOUJOURS la même (numéro de dossier connu ou non, téléphone présent ou
 * non, limite atteinte ou non) : on ne peut pas s'en servir pour deviner quels dossiers existent. L'envoi du SMS n'est
 * pas attendu, pour que le temps de réponse ne révèle rien non plus.
 */
export async function requestOtp(
  db: Db,
  cfg: PortalConfig,
  input: { identifier: string; ip: string },
  now: Date = new Date(),
): Promise<void> {
  if (!cfg.secret)
    throw new DomainError("portal_disabled", "Le portail patient n'est pas activé.", 503);
  if ((await countRecent(db, "otp_request", input.ip, now)) >= REQUESTS_PER_IP_PER_HOUR)
    throw tooMany();
  await db.query("insert into portal.request_log (kind, ip, at) values ('otp_request', $1, $2)", [
    input.ip,
    now,
  ]);
  const patient = await findActiveByIdentifier(db, input.identifier.trim());
  if (!patient) return;
  const contact = await getReminderContact(db, patient.id);
  if (!contact?.phone) return;
  const recent = await db.query<{ n: number }>(
    "select count(*)::int n from portal.otp_challenges where patient_id = $1 and created_at > $2::timestamptz - interval '1 hour'",
    [patient.id, now],
  );
  if ((recent.rows[0]?.n ?? 0) >= OTP_PER_PATIENT_PER_HOUR) return;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = randomBytes(16).toString("hex");
  await db.query(
    "insert into portal.otp_challenges (patient_id, salt, code_hash, created_at, expires_at) values ($1, $2, $3, $4, $5)",
    [
      patient.id,
      salt,
      hashCode(salt, code).toString("hex"),
      now,
      new Date(now.getTime() + OTP_VALID_MINUTES * 60_000),
    ],
  );
  const text = `CHU Djibouti : votre code de connexion est ${code}. Valable ${OTP_VALID_MINUTES} minutes. Ne le communiquez à personne. | رمز الدخول الخاص بك ${code}. صالح لمدة ${OTP_VALID_MINUTES} دقائق. لا تشاركه مع أحد.`;
  void cfg.provider.send({ to: contact.phone, text }).catch(() => {
    // Échec d'envoi : le patient redemandera un code ; rien à révéler ici.
  });
}

export async function verifyOtp(
  db: Db,
  cfg: PortalConfig,
  input: { identifier: string; code: string; ip: string },
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: string }> {
  if (!cfg.secret)
    throw new DomainError("portal_disabled", "Le portail patient n'est pas activé.", 503);
  if ((await countRecent(db, "otp_verify", input.ip, now)) >= REQUESTS_PER_IP_PER_HOUR * 2)
    throw tooMany();
  await db.query("insert into portal.request_log (kind, ip, at) values ('otp_verify', $1, $2)", [
    input.ip,
    now,
  ]);
  const patient = await findActiveByIdentifier(db, input.identifier.trim());
  if (!patient) throw invalidCode();
  const secret = cfg.secret;
  return withTransaction(db, async (tx) => {
    const ch = await tx.query<{
      id: string;
      salt: string;
      code_hash: string;
      attempts: number;
    }>(
      `select id, salt, code_hash, attempts from portal.otp_challenges
        where patient_id = $1 and consumed_at is null and expires_at > $2
        order by created_at desc limit 1 for update`,
      [patient.id, now],
    );
    const c = ch.rows[0];
    if (!c) throw invalidCode();
    const given = hashCode(c.salt, input.code.trim());
    const good = timingSafeEqual(given, Buffer.from(c.code_hash, "hex"));
    if (!good) {
      // La tentative est comptée même si la transaction est ensuite abandonnée : on ne lève l'erreur qu'après le commit.
      await tx.query(
        "update portal.otp_challenges set attempts = attempts + 1, consumed_at = case when attempts + 1 >= $2 then $3::timestamptz else null end where id = $1",
        [c.id, OTP_MAX_ATTEMPTS, now],
      );
      return { token: "", expiresAt: "" };
    }
    await tx.query("update portal.otp_challenges set consumed_at = $2 where id = $1", [c.id, now]);
    const expires = new Date(now.getTime() + SESSION_MINUTES * 60_000);
    const s = await tx.query<{ id: string }>(
      "insert into portal.sessions (patient_id, created_at, expires_at) values ($1, $2, $3) returning id",
      [patient.id, now, expires],
    );
    const sid = (s.rows[0] as { id: string }).id;
    await writeAudit(tx, patientCtx(patient.id, "portal"), {
      action: "portal.login",
      entityType: "patient",
      entityId: patient.id,
      patientId: patient.id,
    });
    const token = await new SignJWT({ sid })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(patient.id)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(now.getTime() / 1000))
      .setExpirationTime(Math.floor(expires.getTime() / 1000))
      .sign(secret);
    return { token, expiresAt: expires.toISOString() };
  }).then((r) => {
    if (r.token === "") throw invalidCode();
    return r;
  });
}

export interface PatientSession {
  patientId: string;
  sid: string;
}

/** Session valide : signature, audience, non expirée, non révoquée, dossier toujours actif. */
export async function authenticatePatient(
  db: Db,
  cfg: PortalConfig,
  token: string,
  now: Date = new Date(),
): Promise<PatientSession> {
  const denied = () =>
    new DomainError("unauthenticated", "Session invalide ou expirée. Reconnectez-vous.", 401);
  if (!cfg.secret)
    throw new DomainError("portal_disabled", "Le portail patient n'est pas activé.", 503);
  let sub: string;
  let sid: string;
  try {
    const { payload } = await jwtVerify(token, cfg.secret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
      currentDate: now,
    });
    sub = String(payload.sub);
    sid = String(payload.sid);
  } catch {
    throw denied();
  }
  const row = await db.query(
    "select 1 from portal.sessions where id = $1 and patient_id = $2 and revoked_at is null and expires_at > $3",
    [sid, sub, now],
  );
  if (!row.rowCount) throw denied();
  const summary = (await patientSummaries(db, [sub])).get(sub);
  if (!summary || summary.id !== sub) throw denied(); // dossier fusionné : se reconnecter avec le dossier conservé
  return { patientId: sub, sid };
}

export const patientCtx = (patientId: string, requestId: string): RequestContext => ({
  user: { id: `patient:${patientId}`, name: "Patient (portail)", roles: [] },
  requestId,
});

export async function logout(db: Db, session: PatientSession): Promise<void> {
  await db.query("update portal.sessions set revoked_at = now() where id = $1", [session.sid]);
}

/* ------------------------------------------------------------------ données du patient connecté */

export async function profile(db: Db, s: PatientSession) {
  const p = (await patientSummaries(db, [s.patientId])).get(s.patientId);
  if (!p) throw notFound("Dossier");
  return { name: p.name, identifier: p.identifier, birthDate: p.birthDate };
}

const mineView = (a: Appointment) => ({
  id: a.id,
  startsAt: a.startsAt,
  endsAt: a.endsAt,
  status: a.status,
  practitionerId: a.practitionerId,
  departmentCode: a.departmentCode,
});

export async function myAppointments(db: Db, s: PatientSession) {
  const all = await listAppointments(db, { patientId: s.patientId });
  const names = new Map((await listPractitioners(db)).map((p) => [p.id, p.displayName]));
  return all
    .filter((a) => a.status !== "cancelled")
    .slice(-30)
    .map((a) => ({ ...mineView(a), practitionerName: names.get(a.practitionerId) ?? null }));
}

export async function bookable(db: Db) {
  return (await listPractitioners(db, "CONS"))
    .filter((p) => p.active)
    .map((p) => ({ id: p.id, name: p.displayName }));
}

export const freeSlots = async (db: Db, practitionerId: string, date: string) =>
  (await slotsFor(db, practitionerId, date)).filter((x) => x.status === "free");

export async function bookMine(
  db: Db,
  s: PatientSession,
  input: { practitionerId: string; startsAt: Date },
  requestId: string,
) {
  const mine = await listAppointments(db, { patientId: s.patientId, status: "booked" });
  if (mine.length >= MAX_ACTIVE_APPOINTMENTS)
    throw new DomainError(
      "too_many_appointments",
      `Vous avez déjà ${MAX_ACTIVE_APPOINTMENTS} rendez-vous à venir. Annulez-en un ou contactez l'accueil.`,
      409,
    );
  const a = await bookAppointment(db, patientCtx(s.patientId, requestId), {
    patientId: s.patientId,
    practitionerId: input.practitionerId,
    startsAt: input.startsAt,
    reason: "Pris par le patient (portail)",
  });
  return mineView(a);
}

export async function cancelMine(
  db: Db,
  s: PatientSession,
  id: string,
  requestId: string,
  now: Date = new Date(),
) {
  const family = await relatedPatientIds(db, s.patientId);
  const found = (await listAppointments(db, { patientId: s.patientId })).find((a) => a.id === id);
  if (!found || !family.includes(found.patientId)) throw notFound("Rendez-vous"); // jamais celui d'un autre
  if (new Date(found.startsAt).getTime() - now.getTime() < MIN_CANCEL_HOURS * 3_600_000)
    throw new DomainError(
      "too_late_to_cancel",
      `Un rendez-vous ne peut plus être annulé moins de ${MIN_CANCEL_HOURS} heures avant : contactez l'accueil.`,
      409,
    );
  return mineView(
    await cancelAppointment(
      db,
      patientCtx(s.patientId, requestId),
      id,
      "Annulé par le patient (portail)",
    ),
  );
}

/**
 * Résultats de laboratoire : seulement ceux validés par un biologiste ET validés depuis plus de `resultDelayHours`
 * (le médecin a le temps de les voir et d'appeler le patient d'abord). Une valeur critique n'est JAMAIS affichée : le
 * patient est invité à contacter son médecin.
 */
export async function myResults(
  db: Db,
  cfg: PortalConfig,
  s: PatientSession,
  requestId: string,
  now = new Date(),
) {
  const all = await patientResults(db, patientCtx(s.patientId, requestId), s.patientId);
  const cutoff = now.getTime() - cfg.resultDelayHours * 3_600_000;
  const ready = all.filter((r) => r.validatedAt && new Date(r.validatedAt).getTime() <= cutoff);
  const withheld = ready.filter((r) => r.flag.startsWith("critical")).length;
  return {
    results: ready
      .filter((r) => !r.flag.startsWith("critical"))
      .map((r) => ({
        requestNumber: r.requestNumber,
        labelFr: r.labelFr,
        labelAr: r.labelAr,
        value: r.value,
        unit: r.unit,
        flag: r.flag,
        refLow: r.refLow,
        refHigh: r.refHigh,
        validatedAt: r.validatedAt,
      })),
    withheld,
    pendingCount: all.length - ready.length,
  };
}

export async function myInvoices(db: Db, s: PatientSession, requestId: string) {
  const list = await listInvoices(db, { patientId: s.patientId, limit: 50 });
  await writeAudit(db as unknown as Tx, patientCtx(s.patientId, requestId), {
    action: "portal.invoices.read",
    entityType: "patient",
    entityId: s.patientId,
    patientId: s.patientId,
  });
  return list.map((i) => ({
    number: i.number,
    issuedAt: i.issuedAt,
    status: i.status,
    total: i.total,
    patientAmount: i.patientAmount,
    amountDue: i.amountDue,
    paidAt: i.paidAt,
  }));
}

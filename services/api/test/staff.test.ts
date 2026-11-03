import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import { makeCaller, type Caller } from "./support/scenario.ts";

let db: TestDatabase;
let t: TestApp;
let call: Caller;
const HR = "rh-1";
const HR2 = "rh-2";

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
});
after(async () => {
  await t.close();
  await db.drop();
});

const day = (n: number): string =>
  new Date(Date.now() + 3 * 3600_000 + n * 86_400_000).toISOString().slice(0, 10);
/** Instant local (Djibouti, UTC+3) du jour décalé de `n` jours à l'heure `h`. */
const at = (n: number, h: number): string => `${day(n)}T${String(h).padStart(2, "0")}:00:00+03:00`;

const member = (over: Record<string, unknown> = {}) => ({
  givenName: "Fatouma",
  familyName: "Essai",
  sex: "female",
  birthDate: "1988-06-01",
  phone: "+25377123456",
  email: "f.essai@chu.invalid",
  category: "physician",
  jobTitle: "Médecin généraliste",
  departmentCode: "CONS",
  hiredOn: "2020-01-15",
  ...over,
});
async function create(over: Record<string, unknown> = {}) {
  const res = await call("hr", "POST", "/api/staff", member(over), HR);
  assert.equal(res.status, 201, res.raw);
  return res.body as { id: string; matricule: string };
}
async function license(id: string, expiresOn?: string) {
  const res = await call(
    "hr",
    "POST",
    `/api/staff/${id}/qualifications`,
    {
      kind: "license",
      title: "Licence d'exercice (exemple de test)",
      number: "L-123",
      ...(expiresOn ? { expiresOn } : {}),
    },
    HR,
  );
  assert.equal(res.status, 201, res.raw);
  return res.body.id as number;
}
const shift = (
  memberId: string,
  startsAt: string,
  endsAt: string,
  over: Record<string, unknown> = {},
) =>
  call(
    "hr",
    "POST",
    "/api/staff/shifts",
    { memberId, departmentCode: "CONS", kind: "day", startsAt, endsAt, ...over },
    HR,
  );

test("registre : matricule continu ; données personnelles réservées aux ressources humaines, annuaire pour les autres", async () => {
  const a = await create();
  const b = await create({
    givenName: "Ali",
    familyName: "Autre",
    category: "nurse",
    jobTitle: "Infirmier",
    departmentCode: "HOSP",
  });
  assert.match(a.matricule, /^M-\d{6}$/);
  assert.equal(Number(b.matricule.slice(2)), Number(a.matricule.slice(2)) + 1);

  const hr = await call("hr", "GET", `/api/staff/${a.id}`, undefined, HR);
  assert.equal(hr.body.birthDate, "1988-06-01");
  assert.equal(hr.body.phone, "+25377123456");
  const dir = await call("nurse", "GET", `/api/staff/${a.id}`);
  assert.equal(dir.status, 200);
  assert.deepEqual(
    [dir.body.name, dir.body.jobTitle, dir.body.birthDate, dir.body.phone, dir.body.email],
    ["Fatouma Essai", "Médecin généraliste", undefined, undefined, undefined],
  );
  const list = await call("cashier", "GET", "/api/staff?q=essai");
  assert.equal(list.body.staff.length, 1);
  assert.equal(list.body.staff[0].phone, undefined);
  assert.equal(
    (await call("hr", "GET", "/api/staff?category=nurse", undefined, HR)).body.staff.length,
    1,
  );

  assert.equal(
    (await call("direction", "GET", "/api/staff")).status,
    403,
    "la direction ne voit que des chiffres",
  );
  assert.equal((await call("admin", "POST", "/api/staff", member())).status, 403);
  assert.equal((await call("doctor", "PUT", `/api/staff/${a.id}`, { phone: "000" })).status, 403);
  assert.equal(
    (await call("hr", "POST", "/api/staff", member({ category: "pirate" }), HR)).status,
    400,
  );
  assert.equal(
    (await call("hr", "POST", "/api/staff", member({ departmentCode: "NOPE" }), HR)).body.error
      .code,
    "unknown_department",
  );
  const up = await call(
    "hr",
    "PUT",
    `/api/staff/${a.id}`,
    { jobTitle: "Médecin chef de service", phone: "+25377999999" },
    HR,
  );
  assert.deepEqual(
    [up.body.jobTitle, up.body.phone, up.body.familyName],
    ["Médecin chef de service", "+25377999999", "Essai"],
  );
  assert.equal(
    (await call("hr", "PUT", `/api/staff/${a.id}`, {}, HR)).body.error.code,
    "empty_update",
  );
  assert.ok(
    (
      await db.owner.query(
        "select 1 from audit.log where action = 'staff.read' and entity_id = $1",
        [a.id],
      )
    ).rowCount !== 0,
  );
  assert.equal(
    (
      await db.owner.query(
        "select 1 from audit.log where action = 'staff.read' and actor_id = 'sub-nurse'",
      )
    ).rowCount,
    0,
    "l'annuaire n'écrit pas d'audit de lecture de données personnelles",
  );
});

test("licence d'exercice : sans licence valide, un médecin ou un infirmier ne peut pas être planifié", async () => {
  const doc = await create({ givenName: "Hassan", familyName: "Licence" });
  const noLicense = await shift(doc.id, at(1, 8), at(1, 16));
  assert.equal(noLicense.body.error.code, "license_invalid");
  const lic = await license(doc.id, day(10));
  assert.equal((await shift(doc.id, at(1, 8), at(1, 16))).status, 201);
  assert.equal(
    (await shift(doc.id, at(20, 8), at(20, 16))).body.error.code,
    "license_invalid",
    "la licence expire avant cette garde",
  );
  const exp = await call("hr", "GET", "/api/staff/qualifications/expiring?days=30", undefined, HR);
  assert.ok(
    exp.body.qualifications.some(
      (q: { memberId: string; expired: boolean }) => q.memberId === doc.id && q.expired === false,
    ),
  );
  assert.equal((await call("doctor", "GET", "/api/staff/qualifications/expiring")).status, 403);
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/qualifications/${lic}/revoke`,
        { reason: "Licence suspendue par l'Ordre" },
        HR,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("hr", "POST", `/api/staff/qualifications/${lic}/revoke`, { reason: "Encore" }, HR))
      .body.error.code,
    "already_revoked",
  );
  assert.equal(
    (await shift(doc.id, at(2, 8), at(2, 16))).body.error.code,
    "license_invalid",
    "licence retirée",
  );
  // Une catégorie sans exigence de licence se planifie sans.
  const agent = await create({
    givenName: "Moussa",
    familyName: "Entretien",
    category: "support",
    jobTitle: "Agent d'entretien",
    departmentCode: "HOSP",
  });
  assert.equal(
    (await shift(agent.id, at(1, 6), at(1, 14), { departmentCode: "HOSP" })).status,
    201,
  );
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/${doc.id}/qualifications`,
        { kind: "license", title: "Licence x", issuedOn: "2025-01-01", expiresOn: "2024-01-01" },
        HR,
      )
    ).body.error.code,
    "bad_dates",
  );
});

test("planning : chevauchement et repos minimal refusés, garde de plus de 26 h refusée, qui est de garde maintenant", async () => {
  const doc = await create({ givenName: "Samira", familyName: "Garde" });
  await license(doc.id);
  assert.equal((await shift(doc.id, at(3, 8), at(3, 20))).status, 201);
  const overlap = await shift(doc.id, at(3, 18), at(3, 23));
  assert.equal(overlap.body.error.code, "shift_overlap");
  const rest = await shift(doc.id, at(4, 4), at(4, 12)); // 8 h après la fin : moins de 11 h de repos
  assert.equal(rest.body.error.code, "rest_violation");
  assert.equal(rest.body.error.details.minRestHours, 11);
  assert.equal((await shift(doc.id, at(4, 7), at(4, 15))).status, 201, "11 h de repos : accepté");
  assert.equal((await shift(doc.id, at(6, 0), at(7, 12))).body.error.code, "shift_too_long");
  assert.equal(
    (await shift(doc.id, at(6, 8), at(6, 16), { departmentCode: "NOPE" })).body.error.code,
    "unknown_department",
  );
  assert.equal(
    (await call("nurse", "POST", "/api/staff/shifts", {})).status,
    403,
    "le planning est tenu par les ressources humaines",
  );

  // Planning visible de tous les agents.
  const planning = await call(
    "nurse",
    "GET",
    `/api/staff/shifts?from=${encodeURIComponent(at(3, 0))}&to=${encodeURIComponent(at(5, 0))}&department=CONS`,
  );
  assert.equal(planning.body.shifts.length, 2);
  assert.equal(
    (
      await call(
        "direction",
        "GET",
        `/api/staff/shifts?from=${encodeURIComponent(at(3, 0))}&to=${encodeURIComponent(at(5, 0))}`,
      )
    ).status,
    403,
  );

  // De garde maintenant : garde en cours (insérée directement) ; une garde future ne compte pas.
  const now = new Date();
  await db.owner.query(
    "insert into staff.shifts (member_id, department_code, kind, starts_at, ends_at, created_by) values ($1, 'URG', 'night', $2, $3, 'test')",
    [
      doc.id,
      new Date(now.getTime() - 3600_000).toISOString(),
      new Date(now.getTime() + 7 * 3600_000).toISOString(),
    ],
  );
  const duty = await call("lab", "GET", "/api/staff/on-duty?department=URG");
  assert.deepEqual(
    duty.body.onDuty.map((d: { name: string; departmentCode: string }) => [
      d.name,
      d.departmentCode,
    ]),
    [["Samira Garde", "URG"]],
  );
  assert.equal(
    (await call("lab", "GET", "/api/staff/on-duty?department=CONS")).body.onDuty.length,
    0,
  );

  // Suppression : seulement une garde à venir.
  const future = (
    await call(
      "hr",
      "GET",
      `/api/staff/shifts?from=${encodeURIComponent(at(3, 0))}&to=${encodeURIComponent(at(3, 23))}`,
      undefined,
      HR,
    )
  ).body.shifts[0];
  assert.equal(
    (await call("hr", "DELETE", `/api/staff/shifts/${future.id}`, undefined, HR)).status,
    200,
  );
  const started = (
    await db.owner.query("select id from staff.shifts where department_code = 'URG'")
  ).rows[0].id;
  assert.equal(
    (await call("hr", "DELETE", `/api/staff/shifts/${started}`, undefined, HR)).body.error.code,
    "shift_started",
  );
  await assert.rejects(
    db.owner.query(
      "insert into staff.shifts (member_id, department_code, kind, starts_at, ends_at, created_by) values ($1, 'CONS', 'day', $2, $3, 'x')",
      [doc.id, at(4, 10), at(4, 12)],
    ),
    /exclusion|chevauch|conflicting/i,
    "la base refuse aussi un chevauchement écrit directement",
  );
});

test("congés : demande par l'agent, décision par un autre, gardes sur la période à retirer d'abord", async () => {
  const doc = await create({ givenName: "Idriss", familyName: "Conge" });
  await license(doc.id);
  assert.equal(
    (await call("doctor", "GET", "/api/staff/me", undefined, "dr-conge")).body.error.code,
    "no_staff_record",
  );
  assert.equal(
    (await call("hr", "POST", `/api/staff/${doc.id}/link`, { userId: "dr-conge" }, HR)).status,
    200,
  );
  const other = await create({ givenName: "Autre", familyName: "Compte" });
  assert.equal(
    (await call("hr", "POST", `/api/staff/${other.id}/link`, { userId: "dr-conge" }, HR)).body.error
      .code,
    "account_taken",
  );
  // Détachement puis rattachement à un autre agent (remplacement), puis retour.
  assert.equal(
    (await call("hr", "POST", `/api/staff/${other.id}/unlink`, {}, HR)).body.error.code,
    "no_account",
  );
  assert.equal((await call("hr", "POST", `/api/staff/${doc.id}/unlink`, {}, HR)).status, 200);
  assert.equal(
    (await call("hr", "POST", `/api/staff/${other.id}/link`, { userId: "dr-conge" }, HR)).status,
    200,
  );
  assert.equal((await call("hr", "POST", `/api/staff/${other.id}/unlink`, {}, HR)).status, 200);
  assert.equal(
    (await call("hr", "POST", `/api/staff/${doc.id}/link`, { userId: "dr-conge" }, HR)).status,
    200,
  );

  const s1 = await shift(doc.id, at(30, 8), at(30, 16));
  assert.equal(s1.status, 201, s1.raw);
  const req = await call(
    "doctor",
    "POST",
    "/api/staff/me/leaves",
    { kind: "annual", startsOn: day(28), endsOn: day(35), reason: "Congé annuel" },
    "dr-conge",
  );
  assert.equal(req.status, 201, req.raw);
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        "/api/staff/me/leaves",
        { kind: "annual", startsOn: day(33), endsOn: day(40) },
        "dr-conge",
      )
    ).body.error.code,
    "leave_overlap",
  );
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        "/api/staff/me/leaves",
        { kind: "annual", startsOn: day(5), endsOn: day(2) },
        "dr-conge",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        `/api/staff/leaves/${req.body.id}/decide`,
        { approve: true, note: "moi-même" },
        "dr-conge",
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("hr", "GET", "/api/staff/leaves?status=requested", undefined, HR)).body.leaves
      .length,
    1,
  );

  const blocked = await call(
    "hr",
    "POST",
    `/api/staff/leaves/${req.body.id}/decide`,
    { approve: true, note: "Accord du chef de service" },
    HR,
  );
  assert.equal(blocked.body.error.code, "shifts_in_period");
  assert.equal(blocked.body.error.details.shifts.length, 1);
  await call("hr", "DELETE", `/api/staff/shifts/${s1.body.id}`, undefined, HR);
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/leaves/${req.body.id}/decide`,
        { approve: true, note: "Accord du chef de service" },
        HR,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/leaves/${req.body.id}/decide`,
        { approve: false, note: "Encore" },
        HR,
      )
    ).body.error.code,
    "already_decided",
  );
  assert.equal(
    (await shift(doc.id, at(31, 8), at(31, 16))).body.error.code,
    "on_leave",
    "pas de garde pendant un congé approuvé",
  );

  // Annulation avant le début ; une demande rejetée ne bloque rien.
  const me = await call("doctor", "GET", "/api/staff/me", undefined, "dr-conge");
  assert.equal(me.body.member.matricule, doc.matricule);
  assert.equal(me.body.leaves.length, 1);
  const cancelled = await call(
    "doctor",
    "POST",
    `/api/staff/me/leaves/${req.body.id}/cancel`,
    undefined,
    "dr-conge",
  );
  assert.equal(cancelled.body.status, "cancelled", cancelled.raw);
  assert.equal((await shift(doc.id, at(31, 8), at(31, 16))).status, 201);
  const second = await call(
    "doctor",
    "POST",
    "/api/staff/me/leaves",
    { kind: "sick", startsOn: day(50), endsOn: day(52) },
    "dr-conge",
  );
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/leaves/${second.body.id}/decide`,
        { approve: false, note: "Justificatif manquant" },
        HR2,
      )
    ).body.status,
    "rejected",
  );
  assert.equal(
    (
      await db.owner.query(
        "select 1 from audit.log where action in ('leave.request', 'leave.approve', 'leave.reject', 'leave.cancel')",
      )
    ).rowCount,
    5,
  );
});

test("situation de l'agent : suspendu ou parti, son compte est coupé tout de suite et ses gardes futures retirées", async () => {
  const doc = await create({ givenName: "Omar", familyName: "Suspendu" });
  await license(doc.id);
  await call("hr", "POST", `/api/staff/${doc.id}/link`, { userId: "dr-suspendu" }, HR);
  assert.equal(
    (await call("doctor", "GET", "/api/staff", undefined, "dr-suspendu")).status,
    200,
    "le compte fonctionne",
  );
  await shift(doc.id, at(40, 8), at(40, 16));
  await shift(doc.id, at(41, 8), at(41, 16));

  const sus = await call(
    "hr",
    "POST",
    `/api/staff/${doc.id}/status`,
    { status: "suspended", effectiveOn: day(0), reason: "Procédure disciplinaire en cours" },
    HR,
  );
  assert.equal(sus.status, 200, sus.raw);
  assert.deepEqual([sus.body.removedShifts, sus.body.account], [2, "disabled"]);
  const denied = await call("doctor", "GET", "/api/staff", undefined, "dr-suspendu");
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, "account_disabled");
  assert.equal((await shift(doc.id, at(42, 8), at(42, 16))).body.error.code, "member_not_active");
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/${doc.id}/status`,
        { status: "suspended", effectiveOn: day(0), reason: "Encore" },
        HR,
      )
    ).body.error.code,
    "no_change",
  );

  const back = await call(
    "hr",
    "POST",
    `/api/staff/${doc.id}/status`,
    { status: "active", effectiveOn: day(0), reason: "Fin de la suspension" },
    HR,
  );
  assert.equal(back.body.account, "enabled");
  assert.equal(
    (await call("doctor", "GET", "/api/staff", undefined, "dr-suspendu")).status,
    200,
    "le compte est rétabli",
  );

  const left = await call(
    "hr",
    "POST",
    `/api/staff/${doc.id}/status`,
    { status: "left", effectiveOn: day(0), reason: "Démission" },
    HR,
  );
  assert.equal(left.body.account, "disabled");
  assert.equal((await call("doctor", "GET", "/api/staff", undefined, "dr-suspendu")).status, 403);
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/${doc.id}/status`,
        { status: "active", effectiveOn: day(0), reason: "Retour" },
        HR,
      )
    ).body.error.code,
    "member_left",
  );

  // Un compte rattaché après le départ est bloqué avant même sa première connexion.
  const gone = await create({ givenName: "Zara", familyName: "Partie" });
  await call(
    "hr",
    "POST",
    `/api/staff/${gone.id}/status`,
    { status: "left", effectiveOn: day(0), reason: "Fin de contrat" },
    HR,
  );
  await call("hr", "POST", `/api/staff/${gone.id}/link`, { userId: "jamais-connecte" }, HR);
  assert.equal(
    (await call("doctor", "GET", "/api/staff", undefined, "jamais-connecte")).body.error.code,
    "account_disabled",
  );
});

test("effectifs du tableau de bord : chiffres identiques aux sources, sans donnée personnelle", async () => {
  const d = (await call("direction", "GET", "/api/dashboard")).body.staff;
  const src = await db.owner.query(
    "select count(*)::int n from staff.members where status = 'active'",
  );
  assert.equal(d.active, src.rows[0].n);
  const cats = await db.owner.query(
    "select category, count(*)::int n from staff.members where status = 'active' group by category",
  );
  assert.deepEqual(d.byCategory, Object.fromEntries(cats.rows.map((r) => [r.category, r.n])));
  assert.equal(d.onDutyNow.URG, 1);
  assert.equal(typeof d.qualificationsExpiring, "number");
  assert.ok(!JSON.stringify(d).includes("Essai"), "aucun nom d'agent");
});

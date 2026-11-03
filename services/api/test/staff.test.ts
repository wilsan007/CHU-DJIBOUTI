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

test("catégories : aucune licence contrôlée, contact avec les patients signalé, garde de 8 à 10 heures seulement", async () => {
  const doc = await create({ givenName: "Hassan", familyName: "Garde" });
  const nurseAide = await create({
    givenName: "Asha",
    familyName: "Aide",
    category: "care_assistant",
    jobTitle: "Aide-soignante",
    departmentCode: "HOSP",
  });
  const assistant = await create({
    givenName: "Moussa",
    familyName: "Entretien",
    category: "support",
    jobTitle: "Assistant sans contact avec les patients",
    departmentCode: "HOSP",
  });
  const viewOf = async (id: string) => (await call("nurse", "GET", `/api/staff/${id}`)).body;
  assert.deepEqual(
    [
      (await viewOf(doc.id)).patientContact,
      (await viewOf(nurseAide.id)).patientContact,
      (await viewOf(assistant.id)).patientContact,
    ],
    [true, true, false],
  );

  // Aucune licence : médecin, aide-soignant et assistant se planifient sans autre condition.
  assert.equal((await shift(doc.id, at(1, 20), at(2, 6))).status, 201, "garde de nuit de 10 h");
  assert.equal(
    (await shift(nurseAide.id, at(1, 8), at(1, 16), { departmentCode: "HOSP" })).status,
    201,
    "garde de 8 h",
  );
  assert.equal(
    (await shift(assistant.id, at(1, 8), at(1, 16), { departmentCode: "HOSP" })).status,
    201,
  );

  // Durée : 8 à 10 heures.
  const tooShort = await shift(doc.id, at(5, 8), at(5, 14));
  assert.equal(tooShort.body.error.code, "shift_duration");
  assert.equal(
    (await shift(doc.id, at(6, 8), at(6, 19))).body.error.code,
    "shift_duration",
    "11 h : trop long",
  );
  assert.equal((await shift(doc.id, at(7, 8), at(7, 18))).status, 201, "10 h : accepté");
  await assert.rejects(
    db.owner.query(
      "insert into staff.shifts (member_id, department_code, kind, starts_at, ends_at, created_by) values ($1, 'CONS', 'day', $2, $3, 'x')",
      [doc.id, at(20, 8), at(20, 20)],
    ),
    /check|shifts_check/i,
    "la base refuse aussi une garde de 12 h",
  );
  // Plus aucun contrôle de licence : l'ancien type est refusé à la saisie.
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/${doc.id}/qualifications`,
        { kind: "license", title: "Licence" },
        HR,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/${doc.id}/qualifications`,
        { kind: "diploma", title: "Doctorat en médecine", issuedOn: "2015-07-01" },
        HR,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/${doc.id}/qualifications`,
        {
          kind: "certification",
          title: "Urgences",
          issuedOn: "2025-01-01",
          expiresOn: "2024-01-01",
        },
        HR,
      )
    ).body.error.code,
    "bad_dates",
  );
  const q = (await call("hr", "GET", `/api/staff/${doc.id}`, undefined, HR)).body.qualifications;
  assert.equal(q.length, 1);
  assert.equal(
    (
      await call(
        "hr",
        "POST",
        `/api/staff/qualifications/${q[0].id}/revoke`,
        { reason: "Saisie erronée" },
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
        `/api/staff/qualifications/${q[0].id}/revoke`,
        { reason: "Encore" },
        HR,
      )
    ).body.error.code,
    "already_revoked",
  );
});

test("planning : chevauchement et repos de 24 h après une garde refusés, qui est de garde maintenant", async () => {
  const doc = await create({ givenName: "Samira", familyName: "Planning" });
  assert.equal((await shift(doc.id, at(3, 8), at(3, 18))).status, 201);
  const overlap = await shift(doc.id, at(3, 16), at(4, 2));
  assert.equal(overlap.body.error.code, "shift_overlap");
  const rest = await shift(doc.id, at(4, 12), at(4, 20)); // 18 h après la fin : moins de 24 h de repos
  assert.equal(rest.body.error.code, "rest_violation");
  assert.equal(rest.body.error.details.minRestHours, 24);
  assert.equal(
    (await shift(doc.id, at(4, 18), at(5, 4))).status,
    201,
    "24 h de repos exactement : accepté",
  );
  assert.equal(
    (await shift(doc.id, at(8, 8), at(8, 16), { departmentCode: "NOPE" })).body.error.code,
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
    `/api/staff/shifts?from=${encodeURIComponent(at(3, 0))}&to=${encodeURIComponent(at(6, 0))}&department=CONS`,
  );
  assert.equal(planning.body.shifts.length, 2);
  assert.equal(
    (
      await call(
        "direction",
        "GET",
        `/api/staff/shifts?from=${encodeURIComponent(at(3, 0))}&to=${encodeURIComponent(at(6, 0))}`,
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
      new Date(now.getTime() + 8 * 3600_000).toISOString(),
    ],
  );
  const duty = await call("lab", "GET", "/api/staff/on-duty?department=URG");
  assert.deepEqual(
    duty.body.onDuty.map((d: { name: string; departmentCode: string }) => [
      d.name,
      d.departmentCode,
    ]),
    [["Samira Planning", "URG"]],
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
      [doc.id, at(4, 19), at(4, 21)],
    ),
    /exclusion|chevauch|conflicting|check/i,
    "la base refuse aussi un chevauchement ou une durée écrits directement",
  );
});

test("congés : demande par l'agent, décision par un autre, gardes sur la période à retirer d'abord", async () => {
  const doc = await create({ givenName: "Idriss", familyName: "Conge" });
  assert.equal(
    (await call("doctor", "GET", "/api/staff/me", undefined, "dr-conge")).status,
    204,
    "compte sans fiche : réponse vide, pas une erreur",
  );
  assert.equal(
    (
      await call(
        "doctor",
        "POST",
        "/api/staff/me/leaves",
        { kind: "annual", startsOn: "2030-01-01", endsOn: "2030-01-02" },
        "dr-conge",
      )
    ).body.error.code,
    "no_staff_record",
    "mais demander un congé sans fiche reste refusé",
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
  await call("hr", "POST", `/api/staff/${doc.id}/link`, { userId: "dr-suspendu" }, HR);
  assert.equal(
    (await call("doctor", "GET", "/api/staff", undefined, "dr-suspendu")).status,
    200,
    "le compte fonctionne",
  );
  await shift(doc.id, at(40, 8), at(40, 16));
  await shift(doc.id, at(42, 8), at(42, 16));

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
  assert.equal((await shift(doc.id, at(44, 8), at(44, 16))).body.error.code, "member_not_active");
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
  const contact = await db.owner.query(
    "select count(*)::int n from staff.members where status = 'active' and category in ('physician', 'nurse', 'care_assistant', 'midwife', 'lab_technician', 'imaging_technician')",
  );
  assert.equal(d.patientContact, contact.rows[0].n);
  assert.ok(!JSON.stringify(d).includes("Essai"), "aucun nom d'agent");
});

test("fiche et compte de connexion créés ensemble ; rôle par défaut selon la catégorie ; fiche conservée si l'annuaire est absent", async () => {
  const created: string[] = [];
  const withDirectory = await createTestApp(db.app, {
    directory: {
      createUser: async (input) => {
        created.push(`${input.username}:${input.role}`);
        return { id: `kc-${input.username}` };
      },
      setEnabled: async () => undefined,
      setRole: async () => undefined,
    },
  });
  try {
    const c = makeCaller(withDirectory);
    const pwd = "Mot-de-passe-temporaire-1";
    const nurse = await c(
      "hr",
      "POST",
      "/api/staff",
      member({
        category: "nurse",
        jobTitle: "Infirmière",
        account: { username: "inf.nouvelle", email: "inf@chu.invalid", temporaryPassword: pwd },
      }),
      HR,
    );
    assert.equal(nurse.status, 201, nurse.raw);
    assert.equal(nurse.body.userId, "kc-inf.nouvelle");
    assert.deepEqual(created, ["inf.nouvelle:nurse"], "catégorie infirmière : rôle nurse");
    assert.equal(
      (await c("hr", "GET", `/api/staff/${nurse.body.id}`, undefined, HR)).body.userId,
      "kc-inf.nouvelle",
    );
    assert.equal(
      (await db.owner.query("select 1 from admin.users where id = 'kc-inf.nouvelle'")).rowCount,
      1,
    );

    // Aide-soignant : rôle nurse ; assistant sans contact avec les patients : pas de rôle par défaut, la fiche n'est pas créée.
    const aide = await c(
      "hr",
      "POST",
      "/api/staff",
      member({
        category: "care_assistant",
        jobTitle: "Aide-soignant",
        account: { username: "aide.nouveau", email: "aide@chu.invalid", temporaryPassword: pwd },
      }),
      HR,
    );
    assert.equal(aide.status, 201);
    assert.equal(created[1], "aide.nouveau:nurse");
    const before = (await db.owner.query("select count(*)::int n from staff.members")).rows[0].n;
    const noRole = await c(
      "hr",
      "POST",
      "/api/staff",
      member({
        category: "support",
        jobTitle: "Assistant",
        account: { username: "assistant.x", email: "a@chu.invalid", temporaryPassword: pwd },
      }),
      HR,
    );
    assert.equal(noRole.body.error.code, "role_required");
    assert.equal(
      (await db.owner.query("select count(*)::int n from staff.members")).rows[0].n,
      before,
    );
    const explicit = await c(
      "hr",
      "POST",
      "/api/staff",
      member({
        category: "support",
        jobTitle: "Assistant administratif",
        account: {
          username: "assistant.y",
          email: "ay@chu.invalid",
          role: "reception",
          temporaryPassword: pwd,
        },
      }),
      HR,
    );
    assert.equal(explicit.status, 201);
    assert.equal(created[2], "assistant.y:reception");
  } finally {
    await withDirectory.close();
  }

  // Sans annuaire configuré : la fiche est créée, le compte est refusé clairement ; rattachement possible plus tard.
  const lone = await call(
    "hr",
    "POST",
    "/api/staff",
    member({
      givenName: "Seul",
      account: {
        username: "seul.agent",
        email: "s@chu.invalid",
        temporaryPassword: "Mot-de-passe-temporaire-1",
      },
    }),
    HR,
  );
  assert.equal(lone.status, 501);
  assert.equal(
    (await db.owner.query("select 1 from staff.members where given_name = 'Seul'")).rowCount,
    1,
  );
});

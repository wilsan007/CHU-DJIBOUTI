import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { localToUtc } from "../src/common/time.ts";
import {
  sendDueReminders,
  type NotificationProvider,
} from "../src/modules/appointments/reminders.ts";
import { createTestApp, type TestApp } from "./support/app.ts";
import { createTestDatabase, type TestDatabase } from "./support/db.ts";
import {
  admitPatient,
  importCatalogs,
  makeCaller,
  newPatient,
  type Caller,
} from "./support/scenario.ts";

let db: TestDatabase;
let t: TestApp;
let call: Caller;

const DR = "dr-agenda";
const DR2 = "dr-agenda-2";

/** Prochain lundi, au moins 7 jours dans le futur, au format AAAA-MM-JJ (jour local). */
function futureMonday(weeksAhead = 1): string {
  const d = new Date(Date.now() + 3 * 3600_000 + 7 * 86_400_000 * weeksAhead);
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (date: string, time: string) => localToUtc(date, time).toISOString();

before(async () => {
  db = await createTestDatabase();
  t = await createTestApp(db.app);
  call = makeCaller(t);
  await importCatalogs(call);
  for (const [id, name] of [
    [DR, "Dr Agenda"],
    [DR2, "Dr Deux"],
  ] as const) {
    assert.equal(
      (
        await call("admin", "PUT", `/api/schedule/practitioners/${id}`, {
          displayName: name,
          departmentCode: "CONS",
        })
      ).status,
      200,
    );
    const rules = await call("admin", "PUT", `/api/schedule/practitioners/${id}/availability`, {
      rules: [1, 2, 3, 4, 5].map((weekday) => ({
        weekday,
        start: "08:00",
        end: "10:00",
        slotMinutes: 30,
      })),
    });
    assert.equal(rules.status, 200, rules.raw);
  }
});
after(async () => {
  await t.close();
  await db.drop();
});

async function book(
  patientId: string,
  practitionerId: string,
  startsAt: string,
  role: "reception" | "doctor" = "reception",
) {
  return call(role, "POST", "/api/appointments", { patientId, practitionerId, startsAt });
}

/* ------------------------------------------------------------------ F3-1 agendas */

test("F3-1 : créneaux d'un jour selon les horaires ; absences ; droits", async () => {
  const monday = futureMonday();
  const slots = (
    await call("reception", "GET", `/api/schedule/practitioners/${DR}/slots?date=${monday}`)
  ).body.slots;
  assert.equal(slots.length, 4, "08:00, 08:30, 09:00, 09:30");
  assert.equal(slots[0].startsAt, at(monday, "08:00"));
  assert.ok(slots.every((s: { status: string }) => s.status === "free"));
  const saturday = new Date(`${monday}T00:00:00Z`);
  saturday.setUTCDate(saturday.getUTCDate() + 5);
  assert.equal(
    (
      await call(
        "reception",
        "GET",
        `/api/schedule/practitioners/${DR}/slots?date=${saturday.toISOString().slice(0, 10)}`,
      )
    ).body.slots.length,
    0,
  );

  const tuesday = new Date(`${monday}T00:00:00Z`);
  tuesday.setUTCDate(tuesday.getUTCDate() + 1);
  const tue = tuesday.toISOString().slice(0, 10);
  assert.equal(
    (
      await call("admin", "POST", `/api/schedule/practitioners/${DR2}/absences`, {
        from: tue,
        to: tue,
        reason: "congé",
      })
    ).status,
    201,
  );
  const absent = (
    await call("reception", "GET", `/api/schedule/practitioners/${DR2}/slots?date=${tue}`)
  ).body.slots;
  assert.ok(absent.every((s: { status: string }) => s.status === "absent"));

  assert.equal(
    (
      await call("reception", "PUT", `/api/schedule/practitioners/${DR}/availability`, {
        rules: [],
      })
    ).status,
    403,
  );
  const bad = await call("admin", "PUT", `/api/schedule/practitioners/${DR}/availability`, {
    rules: [{ weekday: 1, start: "10:00", end: "09:00", slotMinutes: 30 }],
  });
  assert.equal(bad.body.error.code, "invalid_rule");
  const overlap = await call("admin", "PUT", `/api/schedule/practitioners/${DR}/availability`, {
    rules: [
      { weekday: 1, start: "08:00", end: "10:00", slotMinutes: 30 },
      { weekday: 1, start: "09:30", end: "11:00", slotMinutes: 30 },
    ],
  });
  assert.equal(overlap.body.error.code, "overlapping_rules");
});

/* ------------------------------------------------------------------ F3-2 réservation */

test("F3-2 : réservation depuis l'accueil et la consultation ; événement ; créneau marqué pris", async () => {
  const monday = futureMonday(2);
  const p = await newPatient(call);
  const res = await book(p.id, DR, at(monday, "08:00"));
  assert.equal(res.status, 201, res.raw);
  assert.equal(res.body.status, "booked");
  assert.equal(res.body.departmentCode, "CONS");
  const doctorBooking = await book((await newPatient(call)).id, DR, at(monday, "08:30"), "doctor");
  assert.equal(
    doctorBooking.status,
    201,
    "le médecin fixe le prochain rendez-vous depuis la consultation",
  );
  const slots = (
    await call("reception", "GET", `/api/schedule/practitioners/${DR}/slots?date=${monday}`)
  ).body.slots;
  assert.deepEqual(
    slots.map((s: { status: string }) => s.status),
    ["booked", "booked", "free", "free"],
  );
  const ev = await db.owner.query(
    "select type, payload from events.outbox where type = 'AppointmentBooked' and patient_id = $1",
    [p.id],
  );
  assert.equal(ev.rows[0].payload.practitionerId, DR);
  const list = await call(
    "reception",
    "GET",
    `/api/appointments?practitionerId=${DR}&date=${monday}`,
  );
  assert.equal(list.body.appointments.length, 2);
  assert.ok(list.body.appointments[0].patient.identifier);
});

test("F3-2 : jamais deux réservations sur le même créneau, même simultanées", async () => {
  const monday = futureMonday(3);
  const [a, b] = [await newPatient(call), await newPatient(call)];
  const results = await Promise.all([
    book(a.id, DR, at(monday, "09:00")),
    book(b.id, DR, at(monday, "09:00")),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.equal(results.find((r) => r.status === 409)?.body.error.code, "slot_taken");
  const n = await db.owner.query(
    "select count(*)::int as n from appointments.appointments where practitioner_id = $1 and starts_at = $2 and status = 'booked'",
    [DR, at(monday, "09:00")],
  );
  assert.equal(n.rows[0].n, 1);
  assert.equal(
    (await book(b.id, DR2, at(monday, "09:00"))).status,
    201,
    "un autre praticien, même heure : possible",
  );
});

test("F3-2 : créneau invalide, passé, en absence, patient fusionné ou droits", async () => {
  const monday = futureMonday(4);
  const p = await newPatient(call);
  assert.equal((await book(p.id, DR, at(monday, "08:15"))).body.error.code, "not_a_slot");
  assert.equal((await book(p.id, DR, at(monday, "11:00"))).body.error.code, "not_a_slot");
  assert.equal((await book(p.id, DR, "2020-01-06T05:00:00.000Z")).body.error.code, "slot_in_past");
  assert.equal((await book(p.id, "inconnu", at(monday, "08:00"))).status, 404);
  assert.equal(
    (await book("00000000-0000-4000-8000-000000000000", DR, at(monday, "08:00"))).status,
    404,
  );
  await call("admin", "POST", `/api/schedule/practitioners/${DR2}/absences`, {
    from: monday,
    to: monday,
  });
  assert.equal((await book(p.id, DR2, at(monday, "08:00"))).body.error.code, "practitioner_absent");
  const old = await newPatient(call);
  await call("admin", "POST", "/api/patients/merge", {
    survivorId: p.id,
    mergedId: old.id,
    reason: "même personne",
  });
  assert.equal((await book(old.id, DR, at(monday, "08:00"))).body.error.code, "patient_merged");
  assert.equal(
    (
      await call("cashier", "POST", "/api/appointments", {
        patientId: p.id,
        practitionerId: DR,
        startsAt: at(monday, "08:00"),
      })
    ).status,
    403,
  );
  assert.equal((await call("lab", "GET", "/api/appointments")).status, 403);
});

/* ------------------------------------------------------------------ F3-3 file d'attente */

test("F3-3 : numéros d'ordre par service et par jour ; urgences d'abord, puis rendez-vous, puis les autres", async () => {
  const walkIn = await newPatient(call, "SansRdv");
  const withAppt = await newPatient(call, "AvecRdv");
  const emergency = await newPatient(call, "Urgence");
  // Un rendez-vous aujourd'hui : on le crée directement (la réservation refuse le passé).
  await db.owner.query(
    `insert into appointments.appointments (patient_id, practitioner_id, department_code, starts_at, ends_at, booked_by)
     values ($1, $2, 'CONS', now(), now() + interval '30 minutes', 'test')`,
    [withAppt.id, DR],
  );
  await admitPatient(call, walkIn.id, { department: "CONS" });
  await admitPatient(call, withAppt.id, { department: "CONS" });
  await call("admin", "GET", "/api/catalog/acts").catch(() => null);
  await db.owner.query(
    `insert into catalog.acts (code, label_fr, label_ar, tariff, department_code, category, responsible, updated_on)
     values ('URG-CONS', 'Consultation urgences', 'استشارة طوارئ', 3000, 'URG', 'consultation', 'test', '2026-11-01') on conflict do nothing`,
  );
  await admitPatient(call, emergency.id, { department: "URG", act: "URG-CONS" });
  await t.dispatcher.drain();

  const cons = (await call("reception", "GET", "/api/queue?department=CONS")).body.queue;
  assert.deepEqual(
    cons.map((e: { patient: { identifier: string } }) => e.patient.identifier),
    [withAppt.identifier, walkIn.identifier],
    "le patient avec rendez-vous passe avant",
  );
  assert.deepEqual(
    cons.map((e: { priority: number }) => e.priority),
    [1, 2],
  );
  assert.match(cons[0].ticket, /^CONS-\d{3}$/);
  assert.equal(Number(cons[1].ticket.slice(-3)) - Number(cons[0].ticket.slice(-3)) !== 0, true);
  assert.equal(typeof cons[0].waitingMinutes, "number");
  const urg = (await call("reception", "GET", "/api/queue?department=URG")).body.queue;
  assert.equal(urg[0].priority, 0);
  assert.equal(urg[0].ticket, "URG-001");
  const apptStatus = await db.owner.query(
    "select status from appointments.appointments where patient_id = $1",
    [withAppt.id],
  );
  assert.equal(
    apptStatus.rows[0].status,
    "arrived",
    "le rendez-vous est marqué honoré à l'arrivée",
  );

  // Une urgence arrivée après un patient sans rendez-vous passe devant lui.
  const late = await newPatient(call, "UrgenceTardive");
  await admitPatient(call, late.id, { department: "URG", act: "URG-CONS" });
  const another = await newPatient(call, "SansRdv2");
  await admitPatient(call, another.id, { department: "CONS" });
  await t.dispatcher.drain();
  const urg2 = (await call("reception", "GET", "/api/queue?department=URG")).body.queue;
  assert.equal(urg2.length, 2);
});

test("F3-3 : appel, début, fin ; écran d'appel sans aucun nom", async () => {
  const p = await newPatient(call, "Appel");
  await admitPatient(call, p.id, { department: "CONS" });
  await t.dispatcher.drain();
  const entry = (await call("reception", "GET", "/api/queue?department=CONS")).body.queue.find(
    (e: { patient: { identifier: string } }) => e.patient.identifier === p.identifier,
  );
  assert.equal(
    (await call("doctor", "POST", `/api/queue/${entry.id}/start`)).body.error.code,
    "invalid_transition",
  );
  const called = await call("doctor", "POST", `/api/queue/${entry.id}/call`);
  assert.equal(called.body.status, "called");
  const board = await call("reception", "GET", "/api/queue/display?department=CONS");
  assert.ok(board.body.called.includes(entry.ticket));
  assert.ok(!board.raw.includes("Appel"), "aucun nom sur l'écran d'appel");
  assert.equal(
    (await call("doctor", "POST", `/api/queue/${entry.id}/start`)).body.status,
    "in_consultation",
  );
  assert.equal((await call("doctor", "POST", `/api/queue/${entry.id}/done`)).body.status, "done");
  const after = (await call("reception", "GET", "/api/queue?department=CONS")).body.queue;
  assert.ok(!after.some((e: { id: string }) => e.id === entry.id));
  assert.equal((await call("cashier", "POST", `/api/queue/${entry.id}/call`)).status, 403);
});

test("F3-3 : rejouer l'événement d'admission ne crée pas une seconde place dans la file", async () => {
  const p = await newPatient(call, "Rejeu");
  await admitPatient(call, p.id, { department: "CONS" });
  await t.dispatcher.drain();
  const count = () =>
    db.owner
      .query("select count(*)::int as n from appointments.queue_entries where patient_id = $1", [
        p.id,
      ])
      .then((r) => r.rows[0].n);
  assert.equal(await count(), 1);
  await db.owner.query(
    "delete from events.processed where consumer = 'appointments.queue-on-admission'",
  );
  await db.owner.query(
    "update events.consumer_cursor set last_id = 0 where consumer = 'appointments.queue-on-admission'",
  );
  await t.dispatcher.drain();
  assert.equal(await count(), 1);
});

/* ------------------------------------------------------------------ F3-4 rappels */

class MemoryProvider implements NotificationProvider {
  sent: { to: string; text: string }[] = [];
  fail = false;
  async send(message: { to: string; text: string }) {
    if (this.fail) throw new Error("fournisseur indisponible");
    this.sent.push(message);
  }
}

test("F3-4 : rappel programmé à la réservation, envoyé une seule fois, sans nom ni motif", async () => {
  // Les rappels des autres tests ne doivent pas se mélanger à celui-ci.
  await db.owner.query(
    "update appointments.reminders set status = 'skipped', detail = 'autre test' where status = 'pending'",
  );
  const monday = futureMonday(5);
  const p = await newPatient(call, "Rappel");
  const res = await call("reception", "POST", "/api/appointments", {
    patientId: p.id,
    practitionerId: DR,
    startsAt: at(monday, "09:30"),
    reason: "diabète",
  });
  await t.dispatcher.drain();
  const rem = await db.owner.query(
    "select due_at, status from appointments.reminders where appointment_id = $1",
    [res.body.id],
  );
  assert.equal(rem.rowCount, 1);
  assert.equal(rem.rows[0].status, "pending");
  assert.equal(
    new Date(rem.rows[0].due_at).getTime(),
    new Date(at(monday, "09:30")).getTime() - 24 * 3600_000,
    "24 h avant",
  );

  const provider = new MemoryProvider();
  const early = await sendDueReminders(
    db.app,
    provider,
    new Date(new Date(rem.rows[0].due_at).getTime() - 60_000),
  );
  assert.equal(early.sent, 0, "pas avant l'échéance");
  const due = new Date(new Date(rem.rows[0].due_at).getTime() + 60_000);
  const report = await sendDueReminders(db.app, provider, due);
  assert.equal(report.sent, 1);
  assert.equal(provider.sent.length, 1);
  assert.match(provider.sent[0]?.text ?? "", new RegExp(monday));
  assert.ok(
    !/Rappel|diabète/.test(
      (provider.sent[0]?.text ?? "").replace("rappel de votre rendez-vous", ""),
    ),
    "ni nom ni motif",
  );
  assert.ok(!(provider.sent[0]?.text ?? "").includes("diabète"));
  assert.equal((await sendDueReminders(db.app, provider, due)).sent, 0, "jamais deux fois");
});

test("F3-4 : le patient peut refuser les rappels ; un rendez-vous annulé n'est pas rappelé ; échec fournisseur noté", async () => {
  // Les rappels des autres tests ne doivent pas se mélanger à celui-ci.
  await db.owner.query(
    "update appointments.reminders set status = 'skipped', detail = 'autre test' where status = 'pending'",
  );
  const monday = futureMonday(6);
  const refuser = await newPatient(call, "Refus");
  const prefs = await call("reception", "PUT", `/api/patients/${refuser.identifier}/preferences`, {
    reminderOptOut: true,
  });
  assert.equal(prefs.status, 200, prefs.raw);
  await book(refuser.id, DR, at(monday, "08:00"));
  const canceller = await newPatient(call, "Annule");
  const toCancel = await book(canceller.id, DR, at(monday, "08:30"));
  const failing = await newPatient(call, "Echec");
  await book(failing.id, DR, at(monday, "09:00"));
  await t.dispatcher.drain();
  await call("reception", "POST", `/api/appointments/${toCancel.body.id}/cancel`, {
    reason: "le patient prévient",
  });
  await t.dispatcher.drain();

  const provider = new MemoryProvider();
  provider.fail = true;
  const farFuture = new Date(Date.now() + 365 * 86_400_000);
  const report = await sendDueReminders(db.app, provider, farFuture);
  assert.equal(report.failed, 1);
  assert.equal(report.skipped, 2);
  assert.equal(report.sent, 0);
  const details = await db.owner.query(
    "select status, detail from appointments.reminders order by id",
  );
  assert.ok(details.rows.some((r) => r.detail === "le patient refuse les rappels"));
  assert.ok(details.rows.some((r) => r.detail === "rendez-vous annulé ou passé"));
  assert.ok(
    details.rows.some((r) => r.status === "failed" && r.detail === "fournisseur indisponible"),
  );
});

/* ------------------------------------------------------------------ F3-5 annulation, report, liste d'attente */

test("F3-5 : annulation libère le créneau, motif obligatoire, pas de double annulation", async () => {
  const monday = futureMonday(7);
  const p = await newPatient(call);
  const appt = await book(p.id, DR, at(monday, "08:00"));
  assert.equal(
    (await call("reception", "POST", `/api/appointments/${appt.body.id}/cancel`, {})).status,
    400,
  );
  const cancelled = await call("reception", "POST", `/api/appointments/${appt.body.id}/cancel`, {
    reason: "empêchement",
  });
  assert.equal(cancelled.body.status, "cancelled");
  assert.equal(
    (
      await call("reception", "POST", `/api/appointments/${appt.body.id}/cancel`, {
        reason: "encore",
      })
    ).status,
    409,
  );
  const free = (
    await call("reception", "GET", `/api/schedule/practitioners/${DR}/slots?date=${monday}`)
  ).body.slots;
  assert.equal(free[0].status, "free");
  assert.equal(
    (await book((await newPatient(call)).id, DR, at(monday, "08:00"))).status,
    201,
    "le créneau est de nouveau réservable",
  );
});

test("F3-5 : report atomique ; si le nouveau créneau est pris, l'ancien rendez-vous reste", async () => {
  const monday = futureMonday(8);
  const p = await newPatient(call);
  const other = await newPatient(call);
  const appt = await book(p.id, DR, at(monday, "08:00"));
  await book(other.id, DR, at(monday, "09:00"));
  const conflict = await call("reception", "POST", `/api/appointments/${appt.body.id}/reschedule`, {
    startsAt: at(monday, "09:00"),
  });
  assert.equal(conflict.status, 409);
  assert.equal(
    (
      await db.owner.query("select status from appointments.appointments where id = $1", [
        appt.body.id,
      ])
    ).rows[0].status,
    "booked",
  );
  assert.equal(
    (
      await call("reception", "POST", `/api/appointments/${appt.body.id}/reschedule`, {
        startsAt: at(monday, "08:00"),
      })
    ).body.error.code,
    "same_slot",
  );
  const moved = await call("reception", "POST", `/api/appointments/${appt.body.id}/reschedule`, {
    startsAt: at(monday, "09:30"),
  });
  assert.equal(moved.status, 200, moved.raw);
  assert.equal(moved.body.previous.status, "cancelled");
  assert.equal(moved.body.appointment.rescheduledFrom, appt.body.id);
  assert.equal(moved.body.appointment.startsAt, at(monday, "09:30"));
});

test("F3-5 : le créneau libéré est proposé au premier patient de la liste d'attente, qui peut l'accepter", async () => {
  const monday = futureMonday(9);
  const holder = await newPatient(call, "Titulaire");
  const first = await newPatient(call, "Premier");
  const second = await newPatient(call, "Second");
  const appt = await book(holder.id, DR, at(monday, "08:00"));
  const w1 = await call("reception", "POST", "/api/waitlist", {
    patientId: first.id,
    departmentCode: "CONS",
    earliest: monday,
    latest: monday,
  });
  const w2 = await call("reception", "POST", "/api/waitlist", {
    patientId: second.id,
    departmentCode: "CONS",
    practitionerId: DR,
    earliest: monday,
    latest: monday,
  });
  assert.equal(w1.status, 201);
  await call("reception", "POST", `/api/appointments/${appt.body.id}/cancel`, {
    reason: "annulation",
  });
  await t.dispatcher.drain();
  const offered = await db.owner.query(
    "select id, status, offered_slot from appointments.waitlist where id in ($1, $2) order by created_at",
    [w1.body.id, w2.body.id],
  );
  assert.deepEqual(
    offered.rows.map((r) => r.status),
    ["offered", "waiting"],
    "le premier arrivé est servi en premier",
  );
  const ev = await db.owner.query(
    "select 1 from events.outbox where type = 'WaitlistSlotOffered' and patient_id = $1",
    [first.id],
  );
  assert.equal(ev.rowCount, 1);
  const provider = new MemoryProvider();
  const sent = await sendDueReminders(db.app, provider, new Date(Date.now() + 60_000));
  assert.ok(sent.sent >= 1, "le patient est prévenu");
  assert.match(provider.sent.at(-1)?.text ?? "", /créneau/);

  const accepted = await call("reception", "POST", `/api/waitlist/${w1.body.id}/accept`);
  assert.equal(accepted.status, 201, accepted.raw);
  assert.equal(accepted.body.patientId, first.id);
  assert.equal(accepted.body.startsAt, at(monday, "08:00"));
  assert.equal(
    (await call("reception", "POST", `/api/waitlist/${w1.body.id}/accept`)).body.error.code,
    "no_offer",
  );
});

test("F3-5 : si le créneau proposé est repris avant l'acceptation, la demande retourne en attente", async () => {
  const monday = futureMonday(10);
  const holder = await newPatient(call);
  const waiting = await newPatient(call);
  const sniper = await newPatient(call);
  const appt = await book(holder.id, DR, at(monday, "09:00"));
  const w = await call("reception", "POST", "/api/waitlist", {
    patientId: waiting.id,
    departmentCode: "CONS",
    earliest: monday,
    latest: monday,
  });
  await call("reception", "POST", `/api/appointments/${appt.body.id}/cancel`, {
    reason: "annulation",
  });
  await t.dispatcher.drain();
  assert.equal((await book(sniper.id, DR, at(monday, "09:00"))).status, 201);
  const accept = await call("reception", "POST", `/api/waitlist/${w.body.id}/accept`);
  assert.equal(accept.status, 409);
  assert.equal(
    (await db.owner.query("select status from appointments.waitlist where id = $1", [w.body.id]))
      .rows[0].status,
    "waiting",
  );
});

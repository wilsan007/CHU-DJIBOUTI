import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Db } from "../../db.ts";
import { contextOf, parseWith, requirePermission } from "../../http.ts";
import { displayBoard, listQueue, moveQueueEntry } from "./queue.ts";
import {
  acceptWaitlistOffer,
  addToWaitlist,
  bookAppointment,
  cancelAppointment,
  listAppointments,
  rescheduleAppointment,
} from "./service.ts";
import {
  addAbsence,
  listPractitioners,
  savePractitioner,
  setAvailability,
  slotsFor,
} from "./schedule.ts";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const instant = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

const PractitionerSchema = z.object({
  displayName: z.string().trim().min(1).max(100),
  departmentCode: z.string().trim().min(1).max(20),
  active: z.boolean().optional(),
});
const AvailabilitySchema = z.object({
  rules: z
    .array(
      z.object({
        weekday: z.number().int().min(1).max(7),
        start: time,
        end: time,
        slotMinutes: z.number().int().min(5).max(240),
      }),
    )
    .max(40),
});
const AbsenceSchema = z.object({
  from: day,
  to: day,
  reason: z.string().trim().max(200).optional(),
});
const BookSchema = z.object({
  patientId: z.string().uuid(),
  practitionerId: z.string().min(1).max(100),
  startsAt: instant,
  reason: z.string().trim().max(300).optional(),
});
const CancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });
const RescheduleSchema = z.object({ startsAt: instant });
const WaitlistSchema = z.object({
  patientId: z.string().uuid(),
  departmentCode: z.string().trim().min(1).max(20),
  practitionerId: z.string().min(1).max(100).optional(),
  earliest: day,
  latest: day,
});

export async function registerAppointmentRoutes(app: FastifyInstance, db: Db): Promise<void> {
  /* F3-1 : agendas */
  app.get(
    "/api/schedule/practitioners",
    { preHandler: requirePermission("appointment:read") },
    async (request) => ({
      practitioners: await listPractitioners(
        db,
        (request.query as { department?: string }).department,
      ),
    }),
  );
  app.put(
    "/api/schedule/practitioners/:id",
    { preHandler: requirePermission("schedule:manage") },
    async (request) =>
      savePractitioner(
        db,
        contextOf(request),
        (request.params as { id: string }).id,
        parseWith(PractitionerSchema, request.body),
      ),
  );
  app.put(
    "/api/schedule/practitioners/:id/availability",
    { preHandler: requirePermission("schedule:manage") },
    async (request) => {
      const { rules } = parseWith(AvailabilitySchema, request.body);
      return {
        rules: await setAvailability(
          db,
          contextOf(request),
          (request.params as { id: string }).id,
          rules,
        ),
      };
    },
  );
  app.post(
    "/api/schedule/practitioners/:id/absences",
    { preHandler: requirePermission("schedule:manage") },
    async (request, reply) => {
      await addAbsence(
        db,
        contextOf(request),
        (request.params as { id: string }).id,
        parseWith(AbsenceSchema, request.body),
      );
      return reply.status(201).send({ ok: true });
    },
  );
  app.get(
    "/api/schedule/practitioners/:id/slots",
    { preHandler: requirePermission("appointment:read") },
    async (request) => {
      const { date } = parseWith(z.object({ date: day }), request.query);
      return { slots: await slotsFor(db, (request.params as { id: string }).id, date) };
    },
  );

  /* F3-2, F3-5 : rendez-vous */
  app.post(
    "/api/appointments",
    { preHandler: requirePermission("appointment:book") },
    async (request, reply) => {
      const b = parseWith(BookSchema, request.body);
      const appointment = await bookAppointment(db, contextOf(request), {
        patientId: b.patientId,
        practitionerId: b.practitionerId,
        startsAt: b.startsAt,
        ...(b.reason ? { reason: b.reason } : {}),
      });
      return reply.status(201).send(appointment);
    },
  );
  app.get(
    "/api/appointments",
    { preHandler: requirePermission("appointment:read") },
    async (request) => {
      const q = parseWith(
        z.object({
          practitionerId: z.string().optional(),
          date: day.optional(),
          patientId: z.string().uuid().optional(),
          status: z.string().optional(),
        }),
        request.query,
      );
      return {
        appointments: await listAppointments(db, {
          ...(q.practitionerId ? { practitionerId: q.practitionerId } : {}),
          ...(q.date ? { date: q.date } : {}),
          ...(q.patientId ? { patientId: q.patientId } : {}),
          ...(q.status ? { status: q.status } : {}),
        }),
      };
    },
  );
  app.post(
    "/api/appointments/:id/cancel",
    { preHandler: requirePermission("appointment:book") },
    async (request) =>
      cancelAppointment(
        db,
        contextOf(request),
        (request.params as { id: string }).id,
        parseWith(CancelSchema, request.body).reason,
      ),
  );
  app.post(
    "/api/appointments/:id/reschedule",
    { preHandler: requirePermission("appointment:book") },
    async (request) =>
      rescheduleAppointment(
        db,
        contextOf(request),
        (request.params as { id: string }).id,
        parseWith(RescheduleSchema, request.body).startsAt,
      ),
  );

  /* F3-5 : liste d'attente */
  app.post(
    "/api/waitlist",
    { preHandler: requirePermission("appointment:book") },
    async (request, reply) => {
      const w = parseWith(WaitlistSchema, request.body);
      const entry = await addToWaitlist(db, contextOf(request), {
        patientId: w.patientId,
        departmentCode: w.departmentCode,
        earliest: w.earliest,
        latest: w.latest,
        ...(w.practitionerId ? { practitionerId: w.practitionerId } : {}),
      });
      return reply.status(201).send(entry);
    },
  );
  app.post(
    "/api/waitlist/:id/accept",
    { preHandler: requirePermission("appointment:book") },
    async (request, reply) =>
      reply
        .status(201)
        .send(
          await acceptWaitlistOffer(db, contextOf(request), (request.params as { id: string }).id),
        ),
  );

  /* F3-3 : file d'attente */
  app.get("/api/queue", { preHandler: requirePermission("queue:read") }, async (request) => {
    const { department } = parseWith(z.object({ department: z.string().min(1) }), request.query);
    return { queue: await listQueue(db, department) };
  });
  app.get(
    "/api/queue/display",
    { preHandler: requirePermission("queue:read") },
    async (request) => {
      const { department } = parseWith(z.object({ department: z.string().min(1) }), request.query);
      return displayBoard(db, department);
    },
  );
  for (const action of ["call", "start", "done", "left"] as const) {
    app.post(
      `/api/queue/:id/${action}`,
      { preHandler: requirePermission("queue:manage") },
      async (request) =>
        moveQueueEntry(db, contextOf(request), (request.params as { id: string }).id, action),
    );
  }
}

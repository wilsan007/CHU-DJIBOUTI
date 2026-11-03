import type { Db } from "../../db.ts";
import { formatLocal } from "../../common/time.ts";
import { getReminderContact } from "../identity/interface.ts";

/**
 * Fournisseur de messages (SMS ou WhatsApp). Le choix du fournisseur se fait par ticket de décision :
 * ce module ne connaît que cette interface.
 */
export interface NotificationProvider {
  send(message: { to: string; text: string }): Promise<void>;
}

export interface ReminderReport {
  sent: number;
  skipped: number;
  failed: number;
}

/** Texte volontairement neutre : ni nom, ni motif, ni détail médical. */
export function reminderText(startsAt: Date, kind: "reminder" | "waitlist_offer"): string {
  const { date, time } = formatLocal(startsAt);
  if (kind === "waitlist_offer") {
    return `CHU Djibouti : un créneau s'est libéré le ${date} à ${time}. Contactez l'accueil pour le confirmer. | موعد متاح بتاريخ ${date} الساعة ${time}. اتصل بالاستقبال للتأكيد.`;
  }
  return `CHU Djibouti : rappel de votre rendez-vous le ${date} à ${time}. | تذكير بموعدك بتاريخ ${date} الساعة ${time}.`;
}

/**
 * Envoie les rappels arrivés à échéance. Un patient qui a refusé les rappels, un rendez-vous annulé
 * ou un numéro absent donnent un rappel « ignoré », jamais un envoi.
 */
export async function sendDueReminders(
  db: Db,
  provider: NotificationProvider,
  now: Date = new Date(),
): Promise<ReminderReport> {
  const report: ReminderReport = { sent: 0, skipped: 0, failed: 0 };
  const due = await db.query<{ id: string }>(
    "select id from appointments.reminders where status = 'pending' and due_at <= $1 order by due_at, id limit 200",
    [now],
  );
  for (const { id } of due.rows) {
    const client = await db.connect();
    try {
      await client.query("begin");
      const locked = await client.query<{
        patient_id: string;
        kind: "reminder" | "waitlist_offer";
        appointment_id: string | null;
        starts_at: Date | null;
        appt_status: string | null;
        offered_slot: Date | null;
      }>(
        `select r.patient_id, r.kind, r.appointment_id, a.starts_at, a.status as appt_status,
                (select w.offered_slot from appointments.waitlist w
                  where w.patient_id = r.patient_id and w.status = 'offered' order by w.offered_at desc limit 1) as offered_slot
           from appointments.reminders r left join appointments.appointments a on a.id = r.appointment_id
          where r.id = $1 and r.status = 'pending' for update of r skip locked`,
        [id],
      );
      const r = locked.rows[0];
      if (!r) {
        await client.query("rollback");
        continue;
      }
      const finish = async (status: "sent" | "skipped" | "failed", detail: string | null) => {
        await client.query(
          "update appointments.reminders set status = $2, detail = $3, sent_at = case when $2 = 'sent' then $4::timestamptz else null end where id = $1",
          [id, status, detail, now],
        );
        await client.query("commit");
        report[status] += 1;
      };
      const when = r.kind === "reminder" ? r.starts_at : r.offered_slot;
      if (r.kind === "reminder" && r.appt_status !== "booked") {
        await finish("skipped", "rendez-vous annulé ou passé");
        continue;
      }
      const contact = await getReminderContact(client, r.patient_id);
      if (!contact || contact.optOut) {
        await finish("skipped", "le patient refuse les rappels");
        continue;
      }
      if (!contact.phone || !when) {
        await finish("skipped", "numéro ou créneau absent");
        continue;
      }
      try {
        await provider.send({ to: contact.phone, text: reminderText(when, r.kind) });
        await finish("sent", null);
      } catch (error) {
        await finish("failed", error instanceof Error ? error.message : String(error));
      }
    } catch (error) {
      try {
        await client.query("rollback");
      } catch {
        // pas de transaction ouverte
      }
      throw error;
    } finally {
      client.release();
    }
  }
  return report;
}

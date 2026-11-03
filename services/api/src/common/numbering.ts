import type { Tx } from "../db.ts";

/**
 * Numéro suivant d'un compteur à numérotation continue (factures, avoirs, reçus, demandes, tickets).
 * La ligne du compteur est verrouillée jusqu'à la fin de la transaction : deux émetteurs simultanés
 * s'attendent, et un numéro pris par une transaction annulée est rendu. Aucun trou.
 */
export async function nextNumber(
  tx: Tx,
  schema:
    | "billing"
    | "orders"
    | "prescriptions"
    | "pharmacy"
    | "lab"
    | "hosp"
    | "imaging"
    | "stock"
    | "staff",
  counter: string,
  prefix: string,
  width = 6,
): Promise<string> {
  const res = await tx.query<{ value: string }>(
    `update ${schema}.counters set value = value + 1 where name = $1 returning value`,
    [counter],
  );
  const row = res.rows[0];
  if (!row) {
    // Compteur créé à la demande (un par service pour les tickets).
    const created = await tx.query<{ value: string }>(
      `insert into ${schema}.counters (name, value) values ($1, 1)
         on conflict (name) do update set value = ${schema}.counters.value + 1 returning value`,
      [counter],
    );
    return `${prefix}-${String(created.rows[0]?.value).padStart(width, "0")}`;
  }
  return `${prefix}-${String(row.value).padStart(width, "0")}`;
}

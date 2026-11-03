/** Montants en francs Djibouti, entiers, sans centimes. */

/** Répartit un total entre part du patient et part du payeur ; la somme est toujours exacte. */
export function splitAmount(
  total: number,
  patientShare: number,
): { patientAmount: number; payerAmount: number } {
  const patientAmount = Math.round(total * patientShare);
  return { patientAmount, payerAmount: total - patientAmount };
}

/**
 * Répartit un montant entier proportionnellement à des poids (méthode du plus grand reste).
 * La somme des parts est exactement égale au montant : aucune perte d'arrondi.
 */
export function allocate(amount: number, weights: readonly number[]): number[] {
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (weights.length === 0) return [];
  if (totalWeight <= 0) {
    const shares = weights.map(() => 0);
    shares[0] = amount;
    return shares;
  }
  const raw = weights.map((w) => (amount * w) / totalWeight);
  const shares = raw.map((r) => Math.floor(r));
  let left = amount - shares.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, rest: r - Math.floor(r) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] = (shares[i] ?? 0) + 1;
    left -= 1;
  }
  return shares;
}

/** Djibouti est à UTC+3 toute l'année, sans heure d'été : les jours comptables suivent ce décalage. */
export const LOCAL_OFFSET_HOURS = 3;

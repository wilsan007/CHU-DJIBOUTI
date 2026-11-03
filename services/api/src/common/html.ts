/** Échappement HTML : toute valeur saisie qui entre dans une page imprimable passe par ici (les pages s'ouvrent dans le navigateur du personnel). */
export const esc = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );

/** Erreur métier : porte un code stable (pour l'interface) et un statut HTTP. */
export class DomainError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(code: string, message: string, status = 400, details?: unknown) {
    super(message);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const notFound = (what: string): DomainError =>
  new DomainError("not_found", `${what} introuvable.`, 404);

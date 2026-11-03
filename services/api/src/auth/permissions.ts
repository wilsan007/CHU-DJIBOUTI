/**
 * Rôles et droits. Un rôle n'a que les droits nécessaires à son travail (plan, section 10).
 * Les rôles viennent de Keycloak. Par rapport à la liste du plan (étape 5.4) :
 * - `biologist` : la validation en deux temps du laboratoire (F7-6) exige deux rôles distincts ;
 * - `imaging` : le service d'imagerie reçoit ses tickets comme le laboratoire.
 */

export const ROLES = [
  "reception",
  "cashier",
  "doctor",
  "nurse",
  "lab",
  "biologist",
  "imaging",
  "pharmacy",
  "storekeeper",
  "hr",
  "direction",
  "admin",
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  "patient:read",
  "patient:create",
  "patient:merge",
  "patient:link-provisional",
  "patient:import",
  "catalog:read",
  "catalog:manage",
  "billing:read",
  "billing:admit",
  "billing:pay",
  "billing:credit",
  "billing:discount",
  "billing:discount-any",
  "billing:report",
  "order:place",
  "order:read",
  "voucher:print",
  "ticket:work",
  "appointment:read",
  "appointment:book",
  "schedule:manage",
  "queue:read",
  "queue:manage",
  "clinical:read",
  "clinical:write",
  "prescription:write",
  "prescription:read",
  "lab:read",
  "imaging:read",
  "imaging:write",
  "lab:write",
  "lab:validate-tech",
  "lab:validate-bio",
  "lab:configure",
  "pharmacy:dispense",
  "stay:read",
  "stay:manage",
  "stay:admit",
  "stay:discharge",
  "stay:exit-unpaid",
  "stock:read",
  "stock:manage",
  "stock:consume",
  "stock:recipes",
  "dashboard:read",
  "audit:read",
  "staff:directory",
  "staff:roster-read",
  "staff:manage",
  "staff:roster",
  "leave:approve",
  "admin:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const BASE_ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  reception: [
    "patient:read",
    "patient:create",
    "patient:link-provisional",
    "catalog:read",
    "billing:read",
    "billing:admit",
    "appointment:read",
    "appointment:book",
    "queue:read",
    "queue:manage",
  ],
  // La caisse encaisse, valide les paiements, remet le bon de prestations et corrige par avoir.
  cashier: [
    "patient:read",
    "catalog:read",
    "billing:read",
    "billing:pay",
    "billing:credit",
    "billing:discount",
    "billing:report",
    "order:read",
    "voucher:print",
  ],
  doctor: [
    "patient:read",
    "patient:create",
    "patient:link-provisional",
    "catalog:read",
    "clinical:read",
    "clinical:write",
    "prescription:write",
    "prescription:read",
    "order:place",
    "order:read",
    "stock:consume",
    "lab:read",
    "imaging:read",
    "stay:read",
    "stay:manage",
    "stay:discharge",
    "appointment:read",
    "appointment:book",
    "queue:read",
    "queue:manage",
  ],
  nurse: [
    "patient:read",
    "patient:create",
    "catalog:read",
    "clinical:read",
    "clinical:write",
    "order:place",
    "ticket:work",
    "stock:consume",
    "stay:read",
    "stay:manage",
    "stay:admit",
    "queue:read",
    "queue:manage",
  ],
  lab: [
    "patient:read",
    "lab:read",
    "lab:write",
    "lab:validate-tech",
    "ticket:work",
    "stock:consume",
  ],
  biologist: [
    "patient:read",
    "lab:read",
    "lab:write",
    "lab:validate-bio",
    "lab:configure",
    "ticket:work",
    "stock:consume",
  ],
  imaging: ["patient:read", "imaging:read", "imaging:write", "ticket:work", "stock:consume"],
  pharmacy: [
    "patient:read",
    "catalog:read",
    "prescription:read",
    "pharmacy:dispense",
    "stock:read",
    "stock:manage",
    "stock:consume",
  ],
  // Le magasin gère consommables, réactifs et fournitures ; il n'a aucun accès aux dossiers de patients.
  // Les ressources humaines gèrent les agents, leurs licences, le planning et les congés ; aucun accès aux dossiers de patients.
  hr: ["catalog:read", "staff:manage", "staff:roster", "leave:approve"],
  storekeeper: ["catalog:read", "stock:read", "stock:manage", "stock:consume", "stock:recipes"],
  // La direction ne voit que des chiffres agrégés, jamais un dossier.
  direction: ["dashboard:read", "billing:report", "billing:discount-any", "stay:exit-unpaid"],
  admin: [
    "patient:read",
    "patient:create",
    "patient:merge",
    "patient:link-provisional",
    "patient:import",
    "catalog:read",
    "catalog:manage",
    "billing:credit",
    "billing:report",
    "order:read",
    "appointment:read",
    "schedule:manage",
    "audit:read",
    "stock:recipes",
    "admin:manage",
  ],
};

/**
 * Tout agent voit l'annuaire minimal (nom, fonction, service) et le planning de garde ; la direction ne voit que des chiffres.
 * Les données personnelles des agents restent aux ressources humaines (`staff:manage`).
 */
export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = Object.fromEntries(
  ROLES.map((role) => [
    role,
    role === "direction"
      ? BASE_ROLE_PERMISSIONS[role]
      : [...BASE_ROLE_PERMISSIONS[role], "staff:directory", "staff:roster-read"],
  ]),
) as Record<Role, readonly Permission[]>;

/**
 * Services qu'un rôle peut servir : un technicien de laboratoire ne voit pas les tickets de l'imagerie.
 * Codes de service du catalogue (migration 0004).
 */
export const DEPARTMENT_ACCESS: Partial<Record<Role, readonly string[]>> = {
  lab: ["LAB"],
  biologist: ["LAB"],
  imaging: ["IMG"],
  nurse: ["HOSP"],
};

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export function can(roles: readonly Role[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}

export function canServeDepartment(roles: readonly Role[], department: string): boolean {
  return roles.some((role) => DEPARTMENT_ACCESS[role]?.includes(department));
}

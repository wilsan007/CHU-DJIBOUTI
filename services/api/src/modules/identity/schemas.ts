import { z } from "zod";

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date attendue au format AAAA-MM-JJ")
  .refine((value) => {
    const d = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
  }, "Date inexistante")
  .refine((value) => value <= new Date().toISOString().slice(0, 10), "Date dans le futur");

const sex = z.enum(["female", "male"]);

/**
 * Histoire F1-1 : nom, prénom, sexe, date de naissance (ou âge estimé), téléphone obligatoires.
 * Question ouverte : un patient sans téléphone (voir docs/questions.md).
 */
export const CreatePatientSchema = z
  .object({
    givenName: z.string().trim().min(1).max(100),
    familyName: z.string().trim().min(1).max(100),
    sex,
    birthDate: isoDate.optional(),
    estimatedAge: z.number().int().min(0).max(120).optional(),
    phone: z.string().trim().min(3).max(30),
    externalId: z.string().trim().min(1).max(64).optional(),
    confirmNotDuplicate: z.boolean().optional(),
  })
  .refine((v) => (v.birthDate === undefined) !== (v.estimatedAge === undefined), {
    message: "Indiquez soit la date de naissance, soit l'âge estimé (pas les deux).",
    path: ["birthDate"],
  });
export type CreatePatientInput = z.infer<typeof CreatePatientSchema>;

/** Histoire F1-5 : patient inconnu en urgence, trois champs au plus. */
export const CreateProvisionalSchema = z
  .object({
    sex: sex.optional(),
    estimatedAge: z.number().int().min(0).max(120).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type CreateProvisionalInput = z.infer<typeof CreateProvisionalSchema>;

export const MergeSchema = z.object({
  survivorId: z.string().uuid(),
  mergedId: z.string().uuid(),
  reason: z.string().trim().min(3).max(300),
});
export type MergeInput = z.infer<typeof MergeSchema>;

export const LinkSchema = z.object({
  patientId: z.string().uuid(),
});

export const SearchSchema = z.object({
  q: z.string().trim().min(2).max(100),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const PreferencesSchema = z.object({ reminderOptOut: z.boolean() }).strict();

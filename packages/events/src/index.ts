import { z } from "zod";

/**
 * Contrat d'événement (plan, section 6) : un type = un schéma. Toute modification d'un schéma
 * augmente `version`. Pas de données cliniques en clair quand une référence FHIR suffit.
 */

const uuid = z.string().uuid();
const money = z.number().int().nonnegative(); // francs Djibouti, sans centimes
const datetime = z.string().datetime({ offset: true });

export const ActorSchema = z.object({
  userId: z.string().min(1),
  role: z.string().min(1),
});

/** Personne qui a accompli une étape : sert à la traçabilité (qui a demandé, encaissé, exécuté). */
export const PersonSchema = z.object({
  userId: z.string().min(1),
  name: z.string().min(1).optional(),
});

const envelope = {
  eventId: uuid,
  version: z.number().int().positive(),
  occurredAt: datetime,
  patientId: uuid.nullable(),
  actor: ActorSchema,
};

const define = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ ...envelope, type: z.literal(type), payload });

/* ------------------------------------------------------------ identité */

export const PatientCreatedSchema = define(
  "PatientCreated",
  z.object({
    fhirResource: z.string().regex(/^Patient\/[0-9a-f-]{36}$/),
    identifier: z.string().min(1),
    kind: z.enum(["regular", "provisional"]),
  }),
);

export const PatientMergedSchema = define(
  "PatientMerged",
  z.object({
    survivorId: uuid,
    mergedId: uuid,
    survivorIdentifier: z.string().min(1),
    mergedIdentifier: z.string().min(1),
  }),
);

/* ------------------------------------------------------------ admission et facturation */

export const EncounterStartedSchema = define(
  "EncounterStarted",
  z.object({
    encounterId: uuid,
    departmentCode: z.string().min(1),
    payerCode: z.string().min(1),
    invoiceId: uuid,
  }),
);

export const InvoiceIssuedSchema = define(
  "InvoiceIssued",
  z.object({
    invoiceId: uuid,
    invoiceNumber: z.string().min(1),
    encounterId: uuid.nullable(),
    orderId: uuid.nullable(),
    total: money,
    patientAmount: money,
    payerAmount: money,
  }),
);

export const InvoicePaidSchema = define(
  "InvoicePaid",
  z.object({
    invoiceId: uuid,
    invoiceNumber: z.string().min(1),
    encounterId: uuid.nullable(),
    orderId: uuid.nullable(),
    amount: money,
    method: z.enum(["cash", "mobile", "card", "exempt"]),
    receiptNumber: z.string().min(1),
    /** La personne de la caisse qui a validé le paiement. */
    validatedBy: PersonSchema,
    paidAt: datetime,
  }),
);

export const InvoiceCreditedSchema = define(
  "InvoiceCredited",
  z.object({
    invoiceId: uuid,
    orderId: uuid.nullable(),
    creditNoteId: uuid,
    creditNoteNumber: z.string().min(1),
    reason: z.string().min(1),
  }),
);

/* ------------------------------------------------------------ prestations demandées par le médecin */

const orderItem = z.object({
  actCode: z.string().min(1),
  quantity: z.number().int().positive(),
  departmentCode: z.string().min(1),
  unitPrice: money,
});

export const ServiceOrderPlacedSchema = define(
  "ServiceOrderPlaced",
  z.object({
    orderId: uuid,
    orderNumber: z.string().min(1),
    encounterId: uuid,
    placedBy: PersonSchema,
    items: z.array(orderItem).min(1),
  }),
);

export const ServiceOrderReleasedSchema = define(
  "ServiceOrderReleased",
  z.object({
    orderId: uuid,
    orderNumber: z.string().min(1),
    /** La personne de la caisse dont la validation a libéré la demande. */
    releasedBy: PersonSchema,
    tickets: z
      .array(
        z.object({ ticketId: uuid, code: z.string().min(1), departmentCode: z.string().min(1) }),
      )
      .min(1),
  }),
);

const serviceStep = z.object({
  ticketId: uuid,
  ticketCode: z.string().min(1),
  orderId: uuid,
  departmentCode: z.string().min(1),
  by: PersonSchema,
});

export const DepartmentServiceStartedSchema = define("DepartmentServiceStarted", serviceStep);
export const DepartmentServiceCompletedSchema = define("DepartmentServiceCompleted", serviceStep);

/* ------------------------------------------------------------ rendez-vous */

export const AppointmentBookedSchema = define(
  "AppointmentBooked",
  z.object({
    appointmentId: uuid,
    departmentCode: z.string().min(1),
    practitionerId: z.string().min(1),
    startsAt: datetime,
  }),
);

export const AppointmentCancelledSchema = define(
  "AppointmentCancelled",
  z.object({
    appointmentId: uuid,
    departmentCode: z.string().min(1),
    practitionerId: z.string().min(1),
    startsAt: datetime,
    reason: z.string().min(1),
  }),
);

export const WaitlistSlotOfferedSchema = define(
  "WaitlistSlotOffered",
  z.object({
    waitlistEntryId: uuid,
    practitionerId: z.string().min(1),
    startsAt: datetime,
  }),
);

/* ------------------------------------------------------------ consultation et ordonnances */

export const ConsultationClosedSchema = define(
  "ConsultationClosed",
  z.object({
    consultationId: uuid,
    encounterId: uuid,
    diagnosisCodes: z.array(z.string().min(1)).min(1),
    closedBy: PersonSchema,
  }),
);

export const PrescriptionCreatedSchema = define(
  "PrescriptionCreated",
  z.object({
    prescriptionId: uuid,
    number: z.string().min(1),
    consultationId: uuid,
    /** Ordonnance remplacée par celle-ci (révision), sinon null. */
    supersedes: uuid.nullable(),
    lineCount: z.number().int().positive(),
    hadOverrides: z.boolean(),
    prescribedBy: PersonSchema,
  }),
);

/* ------------------------------------------------------------ pharmacie */

export const MedicationDispensedSchema = define(
  "MedicationDispensed",
  z.object({
    dispensationId: uuid,
    number: z.string().min(1),
    prescriptionId: uuid,
    /** Etat de l'ordonnance après cette délivrance. */
    prescriptionStatus: z.enum(["partially_dispensed", "dispensed"]),
    lines: z
      .array(
        z.object({
          drugCode: z.string().min(1),
          lotNumber: z.string().min(1),
          quantity: z.number().int().positive(),
        }),
      )
      .min(1),
    dispensedBy: PersonSchema,
  }),
);

export const StockBelowThresholdSchema = define(
  "StockBelowThreshold",
  z.object({
    itemCode: z.string().min(1),
    total: z.number().int().nonnegative(),
    minimum: z.number().int().nonnegative(),
  }),
);

/* ------------------------------------------------------------ laboratoire */

export const LabOrderCreatedSchema = define(
  "LabOrderCreated",
  z.object({
    requestId: uuid,
    requestNumber: z.string().min(1),
    orderId: uuid,
    ticketCode: z.string().min(1),
    /** Codes LOINC des analyses demandées. */
    loincCodes: z.array(z.string().min(1)),
    testCount: z.number().int().positive(),
  }),
);

export const LabSpecimenRejectedSchema = define(
  "LabSpecimenRejected",
  z.object({
    requestId: uuid,
    specimenId: uuid,
    specimenNumber: z.string().min(1),
    reason: z.string().min(1),
    rejectedBy: PersonSchema,
    prescriberId: z.string().min(1),
  }),
);

export const LabResultValidatedSchema = define(
  "LabResultValidated",
  z.object({
    requestId: uuid,
    specimenId: uuid,
    orderId: uuid,
    results: z
      .array(
        z.object({
          loincCode: z.string().min(1),
          flag: z.enum(["normal", "low", "high", "critical_low", "critical_high", "none"]),
        }),
      )
      .min(1),
    hasCritical: z.boolean(),
    technicalBy: PersonSchema,
    biologicalBy: PersonSchema,
    requestComplete: z.boolean(),
  }),
);

/* ------------------------------------------------------------ hospitalisation */

export const StayAdmittedSchema = define(
  "StayAdmitted",
  z.object({
    stayId: uuid,
    stayNumber: z.string().min(1),
    bedCode: z.string().min(1),
    initialOrderId: uuid,
    admittedBy: PersonSchema,
  }),
);

export const StayDischargedSchema = define(
  "StayDischarged",
  z.object({
    stayId: uuid,
    stayNumber: z.string().min(1),
    nights: z.number().int().positive(),
    /** Facture de sortie ; nulle quand rien n'était à facturer en plus du forfait initial. */
    finalInvoiceId: uuid.nullable(),
    /** Vrai si le patient est parti avec la facture de sortie impayée (autorisation de la direction). */
    exitedUnpaid: z.boolean(),
    exitedBy: PersonSchema,
  }),
);

/* ------------------------------------------------------------ imagerie */

export const ImagingReportFinalizedSchema = define(
  "ImagingReportFinalized",
  z.object({
    requestId: uuid,
    requestNumber: z.string().min(1),
    accession: z.string().min(1),
    actCode: z.string().min(1),
    orderId: uuid,
    imageCount: z.number().int().nonnegative(),
    reportedBy: PersonSchema,
  }),
);

/** Union de tous les événements connus. Les autres types sont ajoutés avec leur module. */
export const EventSchema = z.discriminatedUnion("type", [
  PatientCreatedSchema,
  PatientMergedSchema,
  EncounterStartedSchema,
  InvoiceIssuedSchema,
  InvoicePaidSchema,
  InvoiceCreditedSchema,
  ServiceOrderPlacedSchema,
  ServiceOrderReleasedSchema,
  DepartmentServiceStartedSchema,
  DepartmentServiceCompletedSchema,
  AppointmentBookedSchema,
  AppointmentCancelledSchema,
  WaitlistSlotOfferedSchema,
  ConsultationClosedSchema,
  PrescriptionCreatedSchema,
  MedicationDispensedSchema,
  StockBelowThresholdSchema,
  LabOrderCreatedSchema,
  LabSpecimenRejectedSchema,
  LabResultValidatedSchema,
  StayAdmittedSchema,
  StayDischargedSchema,
  ImagingReportFinalizedSchema,
]);

export type DomainEvent = z.infer<typeof EventSchema>;
export type EventType = DomainEvent["type"];
export type Actor = z.infer<typeof ActorSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type EventOf<T extends EventType> = Extract<DomainEvent, { type: T }>;

export const EVENT_TYPES = EventSchema.options.map((o) => o.shape.type.value) as EventType[];

/** Valide un message. Lève une erreur si le message ne respecte pas le contrat. */
export function parseEvent(input: unknown): DomainEvent {
  return EventSchema.parse(input);
}

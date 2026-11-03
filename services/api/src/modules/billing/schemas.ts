import { z } from "zod";

export const AdmitSchema = z.object({
  patientId: z.string().uuid(),
  departmentCode: z.string().trim().min(1).max(20),
  payerCode: z.string().trim().min(1).max(40),
  actCode: z.string().trim().min(1).max(40),
});
export type AdmitInput = z.infer<typeof AdmitSchema>;

export const QuoteSchema = z.object({
  payerCode: z.string().trim().min(1).max(40),
  items: z
    .array(
      z.object({
        actCode: z.string().trim().min(1).max(40),
        quantity: z.number().int().min(1).max(50),
      }),
    )
    .min(1)
    .max(30),
});

export const PaySchema = z.object({
  method: z.enum(["cash", "mobile", "card", "exempt"]),
  /** Espèces remises par le patient : sert à calculer la monnaie à rendre. */
  receivedAmount: z.number().int().nonnegative().optional(),
});
export type PayInput = z.infer<typeof PaySchema>;

export const CreditSchema = z.object({ reason: z.string().trim().min(3).max(300) });

export const CloseSessionSchema = z.object({ countedCash: z.number().int().nonnegative() });

export const InvoiceListSchema = z.object({
  status: z.enum(["pending", "paid", "credited"]).optional(),
  patientId: z.string().uuid().optional(),
  orderNumber: z.string().trim().max(30).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Les plus récentes d'abord (écran de caisse : factures payées du jour pour un avoir). */
  newest: z.enum(["true", "false"]).default("false"),
});

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const RevenueSchema = z.object({
  from: day,
  to: day,
  groupBy: z.enum(["day", "department", "cashier"]).default("day"),
  format: z.enum(["json", "csv"]).default("json"),
});

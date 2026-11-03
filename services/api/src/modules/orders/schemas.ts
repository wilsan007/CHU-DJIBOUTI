import { z } from "zod";

export const PlaceOrderSchema = z.object({
  patientId: z.string().uuid(),
  encounterId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
  items: z
    .array(
      z.object({
        actCode: z.string().trim().min(1).max(40),
        quantity: z.number().int().min(1).max(50),
      }),
    )
    .min(1)
    .max(20),
});
export type PlaceOrderInput = z.infer<typeof PlaceOrderSchema>;

export const OrderListSchema = z.object({
  patientId: z.string().uuid().optional(),
  status: z.enum(["awaiting_payment", "released", "completed", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const TicketListSchema = z.object({
  department: z.string().trim().min(1).max(20),
  status: z.enum(["sent", "in_progress", "completed", "cancelled"]).optional(),
});

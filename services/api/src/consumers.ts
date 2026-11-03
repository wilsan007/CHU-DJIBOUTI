import type { Consumer } from "./events/dispatcher.ts";
import { appointmentConsumers } from "./modules/appointments/consumers.ts";
import { billingConsumers } from "./modules/billing/consumers.ts";
import { imagingConsumers } from "./modules/imaging/consumers.ts";
import { stockConsumers } from "./modules/stock/consumers.ts";
import { labConsumers } from "./modules/lab/consumers.ts";
import { ordersConsumers } from "./modules/orders/consumers.ts";

/** Tous les consommateurs d'événements de l'application, enregistrés auprès du distributeur. */
export function allConsumers(): Consumer[] {
  return [
    ...billingConsumers,
    ...ordersConsumers,
    ...appointmentConsumers,
    ...labConsumers,
    ...imagingConsumers,
    ...stockConsumers,
  ];
}

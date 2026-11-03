import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ErrorBox, fdj } from "../ui.tsx";

interface Dashboard {
  date: string;
  activity: Record<string, number>;
  revenue: {
    collected: number;
    byMethod: Record<string, { count: number; amount: number }>;
    creditNotes: { count: number; amount: number };
    net: number;
  };
  stock: {
    belowThreshold: number;
    expiredLots: number;
    expiringLots: number;
    openShortfalls: number;
  };
  waiting: {
    waitingNow: number;
    averageWaitMinutes: number | null;
    byDepartment: { department: string; called: number; averageWaitMinutes: number | null }[];
  };
  results: {
    pendingRequests: number;
    completedToday: number;
    averageTurnaroundMinutes: number | null;
  };
  hospitalization: {
    totalBeds: number;
    occupiedBeds: number;
    admittedToday: number;
    dischargedToday: number;
  };
  staff: {
    active: number;
    patientContact: number;
    onLeaveToday: number;
    onDutyNow: Record<string, number>;
  };
}

function Tile({
  id,
  label,
  value,
  alert,
}: {
  id: string;
  label: string;
  value: ReactNode;
  alert?: boolean;
}): ReactNode {
  return (
    <div className={alert ? "tile alert" : "tile"} data-tile={id}>
      <span className="tile-value">{value}</span>
      <span className="tile-label">{label}</span>
    </div>
  );
}

const minutes = (v: number | null): string => (v === null ? t("direction.none") : String(v));

/** Tableau de bord de direction : uniquement des chiffres agrégés, jamais un dossier de patient. */
export function Direction(): ReactNode {
  const [date, setDate] = useState(new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10));
  const [d, setD] = useState<Dashboard | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setD(await api<Dashboard>(`/api/dashboard?date=${date}`));
    } catch (e) {
      setError(e);
    }
  }, [date]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  return (
    <section>
      <h1>{t("direction.title")}</h1>
      <label>
        {t("direction.date")}
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      {d && (
        <>
          <h2>{t("direction.activity")}</h2>
          <div className="tiles">
            {(
              [
                "admissions",
                "consultationsClosed",
                "ordersPlaced",
                "ordersReleased",
                "dispensations",
                "labRequestsCreated",
              ] as const
            ).map((k) => (
              <Tile key={k} id={k} label={t(`direction.${k}`)} value={d.activity[k] ?? 0} />
            ))}
            <Tile
              id="emergencyUnpaid"
              label={t("direction.emergencyUnpaid")}
              value={d.activity.emergencyUnpaid ?? 0}
              alert={(d.activity.emergencyUnpaid ?? 0) > 0}
            />
          </div>

          <h2>{t("direction.revenue")}</h2>
          <div className="tiles">
            <Tile
              id="collected"
              label={t("direction.revenue.collected")}
              value={fdj(d.revenue.collected)}
            />
            <Tile
              id="credits"
              label={t("direction.revenue.credits")}
              value={fdj(d.revenue.creditNotes.amount)}
            />
            <Tile id="net" label={t("direction.revenue.net")} value={fdj(d.revenue.net)} />
            {Object.entries(d.revenue.byMethod).map(([m, v]) => (
              <Tile
                key={m}
                id={`method-${m}`}
                label={`${t(`cashier.method.${m}`)} (${v.count})`}
                value={fdj(v.amount)}
              />
            ))}
          </div>

          <h2>{t("direction.stock")}</h2>
          <div className="tiles">
            <Tile
              id="belowThreshold"
              label={t("direction.stock.belowThreshold")}
              value={d.stock.belowThreshold}
              alert={d.stock.belowThreshold > 0}
            />
            <Tile
              id="expiredLots"
              label={t("direction.stock.expiredLots")}
              value={d.stock.expiredLots}
              alert={d.stock.expiredLots > 0}
            />
            <Tile
              id="expiringLots"
              label={t("direction.stock.expiringLots")}
              value={d.stock.expiringLots}
            />
            <Tile
              id="openShortfalls"
              label={t("direction.stock.openShortfalls")}
              value={d.stock.openShortfalls}
              alert={d.stock.openShortfalls > 0}
            />
          </div>

          <h2>{t("direction.waiting")}</h2>
          <div className="tiles">
            <Tile id="waitingNow" label={t("direction.waiting.now")} value={d.waiting.waitingNow} />
            <Tile
              id="averageWait"
              label={t("direction.waiting.avg")}
              value={minutes(d.waiting.averageWaitMinutes)}
            />
            <Tile
              id="pendingResults"
              label={t("direction.results.pending")}
              value={d.results.pendingRequests}
            />
            <Tile
              id="turnaround"
              label={t("direction.results.turnaround")}
              value={minutes(d.results.averageTurnaroundMinutes)}
            />
          </div>

          <h2>{t("direction.beds")}</h2>
          <div className="tiles">
            <Tile
              id="occupiedBeds"
              label={t("direction.beds.occupied")}
              value={`${d.hospitalization.occupiedBeds} / ${d.hospitalization.totalBeds}`}
            />
            <Tile
              id="admittedToday"
              label={t("direction.beds.admittedToday")}
              value={d.hospitalization.admittedToday}
            />
            <Tile
              id="dischargedToday"
              label={t("direction.beds.dischargedToday")}
              value={d.hospitalization.dischargedToday}
            />
          </div>

          <h2>{t("direction.staff")}</h2>
          <div className="tiles">
            <Tile id="staffActive" label={t("direction.staff.active")} value={d.staff.active} />
            <Tile
              id="staffContact"
              label={t("direction.staff.patientContact")}
              value={d.staff.patientContact}
            />
            <Tile
              id="staffLeave"
              label={t("direction.staff.onLeave")}
              value={d.staff.onLeaveToday}
            />
            {Object.entries(d.staff.onDutyNow).map(([dep, n]) => (
              <Tile
                key={dep}
                id={`duty-${dep}`}
                label={`${t("direction.staff.onDuty")} · ${dep}`}
                value={n}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

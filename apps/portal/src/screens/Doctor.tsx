import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { label, t } from "../i18n.ts";
import { ErrorBox, Notice } from "../ui.tsx";
import { ConsultationPanel } from "./Consultation.tsx";

interface Entry {
  id: string;
  ticket: string;
  status: string;
  priority: number;
  waitingMinutes: number;
  patientId: string;
  encounterId: string | null;
  patient?: { name: string; identifier: string };
}
interface Act {
  code: string;
  labelFr: string;
  labelAr: string;
  tariff: number;
  category: string;
}
interface Banner {
  name: string;
  identifier: string;
  age: number | null;
  allergies: { label: string; severity: string }[];
}
interface LabResult {
  id: number;
  labelFr: string;
  labelAr: string;
  value: number | string | null;
  unit: string | null;
  flag: string;
  requestNumber: string;
}
interface Notification {
  id: number;
  kind: string;
  message: string;
  createdAt: string;
}

export function Doctor(): ReactNode {
  const [queue, setQueue] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Entry | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setQueue((await api<{ queue: Entry[] }>("/api/queue?department=CONS")).queue);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const call = async (e: Entry): Promise<void> => {
    setError(null);
    try {
      if (e.status === "waiting") await api(`/api/queue/${e.id}/call`, { method: "POST" });
      setSelected(e);
      await load();
    } catch (err) {
      setError(err);
    }
  };

  return (
    <section>
      <h1>{t("doctor.title")}</h1>
      <ErrorBox error={error} />
      <Notice>{notice}</Notice>
      <Notifications />
      <div className="cols">
        <div className="card">
          {queue.length === 0 && <p className="muted">{t("common.none")}</p>}
          <ul className="list">
            {queue
              .filter(
                (e) =>
                  e.status === "waiting" || e.status === "called" || e.status === "in_consultation",
              )
              .map((e) => (
                <li key={e.id}>
                  <button
                    className={selected?.id === e.id ? "row active" : "row"}
                    onClick={() => void call(e)}
                    data-ticket={e.ticket}
                  >
                    <strong>{e.ticket}</strong> {e.patient?.name}{" "}
                    <span className="muted">
                      {t("doctor.waiting", { minutes: e.waitingMinutes })}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </div>
        <div className="card">
          {selected ? (
            <PatientPanel key={selected.id} entry={selected} onSent={setNotice} />
          ) : (
            <p className="muted">{t("common.none")}</p>
          )}
        </div>
      </div>
    </section>
  );
}

/** Messages du laboratoire au prescripteur : valeurs critiques (avec accusé de réception) et rejets d'échantillon. */
function Notifications(): ReactNode {
  const [list, setList] = useState<Notification[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setList(
        (await api<{ notifications: Notification[] }>("/api/lab/notifications?open=true"))
          .notifications,
      );
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const ack = async (id: number): Promise<void> => {
    try {
      await api(`/api/lab/notifications/${id}/acknowledge`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e);
    }
  };
  if (list.length === 0 && !error) return null;
  return (
    <div className="card" data-notifications>
      <h2>{t("doctor.notifications")}</h2>
      <ErrorBox error={error} />
      {list.map((n) => (
        <div
          key={n.id}
          role="alert"
          className={
            n.kind === "critical" || n.kind === "escalation" ? "warn critical-box" : "warn"
          }
          data-notification={n.kind}
        >
          <span className="badge">{t(`doctor.notifications.kind.${n.kind}`)}</span> {n.message}{" "}
          <button onClick={() => void ack(n.id)}>{t("doctor.notifications.ack")}</button>
        </div>
      ))}
    </div>
  );
}

function PatientPanel({ entry, onSent }: { entry: Entry; onSent: (m: string) => void }): ReactNode {
  const [banner, setBanner] = useState<Banner | null>(null);
  const [error, setError] = useState<unknown>(null);

  const loadBanner = useCallback(async () => {
    try {
      setBanner(await api<Banner>(`/api/patients/${entry.patientId}/banner`));
    } catch (e) {
      setError(e);
    }
  }, [entry.patientId]);
  useEffect(() => {
    void loadBanner();
  }, [loadBanner]);

  return (
    <div className="form">
      <h2>
        {banner?.name}{" "}
        <span className="muted">
          {banner?.identifier}
          {banner?.age !== null && banner?.age !== undefined ? ` · ${banner.age}` : ""}
        </span>
      </h2>
      <ErrorBox error={error} />
      {banner && banner.allergies.length > 0 && (
        <p className="warn" data-allergies>
          {t("doctor.allergies")} : {banner.allergies.map((a) => a.label).join(", ")}
        </p>
      )}
      <AddAllergy patientId={entry.patientId} onAdded={loadBanner} />
      {entry.encounterId && (
        <ConsultationPanel patientId={entry.patientId} encounterId={entry.encounterId} />
      )}
      <Results patientId={entry.patientId} />
      <OrderForm entry={entry} onSent={onSent} />
    </div>
  );
}

function AddAllergy({
  patientId,
  onAdded,
}: {
  patientId: string;
  onAdded: () => Promise<void>;
}): ReactNode {
  const [cls, setCls] = useState("");
  const [text, setText] = useState("");
  const [error, setError] = useState<unknown>(null);
  const add = async (): Promise<void> => {
    setError(null);
    try {
      await api(`/api/patients/${patientId}/allergies`, {
        method: "POST",
        body: { substanceClass: cls.trim(), label: text.trim(), severity: "unknown" },
      });
      setCls("");
      setText("");
      await onAdded();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <details>
      <summary>{t("consult.allergy.add")}</summary>
      <div className="inline">
        <input
          aria-label={t("consult.allergy.class")}
          placeholder={t("consult.allergy.class")}
          value={cls}
          onChange={(e) => setCls(e.target.value)}
        />
        <input
          aria-label={t("consult.allergy.label")}
          placeholder={t("consult.allergy.label")}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button disabled={!cls.trim() || !text.trim()} onClick={() => void add()}>
          {t("consult.vital.add")}
        </button>
      </div>
      <ErrorBox error={error} />
    </details>
  );
}

/** Le médecin ne voit que les résultats validés par le biologiste. */
function Results({ patientId }: { patientId: string }): ReactNode {
  const [results, setResults] = useState<LabResult[]>([]);
  useEffect(() => {
    const load = (): void => {
      api<{ results: LabResult[] }>(`/api/lab/patients/${patientId}/results`)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [patientId]);
  if (results.length === 0) return null;
  return (
    <div data-results>
      <h3>{t("doctor.results")}</h3>
      <ul className="plain">
        {results.map((r) => (
          <li key={r.id}>
            {label(r.labelFr, r.labelAr)} : <strong>{r.value}</strong> {r.unit}{" "}
            <span
              className={
                r.flag.startsWith("critical")
                  ? "flag critical"
                  : r.flag === "normal"
                    ? "flag ok"
                    : "flag abnormal"
              }
            >
              {t(`lab.flag.${r.flag}`)}
            </span>{" "}
            <span className="muted">{r.requestNumber}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function OrderForm({ entry, onSent }: { entry: Entry; onSent: (m: string) => void }): ReactNode {
  const [acts, setActs] = useState<Act[]>([]);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void Promise.all(
      ["laboratory", "imaging", "hospitalization"].map((c) =>
        api<Act[]>(`/api/catalog/acts?category=${c}`),
      ),
    )
      .then((lists) => setActs(lists.flat()))
      .catch(setError);
  }, []);

  const send = async (): Promise<void> => {
    setError(null);
    try {
      const order = await api<{ number: string }>("/api/service-orders", {
        method: "POST",
        body: {
          patientId: entry.patientId,
          encounterId: entry.encounterId,
          items: [...picked].map((actCode) => ({ actCode, quantity: 1 })),
        },
      });
      setPicked(new Set());
      onSent(t("doctor.orderSent", { number: order.number }));
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div>
      <h3>{t("doctor.order")}</h3>
      <ul className="checks">
        {acts.map((a) => (
          <li key={a.code}>
            <label>
              <input
                type="checkbox"
                checked={picked.has(a.code)}
                onChange={(e) => {
                  const next = new Set(picked);
                  if (e.target.checked) next.add(a.code);
                  else next.delete(a.code);
                  setPicked(next);
                }}
              />
              {label(a.labelFr, a.labelAr)} <span className="muted">· {a.tariff} FDJ</span>
            </label>
          </li>
        ))}
      </ul>
      <ErrorBox error={error} />
      <button
        className="primary"
        disabled={picked.size === 0 || !entry.encounterId}
        onClick={() => void send()}
      >
        {t("doctor.send")}
      </button>
    </div>
  );
}

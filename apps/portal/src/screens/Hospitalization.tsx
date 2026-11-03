import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "../api.ts";
import { label, t } from "../i18n.ts";
import { ErrorBox, fdj, Notice } from "../ui.tsx";

const NIGHT_ACT = "HOSP-1J";

interface Patient {
  name: string;
  identifier: string;
}
interface Stay {
  id: string;
  number: string;
  status: string;
  bedCode: string | null;
  patient: Patient | null;
}
interface Bed {
  code: string;
  ward: string;
  label: string;
  active: boolean;
  occupied: boolean;
  stay: { id: string; number: string; patient: Patient | null } | null;
}
interface Act {
  code: string;
  labelFr: string;
  labelAr: string;
  tariff: number;
  category: string;
}
interface StayDetail extends Stay {
  orders: { id: string; number: string; kind: string; status: string }[];
  charges: {
    id: number;
    kind: string;
    nightDate: string | null;
    actCode: string;
    quantity: number;
    unitPrice: number;
    invoiced: boolean;
  }[];
  projected: { nights: number; extraNights: number; total: number } | null;
  finalInvoice: { number: string; status: string; amountDue: number } | null;
  finalInvoiceId: string | null;
}
interface QueueEntry {
  id: string;
  ticket: string;
  patientId: string;
  encounterId: string | null;
  patient?: Patient;
}

type Tab = "stays" | "beds" | "new";

export function Hospitalization({ me }: { me: Me }): ReactNode {
  const [tab, setTab] = useState<Tab>("stays");
  const [selected, setSelected] = useState<string | null>(null);
  const can = (p: string): boolean => me.permissions.includes(p);
  const tabs: Tab[] = ["stays", "beds", ...(can("stay:manage") ? (["new"] as Tab[]) : [])];
  return (
    <section>
      <h1>{t("hosp.title")}</h1>
      <nav aria-label="hospitalisation" className="subtabs">
        {tabs.map((x) => (
          <button
            key={x}
            className={tab === x ? "tab active" : "tab"}
            onClick={() => setTab(x)}
            data-tab={x}
          >
            {t(`hosp.tab.${x}`)}
          </button>
        ))}
      </nav>
      {tab === "stays" && <Stays me={me} selected={selected} onSelect={setSelected} />}
      {tab === "beds" && <Beds />}
      {tab === "new" && (
        <NewStay
          onCreated={(id) => {
            setSelected(id);
            setTab("stays");
          }}
        />
      )}
    </section>
  );
}

function Stays({
  me,
  selected,
  onSelect,
}: {
  me: Me;
  selected: string | null;
  onSelect: (id: string) => void;
}): ReactNode {
  const [list, setList] = useState<Stay[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setList(
        (await api<{ stays: Stay[] }>("/api/stays")).stays.filter(
          (s) => s.status !== "discharged" && s.status !== "cancelled",
        ),
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
  return (
    <div className="cols">
      <div className="card">
        <ErrorBox error={error} />
        {list.length === 0 && <p className="muted">{t("common.none")}</p>}
        <ul className="list">
          {list.map((s) => (
            <li key={s.id}>
              <button
                className={selected === s.id ? "row active" : "row"}
                data-stay={s.number}
                onClick={() => onSelect(s.id)}
              >
                <strong>{s.number}</strong> {s.patient?.name}{" "}
                <span className="badge">{t(`hosp.status.${s.status}`)}</span>{" "}
                {s.bedCode && <span className="muted">{s.bedCode}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="card">
        {selected ? (
          <StayPanel key={selected} id={selected} me={me} onChanged={load} />
        ) : (
          <p className="muted">{t("common.none")}</p>
        )}
      </div>
    </div>
  );
}

function Beds(): ReactNode {
  const [beds, setBeds] = useState<Bed[]>([]);
  useEffect(() => {
    const load = (): void => {
      api<{ beds: Bed[] }>("/api/beds")
        .then((r) => setBeds(r.beds))
        .catch(() => setBeds([]));
    };
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div className="grid">
      {beds.map((b) => (
        <article key={b.code} className="card" data-bed={b.code} data-occupied={b.occupied}>
          <h3>{b.label}</h3>
          <p className={b.occupied ? "warn" : "muted"}>
            {b.occupied
              ? `${b.stay?.patient?.name ?? ""} · ${b.stay?.number ?? ""}`
              : t("hosp.free")}
          </p>
        </article>
      ))}
    </div>
  );
}

function StayPanel({
  id,
  me,
  onChanged,
}: {
  id: string;
  me: Me;
  onChanged: () => Promise<void>;
}): ReactNode {
  const can = (p: string): boolean => me.permissions.includes(p);
  const [d, setD] = useState<StayDetail | null>(null);
  const [acts, setActs] = useState<Act[]>([]);
  const [beds, setBeds] = useState<Bed[]>([]);
  const [bed, setBed] = useState("");
  const [charge, setCharge] = useState({ act: "", qty: "1" });
  const [orderAct, setOrderAct] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setD(await api<StayDetail>(`/api/stays/${id}`));
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    api<Act[]>("/api/catalog/acts")
      .then(setActs)
      .catch(() => setActs([]));
    api<{ beds: Bed[] }>("/api/beds")
      .then((r) => setBeds(r.beds.filter((b) => !b.occupied)))
      .catch(() => setBeds([]));
    return () => clearInterval(timer);
  }, [load]);

  const run = async (fn: () => Promise<string | void>): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      const message = await fn();
      if (message) setNotice(message);
      await load();
      await onChanged();
    } catch (e) {
      setError(e);
    }
  };

  if (!d) return <ErrorBox error={error} />;
  const careActs = acts.filter((a) => a.category === "hospitalization" && a.code !== NIGHT_ACT);
  const heavyActs = acts.filter((a) => a.category !== "consultation" && a.code !== NIGHT_ACT);
  return (
    <div className="form" data-stay-panel={d.number}>
      <h2>
        {d.patient?.name} <span className="muted">{d.number}</span>{" "}
        <span className="badge">{t(`hosp.status.${d.status}`)}</span>
      </h2>
      <ErrorBox error={error} />
      <Notice>{notice}</Notice>

      <h3>{t("hosp.detail.orders")}</h3>
      <ul className="plain" data-orders>
        {d.orders.map((o) => (
          <li key={o.id} data-order-status={o.status}>
            {o.number} · {o.kind} · <span className="badge">{o.status}</span>
          </li>
        ))}
      </ul>

      {d.status === "awaiting_payment" && can("stay:admit") && (
        <div>
          <p className="muted">{t("hosp.admit.hint")}</p>
          <div className="inline">
            <select aria-label={t("hosp.bed")} value={bed} onChange={(e) => setBed(e.target.value)}>
              <option value="" />
              {beds.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.label}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={!bed}
              onClick={() =>
                void run(async () => {
                  await api(`/api/stays/${id}/admit`, { method: "POST", body: { bedCode: bed } });
                })
              }
            >
              {t("hosp.admit")}
            </button>
          </div>
        </div>
      )}

      {d.status === "admitted" && (
        <>
          {d.projected && (
            <p className="muted" data-projected>
              {t("hosp.detail.projected", {
                nights: d.projected.nights,
                extra: d.projected.extraNights,
                total: d.projected.total,
              })}
            </p>
          )}
          <h3>{t("hosp.detail.charges")}</h3>
          <ul className="plain" data-charges>
            {d.charges.map((c) => (
              <li key={c.id}>
                {c.actCode} × {c.quantity} · {fdj(c.unitPrice * c.quantity)} {c.invoiced && "✓"}
              </li>
            ))}
          </ul>
          {can("stay:manage") && (
            <>
              <div className="inline">
                <select
                  aria-label={t("hosp.charge.act")}
                  value={charge.act}
                  onChange={(e) => setCharge({ ...charge, act: e.target.value })}
                >
                  <option value="" />
                  {careActs.map((a) => (
                    <option key={a.code} value={a.code}>
                      {label(a.labelFr, a.labelAr)} · {a.tariff} FDJ
                    </option>
                  ))}
                </select>
                <input
                  aria-label={t("stock.quantity")}
                  inputMode="numeric"
                  value={charge.qty}
                  onChange={(e) => setCharge({ ...charge, qty: e.target.value })}
                />
                <button
                  disabled={!charge.act}
                  onClick={() =>
                    void run(async () => {
                      await api(`/api/stays/${id}/charges`, {
                        method: "POST",
                        body: { actCode: charge.act, quantity: Number(charge.qty) },
                      });
                    })
                  }
                >
                  {t("hosp.charge.add")}
                </button>
              </div>
              <div className="inline">
                <select
                  aria-label={t("hosp.order.add")}
                  value={orderAct}
                  onChange={(e) => setOrderAct(e.target.value)}
                >
                  <option value="" />
                  {heavyActs.map((a) => (
                    <option key={a.code} value={a.code}>
                      {label(a.labelFr, a.labelAr)} · {a.tariff} FDJ
                    </option>
                  ))}
                </select>
                <button
                  disabled={!orderAct}
                  onClick={() =>
                    void run(async () => {
                      const o = await api<{ number: string }>(`/api/stays/${id}/orders`, {
                        method: "POST",
                        body: { items: [{ actCode: orderAct, quantity: 1 }] },
                      });
                      return t("hosp.order.sent", { number: o.number });
                    })
                  }
                >
                  {t("hosp.order.add")}
                </button>
              </div>
            </>
          )}
          {can("stay:discharge") && (
            <button
              className="primary"
              onClick={() =>
                void run(async () => {
                  const r = await api<{ finalInvoiceId: string | null }>(
                    `/api/stays/${id}/discharge`,
                    { method: "POST" },
                  );
                  return r.finalInvoiceId ? undefined : t("hosp.discharge.noInvoice");
                })
              }
            >
              {t("hosp.discharge")}
            </button>
          )}
        </>
      )}

      {d.status === "discharge_pending" && (
        <>
          {d.finalInvoice ? (
            <p data-final-invoice className="warn">
              {t("hosp.invoice", {
                number: d.finalInvoice.number,
                due: d.finalInvoice.amountDue,
                status: d.finalInvoice.status,
              })}
            </p>
          ) : (
            <p className="muted">{t("hosp.discharge.noInvoice")}</p>
          )}
          {(can("stay:admit") || can("stay:discharge") || can("stay:exit-unpaid")) && (
            <div className="inline">
              {can("stay:exit-unpaid") && (
                <input
                  aria-label={t("hosp.exit.unpaidReason")}
                  placeholder={t("hosp.exit.unpaidReason")}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              )}
              <button
                className="primary"
                onClick={() =>
                  void run(async () => {
                    await api(`/api/stays/${id}/exit`, {
                      method: "POST",
                      body: reason.trim() ? { unpaidReason: reason.trim() } : {},
                    });
                    return t("hosp.exit.done");
                  })
                }
              >
                {t("hosp.exit")}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NewStay({ onCreated }: { onCreated: (id: string) => void }): ReactNode {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const [acts, setActs] = useState<Act[]>([]);
  const [entry, setEntry] = useState("");
  const [initial, setInitial] = useState<Set<string>>(new Set());
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    api<{ queue: QueueEntry[] }>("/api/queue?department=CONS")
      .then((r) => setQueue(r.queue.filter((e) => e.encounterId)))
      .catch(setError);
    api<Act[]>("/api/catalog/acts")
      .then(setActs)
      .catch(() => setActs([]));
  }, []);
  const night = acts.find((a) => a.code === NIGHT_ACT);
  const create = async (): Promise<void> => {
    const e = queue.find((x) => x.id === entry);
    if (!e) return;
    setError(null);
    try {
      const r = await api<{ id: string; number: string }>("/api/stays", {
        method: "POST",
        body: {
          patientId: e.patientId,
          encounterId: e.encounterId,
          items: [
            { actCode: NIGHT_ACT, quantity: 1 },
            ...[...initial].map((actCode) => ({ actCode, quantity: 1 })),
          ],
        },
      });
      setNotice(t("hosp.new.sent", { number: r.number }));
      onCreated(r.id);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="card form">
      <Notice>{notice}</Notice>
      <label>
        {t("hosp.new.patient")}
        <select
          aria-label={t("hosp.new.patient")}
          value={entry}
          onChange={(e) => setEntry(e.target.value)}
        >
          <option value="" />
          {queue.map((q) => (
            <option key={q.id} value={q.id}>
              {q.ticket} · {q.patient?.name}
            </option>
          ))}
        </select>
      </label>
      <p>
        <input type="checkbox" checked disabled /> {t("hosp.new.firstNight")}{" "}
        {night && <span className="muted">· {night.tariff} FDJ</span>}
      </p>
      <h3>{t("hosp.new.initialActs")}</h3>
      <ul className="checks">
        {acts
          .filter(
            (a) =>
              (a.category === "other" || a.category === "hospitalization") && a.code !== NIGHT_ACT,
          )
          .map((a) => (
            <li key={a.code}>
              <label>
                <input
                  type="checkbox"
                  checked={initial.has(a.code)}
                  onChange={(ev) => {
                    const next = new Set(initial);
                    if (ev.target.checked) next.add(a.code);
                    else next.delete(a.code);
                    setInitial(next);
                  }}
                />
                {label(a.labelFr, a.labelAr)} <span className="muted">· {a.tariff} FDJ</span>
              </label>
            </li>
          ))}
      </ul>
      <ErrorBox error={error} />
      <button className="primary" disabled={!entry} onClick={() => void create()}>
        {t("hosp.new.send")}
      </button>
    </div>
  );
}

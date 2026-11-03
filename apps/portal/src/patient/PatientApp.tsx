import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ApiError } from "../api.ts";
import { label, setLang, t, useLang } from "../i18n.ts";
import { confirmAction, ErrorBox, fdj, Notice, ProgressBar } from "../ui.tsx";
import { EnvBanner } from "../App.tsx";
import { getToken, papi, setToken } from "./patientApi.ts";

interface Appt {
  id: string;
  startsAt: string;
  status: string;
  practitionerName: string | null;
}
interface Result {
  requestNumber: string;
  labelFr: string;
  labelAr: string;
  value: number | string | null;
  unit: string | null;
  flag: string;
  validatedAt: string;
}
interface Invoice {
  number: string;
  issuedAt: string;
  status: string;
  total: number;
  patientAmount: number;
  amountDue: number;
}
type Tab = "appointments" | "results" | "invoices";

export function PatientApp(): ReactNode {
  useLang();
  const [signedIn, setSignedIn] = useState(getToken() !== null);
  const toggle = (
    <button
      className="ghost"
      onClick={() => setLang(document.documentElement.lang === "ar" ? "fr" : "ar")}
    >
      {t("nav.language")}
    </button>
  );
  return (
    <div className="shell patient">
      <a className="skip" href="#contenu">
        {t("common.skip")}
      </a>
      <ProgressBar />
      <EnvBanner />
      <header className="bar">
        <strong className="brand">{t("patient.brand")}</strong>
        <span className="spacer" />
        {toggle}
        {signedIn && (
          <button
            onClick={() => {
              void papi("/api/portal/logout", { method: "POST", body: {} }).catch(() => {});
              setToken(null);
              setSignedIn(false);
            }}
          >
            {t("nav.logout")}
          </button>
        )}
      </header>
      <main id="contenu" tabIndex={-1}>
        {signedIn ? (
          <Home onExpired={() => (setToken(null), setSignedIn(false))} />
        ) : (
          <Login onDone={() => setSignedIn(true)} />
        )}
      </main>
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }): ReactNode {
  const [identifier, setIdentifier] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"id" | "code">("id");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card form" data-patient-login>
      <h1>{t("patient.login.title")}</h1>
      <ErrorBox error={error} />
      {step === "id" ? (
        <>
          <label>
            {t("patient.login.identifier")}
            <input
              inputMode="numeric"
              autoComplete="off"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
            />
          </label>
          <p className="muted">{t("patient.login.hint")}</p>
          <button
            className="primary"
            disabled={busy || identifier.trim().length < 3}
            onClick={() =>
              void run(async () => {
                await papi("/api/portal/otp/request", {
                  body: { identifier: identifier.trim() },
                  auth: false,
                });
                setStep("code");
              })
            }
          >
            {t("patient.login.send")}
          </button>
        </>
      ) : (
        <>
          <Notice>{t("patient.login.sent")}</Notice>
          <label>
            {t("patient.login.code")}
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </label>
          <div className="actions">
            <button
              className="primary"
              disabled={busy || code.length !== 6}
              onClick={() =>
                void run(async () => {
                  const r = await papi<{ token: string }>("/api/portal/otp/verify", {
                    body: { identifier: identifier.trim(), code },
                    auth: false,
                  });
                  setToken(r.token);
                  onDone();
                })
              }
            >
              {t("patient.login.verify")}
            </button>
            <button onClick={() => (setStep("id"), setCode(""), setError(null))}>
              {t("patient.login.back")}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Home({ onExpired }: { onExpired: () => void }): ReactNode {
  const [tab, setTab] = useState<Tab>("appointments");
  const [me, setMe] = useState<{ name: string; identifier: string } | null>(null);
  useEffect(() => {
    papi<{ name: string; identifier: string }>("/api/portal/me")
      .then(setMe)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) onExpired();
      });
  }, [onExpired]);
  return (
    <>
      <h1 data-patient-name>{me ? t("patient.hello", { name: me.name }) : ""}</h1>
      <nav aria-label="patient" className="subtabs">
        {(["appointments", "results", "invoices"] as Tab[]).map((x) => (
          <button
            key={x}
            className={tab === x ? "tab active" : "tab"}
            data-tab={x}
            onClick={() => setTab(x)}
          >
            {t(`patient.tab.${x}`)}
          </button>
        ))}
      </nav>
      {tab === "appointments" && <Appointments onExpired={onExpired} />}
      {tab === "results" && <Results onExpired={onExpired} />}
      {tab === "invoices" && <Invoices onExpired={onExpired} />}
    </>
  );
}

const useLoad = <T,>(path: string, onExpired: () => void) => {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setData(await papi<T>(path));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpired();
      else setError(e);
    }
  }, [path, onExpired]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load };
};

const when = (iso: string): string =>
  new Date(iso).toLocaleString(document.documentElement.lang === "ar" ? "ar-DJ" : "fr-FR", {
    dateStyle: "medium",
    timeStyle: "short",
  });

function Appointments({ onExpired }: { onExpired: () => void }): ReactNode {
  const list = useLoad<{ appointments: Appt[] }>("/api/portal/me/appointments", onExpired);
  const [practitioners, setPractitioners] = useState<{ id: string; name: string }[]>([]);
  const [pid, setPid] = useState("");
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<{ startsAt: string }[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    papi<{ practitioners: { id: string; name: string }[] }>("/api/portal/practitioners")
      .then((r) => setPractitioners(r.practitioners))
      .catch(() => setPractitioners([]));
  }, []);
  useEffect(() => {
    setSlots([]);
    if (pid && date)
      papi<{ slots: { startsAt: string }[] }>(`/api/portal/practitioners/${pid}/slots?date=${date}`)
        .then((r) => setSlots(r.slots))
        .catch(setError);
  }, [pid, date]);
  const act = async (fn: () => Promise<unknown>, message: string): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      await fn();
      setNotice(message);
      await list.reload();
      setSlots([]);
      setDate("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onExpired();
      else setError(e);
    }
  };
  return (
    <div className="cols">
      <div className="card" data-appointments>
        <h2>{t("patient.appointments.mine")}</h2>
        <ErrorBox error={list.error} />
        {list.data?.appointments.length === 0 && <p className="muted">{t("common.none")}</p>}
        <ul className="plain">
          {list.data?.appointments.map((a) => (
            <li key={a.id} data-appointment={a.id}>
              <strong>{when(a.startsAt)}</strong> · {a.practitionerName}{" "}
              <span className="badge">{t(`patient.appt.${a.status}`)}</span>
              {a.status === "booked" && (
                <button
                  onClick={() =>
                    confirmAction(t("confirm.cancelAppt")) &&
                    void act(
                      () => papi(`/api/portal/me/appointments/${a.id}/cancel`, { body: {} }),
                      t("patient.appointments.cancelled"),
                    )
                  }
                >
                  {t("patient.appointments.cancel")}
                </button>
              )}
            </li>
          ))}
        </ul>
      </div>
      <div className="card form">
        <h2>{t("patient.appointments.book")}</h2>
        <ErrorBox error={error} />
        <Notice>{notice}</Notice>
        <label>
          {t("patient.appointments.doctor")}
          <select value={pid} onChange={(e) => setPid(e.target.value)}>
            <option value="" />
            {practitioners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("patient.appointments.date")}
          <input
            type="date"
            min={new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {pid && date && slots.length === 0 && (
          <p className="muted">{t("patient.appointments.noslot")}</p>
        )}
        <div className="slots">
          {slots.map((s) => (
            <button
              key={s.startsAt}
              data-slot={s.startsAt}
              onClick={() =>
                void act(
                  () =>
                    papi("/api/portal/me/appointments", {
                      body: { practitionerId: pid, startsAt: s.startsAt },
                    }),
                  t("patient.appointments.booked"),
                )
              }
            >
              {new Date(s.startsAt).toLocaleTimeString(
                document.documentElement.lang === "ar" ? "ar-DJ" : "fr-FR",
                {
                  hour: "2-digit",
                  minute: "2-digit",
                },
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function Results({ onExpired }: { onExpired: () => void }): ReactNode {
  const r = useLoad<{ results: Result[]; withheld: number; pendingCount: number }>(
    "/api/portal/me/results",
    onExpired,
  );
  return (
    <div className="card" data-results>
      <h2>{t("patient.results.title")}</h2>
      <ErrorBox error={r.error} />
      <p className="muted">{t("patient.results.policy")}</p>
      {r.data && r.data.withheld > 0 && (
        <p role="status" className="notice" data-withheld>
          {t("patient.results.withheld", { n: r.data.withheld })}
        </p>
      )}
      {r.data && r.data.pendingCount > 0 && (
        <p className="muted">{t("patient.results.pending", { n: r.data.pendingCount })}</p>
      )}
      {r.data?.results.length === 0 && r.data.withheld === 0 && r.data.pendingCount === 0 && (
        <p className="muted">{t("common.none")}</p>
      )}
      <ul className="plain">
        {r.data?.results.map((x, i) => (
          <li key={i}>
            {label(x.labelFr, x.labelAr)} : <strong>{x.value}</strong> {x.unit}{" "}
            <span className={x.flag === "normal" ? "flag ok" : "flag abnormal"}>
              {t(`lab.flag.${x.flag}`)}
            </span>{" "}
            <span className="muted">{when(x.validatedAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Invoices({ onExpired }: { onExpired: () => void }): ReactNode {
  const r = useLoad<{ invoices: Invoice[] }>("/api/portal/me/invoices", onExpired);
  return (
    <div className="card" data-invoices>
      <h2>{t("patient.invoices.title")}</h2>
      <ErrorBox error={r.error} />
      {r.data?.invoices.length === 0 && <p className="muted">{t("common.none")}</p>}
      <ul className="plain">
        {r.data?.invoices.map((i) => (
          <li key={i.number}>
            <strong>{i.number}</strong> · {when(i.issuedAt)} · {fdj(i.patientAmount)}{" "}
            <span className={i.status === "paid" ? "flag ok" : "flag abnormal"}>
              {t(`patient.invoice.${i.status}`)}
            </span>
          </li>
        ))}
      </ul>
      <p className="muted">{t("patient.invoices.pay")}</p>
    </div>
  );
}

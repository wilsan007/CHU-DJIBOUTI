import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "../api.ts";
import { label, t } from "../i18n.ts";
import { ErrorBox, Notice } from "../ui.tsx";

interface Patient {
  name: string;
  identifier: string;
  birthDate: string | null;
}
interface RequestTest {
  id: number;
  testCode: string | null;
  labelFr: string | null;
  specimenType: string | null;
  specimenId: string | null;
}
interface LabRequest {
  id: string;
  number: string;
  status: string;
  patient: Patient | null;
  tests: RequestTest[];
}
interface SpecimenTest {
  testCode: string;
  labelFr: string;
  labelAr: string;
  unit: string | null;
  valueKind: string;
  value: number | string | null;
  flag: string | null;
  resultStatus: string | null;
}
interface Specimen {
  id: string;
  number: string;
  status: string;
  specimenType: string;
  requestNumber: string;
  patient: Patient | null;
  tests: SpecimenTest[];
}

const FLAG_CLASS: Record<string, string> = {
  critical_low: "flag critical",
  critical_high: "flag critical",
  low: "flag abnormal",
  high: "flag abnormal",
  normal: "flag ok",
  none: "flag",
};

export function Lab({ me }: { me: Me }): ReactNode {
  const [requests, setRequests] = useState<LabRequest[]>([]);
  const [specimens, setSpecimens] = useState<Specimen[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [r, s] = await Promise.all([
        api<{ requests: LabRequest[] }>("/api/lab/requests"),
        api<{ specimens: Specimen[] }>("/api/lab/specimens"),
      ]);
      setRequests(r.requests);
      setSpecimens(s.specimens);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const toCollect = requests.filter(
    (r) =>
      r.status !== "completed" &&
      r.status !== "cancelled" &&
      r.tests.some((x) => x.specimenId === null),
  );
  // Liste de travail : les échantillons dont tous les résultats sont validés sortent de la liste.
  const active = specimens.filter(
    (s) =>
      s.status === "collected" ||
      (s.status === "received" && s.tests.some((x) => x.resultStatus !== "validated")),
  );

  return (
    <section>
      <h1>{t("lab.title")}</h1>
      <ErrorBox error={error} />
      <Notice>{notice}</Notice>
      <h2>{t("lab.toCollect")}</h2>
      {toCollect.length === 0 && <p className="muted empty">{t("lab.emptyCollect")}</p>}
      <div className="grid">
        {toCollect.map((r) => (
          <CollectCard
            key={r.id}
            request={r}
            onDone={(m) => {
              setNotice(m);
              void load();
            }}
          />
        ))}
      </div>
      <h2>{t("lab.specimens")}</h2>
      {active.length === 0 && <p className="muted empty">{t("lab.emptySpecimens")}</p>}
      <div className="grid">
        {active.map((s) => (
          <SpecimenCard
            key={s.id}
            specimen={s}
            me={me}
            onDone={(m) => {
              if (m) setNotice(m);
              void load();
            }}
          />
        ))}
      </div>
    </section>
  );
}

async function openLabel(specimenId: string): Promise<void> {
  const { html } = await api<{ html: string }>(`/api/lab/specimens/${specimenId}/label`);
  window.open(URL.createObjectURL(new Blob([html], { type: "text/html" })), "_blank");
}

function CollectCard({
  request,
  onDone,
}: {
  request: LabRequest;
  onDone: (message: string) => void;
}): ReactNode {
  const waiting = request.tests.filter((x) => x.specimenId === null);
  const types = [...new Set(waiting.flatMap((x) => (x.specimenType ? [x.specimenType] : [])))];
  const [type, setType] = useState(types[0] ?? "");
  const [scan, setScan] = useState("");
  const [error, setError] = useState<unknown>(null);

  const collect = async (): Promise<void> => {
    setError(null);
    try {
      const sp = await api<{ id: string; number: string }>(
        `/api/lab/requests/${request.id}/collect`,
        {
          method: "POST",
          body: { patientScan: scan.trim(), specimenType: type },
        },
      );
      setScan("");
      onDone(t("lab.collected", { number: sp.number }));
      await openLabel(sp.id);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <article className="card" data-request={request.number}>
      <h3>{t("lab.request", { number: request.number })}</h3>
      <p>
        <strong>{request.patient?.name}</strong>{" "}
        <span className="muted">{request.patient?.identifier}</span>
      </p>
      <ul className="plain">
        {waiting.map((x) => (
          <li key={x.id}>
            {x.testCode ? (
              (x.labelFr ?? x.testCode)
            ) : (
              <span className="error">{t("lab.notConfigured")}</span>
            )}
          </li>
        ))}
      </ul>
      {types.length > 0 && (
        <>
          <label>
            {t("lab.specimenType")}
            <select value={type} onChange={(e) => setType(e.target.value)}>
              {types.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("lab.scanPatient")}
            <input
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              placeholder="CHU1.000001.00"
              autoComplete="off"
            />
          </label>
          <p className="muted">{t("lab.scanPatient.hint")}</p>
          <ErrorBox error={error} />
          <button
            className="primary"
            disabled={!scan.trim() || !type}
            onClick={() => void collect()}
          >
            {t("lab.collect")}
          </button>
        </>
      )}
    </article>
  );
}

function SpecimenCard({
  specimen,
  me,
  onDone,
}: {
  specimen: Specimen;
  me: Me;
  onDone: (message?: string) => void;
}): ReactNode {
  const [scan, setScan] = useState("");
  const [reason, setReason] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const can = (p: string): boolean => me.permissions.includes(p);

  const run = async (fn: () => Promise<unknown>, message?: string): Promise<void> => {
    setError(null);
    try {
      await fn();
      onDone(message);
    } catch (e) {
      setError(e);
    }
  };
  const results = specimen.tests.map((x) => x.resultStatus);
  const allEntered = results.every((s) => s !== null);
  const toTech = allEntered && results.some((s) => s === "entered");
  const toBio = results.some((s) => s === "tech_validated");

  return (
    <article className="card" data-specimen={specimen.number}>
      <h3>
        {specimen.number} <span className="badge">{t(`lab.status.${specimen.status}`)}</span>
      </h3>
      <p>
        <strong>{specimen.patient?.name}</strong>{" "}
        <span className="muted">
          {specimen.patient?.identifier} · {specimen.specimenType} · {specimen.requestNumber}
        </span>
      </p>
      <button className="ghost" onClick={() => void openLabel(specimen.id)}>
        {t("lab.label")}
      </button>

      {specimen.status === "collected" && (
        <div className="form">
          <label>
            {t("lab.scanSpecimen")}
            <input
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              placeholder="SP1.S-000001.00"
              autoComplete="off"
            />
          </label>
          <button
            className="primary"
            disabled={!scan.trim()}
            onClick={() =>
              void run(() =>
                api("/api/lab/specimens/receive", { method: "POST", body: { scan: scan.trim() } }),
              )
            }
          >
            {t("lab.receive")}
          </button>
          <label>
            {t("lab.rejectReason")}
            <input value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <button
            disabled={reason.trim().length < 5}
            onClick={() =>
              void run(
                () =>
                  api(`/api/lab/specimens/${specimen.id}/reject`, {
                    method: "POST",
                    body: { reason },
                  }),
                t("lab.rejected"),
              )
            }
          >
            {t("lab.reject")}
          </button>
        </div>
      )}

      {specimen.status === "received" && (
        <div className="form">
          {specimen.tests.map((x) => {
            const locked = x.resultStatus !== null && x.resultStatus !== "entered";
            return (
              <div key={x.testCode} className="result" data-test={x.testCode}>
                <strong>{label(x.labelFr, x.labelAr)}</strong>
                {x.value !== null && (
                  <span>
                    {" "}
                    <b>{x.value}</b> {x.unit}{" "}
                    <span className={FLAG_CLASS[x.flag ?? "none"]}>
                      {t(`lab.flag.${x.flag ?? "none"}`)}
                    </span>{" "}
                    <span className="muted">
                      {x.resultStatus ? t(`lab.resultStatus.${x.resultStatus}`) : ""}
                    </span>
                  </span>
                )}
                {!locked && can("lab:write") && (
                  <div className="inline">
                    <input
                      aria-label={`${t("lab.result")} ${x.testCode}`}
                      inputMode="decimal"
                      value={values[x.testCode] ?? ""}
                      onChange={(e) => setValues({ ...values, [x.testCode]: e.target.value })}
                    />
                    <button
                      disabled={
                        !(values[x.testCode] ?? "").trim() ||
                        Number.isNaN(Number(values[x.testCode]))
                      }
                      onClick={() =>
                        void run(async () => {
                          const raw = values[x.testCode] ?? "";
                          await api(`/api/lab/specimens/${specimen.id}/results`, {
                            method: "POST",
                            body:
                              x.valueKind === "text"
                                ? { testCode: x.testCode, text: raw }
                                : { testCode: x.testCode, value: Number(raw) },
                          });
                          setValues({ ...values, [x.testCode]: "" });
                        })
                      }
                    >
                      {t("lab.saveResult")}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {toTech && can("lab:validate-tech") && (
            <button
              className="primary"
              onClick={() =>
                void run(() =>
                  api(`/api/lab/specimens/${specimen.id}/validate-technical`, { method: "POST" }),
                )
              }
            >
              {t("lab.validateTech")}
            </button>
          )}
          {toBio && can("lab:validate-bio") && (
            <button
              className="primary"
              onClick={() =>
                void run(() =>
                  api(`/api/lab/specimens/${specimen.id}/validate-biological`, { method: "POST" }),
                )
              }
            >
              {t("lab.validateBio")}
            </button>
          )}
        </div>
      )}
      <ErrorBox error={error} />
    </article>
  );
}

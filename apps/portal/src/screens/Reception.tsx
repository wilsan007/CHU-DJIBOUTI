import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError } from "../api.ts";
import { label, t } from "../i18n.ts";
import { ErrorBox, Notice } from "../ui.tsx";

interface Patient {
  id: string;
  identifier: string;
  givenName: string | null;
  familyName: string | null;
  birthDate: string | null;
  sex: string | null;
  phone: string | null;
}
interface Department {
  code: string;
  nameFr: string;
  nameAr: string;
}
interface Payer {
  code: string;
  nameFr: string;
  nameAr: string;
  patientShare: number;
}
interface Act {
  code: string;
  labelFr: string;
  labelAr: string;
  tariff: number;
}

/** Ouvre la carte imprimable (avec son QR) dans un nouvel onglet : l'agent imprime depuis le navigateur. */
async function printCard(ref: string): Promise<void> {
  const r = await api<{ html: string }>(`/api/patients/${ref}/card/print`);
  window.open(URL.createObjectURL(new Blob([r.html], { type: "text/html" })), "_blank");
}

const nameOf = (p: Patient): string => [p.givenName, p.familyName].filter(Boolean).join(" ");

export function Reception(): ReactNode {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Patient[]>([]);
  const [selected, setSelected] = useState<Patient | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ results: Patient[] }>(`/api/patients?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setResults(r.results))
        .catch(setError);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  return (
    <section>
      <h1>{t("reception.title")}</h1>
      <ErrorBox error={error} />
      <Notice>{notice}</Notice>
      <div className="cols">
        <div className="card">
          <label>
            {t("common.search")}
            <input
              aria-label={t("reception.search")}
              placeholder={t("reception.search")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <ul className="list">
            {results.map((p) => (
              <li key={p.id}>
                <button
                  className={selected?.id === p.id ? "row active" : "row"}
                  onClick={() => {
                    setSelected(p);
                    setNotice("");
                  }}
                >
                  <strong>{nameOf(p)}</strong>{" "}
                  <span className="muted">
                    {p.identifier} · {p.birthDate ?? ""} · {p.phone ?? ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <NewPatient
            onCreated={(p) => {
              setSelected(p);
              setNotice("");
            }}
          />
        </div>
        <div className="card">
          {selected ? (
            <Admission patient={selected} onDone={setNotice} />
          ) : (
            <p className="muted empty">{t("reception.empty")}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function NewPatient({ onCreated }: { onCreated: (p: Patient) => void }): ReactNode {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    givenName: "",
    familyName: "",
    sex: "female",
    birthDate: "",
    phone: "",
  });
  const [error, setError] = useState<unknown>(null);
  const [candidates, setCandidates] = useState<{ patient: Patient }[]>([]);

  const submit = async (e: FormEvent | null, confirm = false): Promise<void> => {
    e?.preventDefault();
    setError(null);
    try {
      const p = await api<Patient>("/api/patients", {
        method: "POST",
        body: {
          ...form,
          phone: form.phone.trim() || undefined,
          ...(confirm ? { confirmNotDuplicate: true } : {}),
        },
      });
      setCandidates([]);
      setOpen(false);
      onCreated(p);
    } catch (err) {
      if (err instanceof ApiError && err.code === "possible_duplicates") {
        setCandidates((err.details as { candidates: { patient: Patient }[] }).candidates);
      } else setError(err);
    }
  };

  if (!open)
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        {t("patient.create")}
      </button>
    );
  return (
    <form onSubmit={(e) => void submit(e)} className="form">
      <h2>{t("patient.create")}</h2>
      <label>
        {t("reception.givenName")}
        <input
          required
          value={form.givenName}
          onChange={(e) => setForm({ ...form, givenName: e.target.value })}
        />
      </label>
      <label>
        {t("reception.familyName")}
        <input
          required
          value={form.familyName}
          onChange={(e) => setForm({ ...form, familyName: e.target.value })}
        />
      </label>
      <label>
        {t("reception.sex")}
        <select value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}>
          <option value="female">{t("reception.sex.female")}</option>
          <option value="male">{t("reception.sex.male")}</option>
        </select>
      </label>
      <label>
        {t("reception.birthDate")}
        <input
          required
          type="date"
          value={form.birthDate}
          onChange={(e) => setForm({ ...form, birthDate: e.target.value })}
        />
      </label>
      <label>
        {t("reception.phone")}
        <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </label>
      <ErrorBox error={error} />
      {candidates.length > 0 && (
        <div role="alert" className="warn">
          <p>{t("reception.duplicates")}</p>
          <ul>
            {candidates.map((c) => (
              <li key={c.patient.id}>
                {nameOf(c.patient)} · {c.patient.identifier} · {c.patient.birthDate}
              </li>
            ))}
          </ul>
          <button type="button" onClick={() => void submit(null, true)}>
            {t("reception.notSame")}
          </button>
        </div>
      )}
      <div className="actions">
        <button className="primary" type="submit">
          {t("common.save")}
        </button>
        <button type="button" onClick={() => setOpen(false)}>
          {t("common.cancel")}
        </button>
      </div>
    </form>
  );
}

function Admission({
  patient,
  onDone,
}: {
  patient: Patient;
  onDone: (m: string) => void;
}): ReactNode {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [payers, setPayers] = useState<Payer[]>([]);
  const [acts, setActs] = useState<Act[]>([]);
  const [dept, setDept] = useState("CONS");
  const [payer, setPayer] = useState("");
  const [act, setAct] = useState("");
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    void Promise.all([
      api<Department[]>("/api/catalog/departments"),
      api<Payer[]>("/api/catalog/payers"),
    ])
      .then(([d, p]) => {
        setDepartments(d);
        setPayers(p);
        setPayer(p[0]?.code ?? "");
      })
      .catch(setError);
  }, []);
  useEffect(() => {
    api<Act[]>(`/api/catalog/acts?department=${dept}&category=consultation`)
      .then((a) => {
        setActs(a);
        setAct(a[0]?.code ?? "");
      })
      .catch(setError);
  }, [dept]);

  const admit = async (): Promise<void> => {
    setError(null);
    try {
      const r = await api<{ invoice: { number: string; patientAmount: number } }>(
        "/api/admissions",
        {
          method: "POST",
          body: { patientId: patient.id, departmentCode: dept, payerCode: payer, actCode: act },
        },
      );
      onDone(
        t("reception.admitted", { number: r.invoice.number, amount: r.invoice.patientAmount }),
      );
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="form">
      <h2>
        {nameOf(patient)} <span className="muted">{patient.identifier}</span>
      </h2>
      <button data-print-card onClick={() => void printCard(patient.id)}>
        {t("reception.printCard")}
      </button>
      <label>
        {t("reception.department")}
        <select value={dept} onChange={(e) => setDept(e.target.value)}>
          {departments.map((d) => (
            <option key={d.code} value={d.code}>
              {label(d.nameFr, d.nameAr)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("reception.payer")}
        <select value={payer} onChange={(e) => setPayer(e.target.value)}>
          {payers.map((p) => (
            <option key={p.code} value={p.code}>
              {label(p.nameFr, p.nameAr)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("reception.act")}
        <select value={act} onChange={(e) => setAct(e.target.value)}>
          {acts.map((a) => (
            <option key={a.code} value={a.code}>
              {label(a.labelFr, a.labelAr)} · {a.tariff} FDJ
            </option>
          ))}
        </select>
      </label>
      <ErrorBox error={error} />
      <button className="primary" disabled={!act || !payer} onClick={() => void admit()}>
        {t("reception.admit")}
      </button>
    </div>
  );
}

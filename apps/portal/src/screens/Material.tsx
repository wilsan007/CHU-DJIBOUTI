import { useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { label, t } from "../i18n.ts";
import { ErrorBox, Notice } from "../ui.tsx";
import { ItemPicker, type Item } from "./Stock.tsx";

interface Depot {
  code: string;
  name: string;
  servesDepartment: string | null;
}
interface PatientHit {
  id: string;
  identifier: string;
  givenName: string | null;
  familyName: string | null;
}

/** Utilisation de matériel hors acte (seringues, compresses...) par le personnel soignant et technique. */
export function Material(): ReactNode {
  const [depots, setDepots] = useState<Depot[]>([]);
  const [depot, setDepot] = useState("");
  const [item, setItem] = useState<Item | null>(null);
  const [qty, setQty] = useState("1");
  const [reason, setReason] = useState("");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<PatientHit[]>([]);
  const [patient, setPatient] = useState<PatientHit | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    api<{ depots: Depot[] }>("/api/stock/depots")
      .then((r) => {
        setDepots(r.depots);
        setDepot(
          (cur) => cur || r.depots.find((d) => d.servesDepartment)?.code || r.depots[0]?.code || "",
        );
      })
      .catch(setError);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ results: PatientHit[] }>(`/api/patients?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setHits(r.results))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const submit = async (): Promise<void> => {
    if (!item) return;
    setError(null);
    setNotice("");
    try {
      await api("/api/stock/consumptions", {
        method: "POST",
        body: {
          depot,
          itemCode: item.code,
          quantity: Number(qty),
          reason: reason.trim(),
          ...(patient ? { patientId: patient.id } : {}),
        },
      });
      setNotice(t("material.done", { item: item.code, quantity: qty }));
      setItem(null);
      setQty("1");
      setReason("");
      setPatient(null);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section>
      <h1>{t("material.title")}</h1>
      <div className="card form">
        <Notice>{notice}</Notice>
        <label>
          {t("stock.depot")}
          <select
            aria-label={t("stock.depot")}
            value={depot}
            onChange={(e) => setDepot(e.target.value)}
          >
            {depots.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        {item ? (
          <p data-picked={item.code}>
            <strong>{item.code}</strong> {label(item.labelFr, item.labelAr)}{" "}
            <button className="ghost" onClick={() => setItem(null)}>
              ×
            </button>
          </p>
        ) : (
          <ItemPicker onPick={setItem} kinds={["consumable", "reagent", "supply"]} />
        )}
        <label>
          {t("stock.quantity")}
          <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
        </label>
        {patient ? (
          <p data-patient={patient.identifier}>
            {patient.givenName} {patient.familyName}{" "}
            <span className="muted">{patient.identifier}</span>{" "}
            <button className="ghost" onClick={() => setPatient(null)}>
              ×
            </button>
          </p>
        ) : (
          <div>
            <input
              aria-label={t("material.patient")}
              placeholder={t("material.patient")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <ul className="list">
              {hits.map((p) => (
                <li key={p.id}>
                  <button
                    className="row"
                    onClick={() => {
                      setPatient(p);
                      setQ("");
                    }}
                  >
                    {p.givenName} {p.familyName} <span className="muted">{p.identifier}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        <label>
          {t("material.reason")}
          <input value={reason} onChange={(e) => setReason(e.target.value)} />
        </label>
        <ErrorBox error={error} />
        <button
          className="primary"
          disabled={!item || !qty.trim() || reason.trim().length < 3}
          onClick={() => void submit()}
        >
          {t("material.use")}
        </button>
      </div>
    </section>
  );
}

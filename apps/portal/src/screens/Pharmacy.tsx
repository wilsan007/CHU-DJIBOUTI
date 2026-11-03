import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../api.ts";
import { t } from "../i18n.ts";
import { ErrorBox, Notice } from "../ui.tsx";

interface Summary {
  id: string;
  number: string;
  status: string;
  lineCount: number;
  patient: { name: string; identifier: string } | null;
}
interface DispLine {
  lineNo: number;
  drugCode: string;
  dci: string;
  strength: string;
  prescribed: number;
  dispensed: number;
  remaining: number;
}
interface Status {
  prescriptionId: string;
  number: string;
  status: string;
  lines: DispLine[];
}
interface Detail {
  patientId: string;
  patient: { name: string; identifier: string } | null;
  overrides: { drugCode: string; justification: string; justifiedBy: string }[];
}
export function Pharmacy(): ReactNode {
  return (
    <section>
      <h1>{t("pharmacy.title")}</h1>
      <Prescriptions />
    </section>
  );
}

function Prescriptions(): ReactNode {
  const [list, setList] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [scan, setScan] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [a, b] = await Promise.all([
        api<{ prescriptions: Summary[] }>("/api/prescriptions?status=pending"),
        api<{ prescriptions: Summary[] }>("/api/prescriptions?status=partially_dispensed"),
      ]);
      setList([...a.prescriptions, ...b.prescriptions]);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const verify = async (): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      const r = await api<{ valid: boolean; superseded: boolean; currentId: string }>(
        `/api/prescriptions/verify/${encodeURIComponent(scan.trim())}`,
      );
      if (r.superseded) setNotice(t("pharmacy.verify.superseded"));
      else if (!r.valid) setNotice(t("pharmacy.verify.invalid"));
      if (r.valid || r.superseded) setSelected(r.currentId);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 400
          ? new ApiError(400, e.code, t("pharmacy.verify.invalid"), null)
          : e,
      );
    }
  };

  return (
    <>
      <ErrorBox error={error} />
      <Notice>{notice}</Notice>
      <div className="cols">
        <div className="card">
          <label>
            {t("pharmacy.verify")}
            <input
              value={scan}
              onChange={(e) => setScan(e.target.value)}
              placeholder="RX1.P-000001.00"
              autoComplete="off"
            />
          </label>
          <button disabled={!scan.trim()} onClick={() => void verify()}>
            {t("pharmacy.verify.go")}
          </button>
          {list.length === 0 && <p className="muted">{t("common.none")}</p>}
          <ul className="list">
            {list.map((p) => (
              <li key={p.id}>
                <button
                  className={selected === p.id ? "row active" : "row"}
                  data-rx={p.number}
                  onClick={() => {
                    setSelected(p.id);
                    setNotice("");
                  }}
                >
                  <strong>{p.number}</strong> {p.patient?.name}{" "}
                  <span className="muted">{t(`pharmacy.status.${p.status}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          {selected ? (
            <Dispense
              key={selected}
              id={selected}
              onDone={(m) => {
                setNotice(m);
                void load();
              }}
            />
          ) : (
            <p className="muted">{t("common.none")}</p>
          )}
        </div>
      </div>
    </>
  );
}

function Dispense({ id, onDone }: { id: string; onDone: (message: string) => void }): ReactNode {
  const [status, setStatus] = useState<Status | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [allergies, setAllergies] = useState<string[]>([]);
  const [depots, setDepots] = useState<{ code: string; name: string }[]>([]);
  const [depot, setDepot] = useState("");
  const [qty, setQty] = useState<Record<number, string>>({});
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    try {
      const [s, d, dep] = await Promise.all([
        api<Status>(`/api/pharmacy/prescriptions/${id}`),
        api<Detail>(`/api/prescriptions/${id}`),
        api<{ depots: { code: string; name: string; kind: string }[] }>("/api/stock/depots"),
      ]);
      setStatus(s);
      setDetail(d);
      setDepots(dep.depots.filter((d) => d.kind === "pharmacy"));
      setDepot((cur) => cur || dep.depots.find((d) => d.kind === "pharmacy")?.code || "");
      setQty(Object.fromEntries(s.lines.map((l) => [l.lineNo, String(l.remaining)])));
      const b = await api<{ allergies: { label: string }[] }>(
        `/api/patients/${d.patientId}/banner`,
      );
      setAllergies(b.allergies.map((a) => a.label));
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const dispense = async (): Promise<void> => {
    if (!status) return;
    setError(null);
    const lines = status.lines
      .map((l) => ({ lineNo: l.lineNo, quantity: Number(qty[l.lineNo] ?? 0) }))
      .filter((l) => l.quantity > 0);
    try {
      const r = await api<{ number: string; prescriptionStatus: string }>(
        "/api/pharmacy/dispensations",
        {
          method: "POST",
          body: { prescriptionId: id, depot, lines },
        },
      );
      onDone(
        t("pharmacy.done", {
          number: r.number,
          status: t(`pharmacy.status.${r.prescriptionStatus}`),
        }),
      );
      await load();
    } catch (e) {
      setError(e);
    }
  };

  if (!status) return <ErrorBox error={error} />;
  const open = status.status === "pending" || status.status === "partially_dispensed";
  return (
    <div className="form" data-dispense={status.number}>
      <h2>
        {status.number}{" "}
        <span className="muted">
          {detail?.patient?.name} · {detail?.patient?.identifier}
        </span>
      </h2>
      {allergies.length > 0 && (
        <p className="warn">
          {t("pharmacy.allergies")} : {allergies.join(", ")}
        </p>
      )}
      {detail && detail.overrides.length > 0 && (
        <div className="warn">
          <strong>{t("pharmacy.overrides")}</strong>
          <ul>
            {detail.overrides.map((o, i) => (
              <li key={i}>
                {o.drugCode} : {o.justification}
              </li>
            ))}
          </ul>
        </div>
      )}
      <table className="table">
        <thead>
          <tr>
            <th>{t("pharmacy.line")}</th>
            <th>{t("pharmacy.prescribed")}</th>
            <th>{t("pharmacy.dispensed")}</th>
            <th>{t("pharmacy.remaining")}</th>
            {open && <th>{t("pharmacy.quantity")}</th>}
          </tr>
        </thead>
        <tbody>
          {status.lines.map((l) => (
            <tr key={l.lineNo} data-line={l.drugCode}>
              <td>
                {l.dci} {l.strength}
              </td>
              <td>{l.prescribed}</td>
              <td>{l.dispensed}</td>
              <td>{l.remaining}</td>
              {open && (
                <td>
                  <input
                    aria-label={`${t("pharmacy.quantity")} ${l.drugCode}`}
                    inputMode="numeric"
                    value={qty[l.lineNo] ?? ""}
                    onChange={(e) => setQty({ ...qty, [l.lineNo]: e.target.value })}
                  />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {open && (
        <>
          <label>
            {t("pharmacy.depot")}
            <select value={depot} onChange={(e) => setDepot(e.target.value)}>
              {depots.map((d) => (
                <option key={d.code} value={d.code}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <ErrorBox error={error} />
          <button className="primary" disabled={!depot} onClick={() => void dispense()}>
            {t("pharmacy.dispense")}
          </button>
        </>
      )}
      {!open && <p className="muted">{t(`pharmacy.status.${status.status}`)}</p>}
    </div>
  );
}

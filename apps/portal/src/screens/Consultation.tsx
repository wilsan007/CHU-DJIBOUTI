import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, can } from "../api.ts";
import { label, t } from "../i18n.ts";
import { ErrorBox, Notice, confirmAction, ScrollTable, Btn } from "../ui.tsx";

interface Vital {
  kind: string;
  value: number;
  unit: string;
  confirmedUnusual: boolean;
}
interface Diagnosis {
  code: string;
  labelFr: string;
  labelAr: string;
  primary: boolean;
}
interface Consultation {
  id: string;
  status: "draft" | "closed";
  reason: string;
  exam: string;
  notes: string;
  version: number;
  vitals?: Vital[];
  diagnoses?: Diagnosis[];
}
interface Template {
  id: number;
  name: string;
  specialty: string;
}

const VITALS = [
  "weight",
  "height",
  "systolic",
  "diastolic",
  "temperature",
  "pulse",
  "spo2",
] as const;

export function ConsultationPanel({
  patientId,
  encounterId,
}: {
  patientId: string;
  encounterId: string;
}): ReactNode {
  const [consultation, setConsultation] = useState<Consultation | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      // Réponse vide (204) : aucune consultation commencée pour cette admission.
      setConsultation(
        (await api<Consultation | null>(`/api/encounters/${encounterId}/consultation`)) ?? null,
      );
    } catch (e) {
      setError(e);
    }
  }, [encounterId]);
  useEffect(() => {
    setConsultation(undefined);
    setNotice("");
    void load();
  }, [load]);

  if (consultation === undefined) return <ErrorBox error={error} />;
  if (consultation === null)
    return <StartConsultation patientId={patientId} encounterId={encounterId} onStarted={load} />;

  const closed = consultation.status === "closed";
  return (
    <div className="form" data-consultation={consultation.id}>
      <h3>{t("consult.title")}</h3>
      <ErrorBox error={error} />
      <Notice>{closed ? t("consult.closed") : notice}</Notice>
      <Texts
        consultation={consultation}
        disabled={closed}
        onSaved={(m) => {
          setNotice(m);
          void load();
        }}
      />
      <Vitals consultation={consultation} disabled={closed} onChanged={load} />
      <Diagnoses consultation={consultation} disabled={closed} onChanged={load} />
      {!closed && can("prescription:write") && (
        <Prescription patientId={patientId} consultationId={consultation.id} />
      )}
      {!closed && (
        <CloseButton
          consultationId={consultation.id}
          disabled={(consultation.diagnoses ?? []).length === 0}
          onClosed={() => {
            setNotice(t("consult.close.done"));
            void load();
          }}
        />
      )}
    </div>
  );
}

function StartConsultation({
  patientId,
  encounterId,
  onStarted,
}: {
  patientId: string;
  encounterId: string;
  onStarted: () => Promise<void>;
}): ReactNode {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState("");
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    api<{ templates: Template[] }>("/api/clinical/templates")
      .then((r) => setTemplates(r.templates))
      .catch(() => setTemplates([]));
  }, []);
  const start = async (): Promise<void> => {
    setError(null);
    try {
      await api("/api/consultations", {
        method: "POST",
        body: { patientId, encounterId, ...(templateId ? { templateId: Number(templateId) } : {}) },
      });
      await onStarted();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="form">
      <h3>{t("consult.title")}</h3>
      {templates.length > 0 && (
        <label>
          {t("consult.template")}
          <select value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
            <option value="">{t("consult.none")}</option>
            {templates.map((x) => (
              <option key={x.id} value={x.id}>
                {x.specialty} · {x.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <ErrorBox error={error} />
      <button className="primary" onClick={() => void start()}>
        {t("consult.start")}
      </button>
    </div>
  );
}

interface Conflict {
  current: { reason: string; exam: string; notes: string; version: number };
}

function Texts({
  consultation,
  disabled,
  onSaved,
}: {
  consultation: Consultation;
  disabled: boolean;
  onSaved: (message: string) => void;
}): ReactNode {
  const [fields, setFields] = useState({
    reason: consultation.reason,
    exam: consultation.exam,
    notes: consultation.notes,
  });
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setFields({ reason: consultation.reason, exam: consultation.exam, notes: consultation.notes });
  }, [
    consultation.id,
    consultation.version,
    consultation.reason,
    consultation.exam,
    consultation.notes,
  ]);

  const save = async (expectedVersion: number): Promise<void> => {
    setError(null);
    try {
      const saved = await api<Consultation>(`/api/consultations/${consultation.id}`, {
        method: "PUT",
        body: { expectedVersion, ...fields },
      });
      setConflict(null);
      onSaved(t("consult.saved", { version: saved.version }));
    } catch (e) {
      if (e instanceof ApiError && e.code === "edit_conflict") setConflict(e.details as Conflict);
      else setError(e);
    }
  };

  return (
    <div>
      {(["reason", "exam", "notes"] as const).map((k) => (
        <label key={k}>
          {t(`consult.${k}`)}
          <textarea
            rows={k === "notes" ? 4 : 3}
            disabled={disabled}
            value={fields[k]}
            onChange={(e) => setFields({ ...fields, [k]: e.target.value })}
          />
        </label>
      ))}
      <ErrorBox error={error} />
      {conflict && (
        <div role="alert" className="warn">
          <p>{t("consult.conflict")}</p>
          <p className="muted">
            {t("consult.conflict.current")} (v{conflict.current.version}) :{" "}
            {conflict.current.reason} / {conflict.current.exam} / {conflict.current.notes}
          </p>
          <div className="actions">
            <button onClick={() => void save(conflict.current.version)}>
              {t("consult.conflict.mine")}
            </button>
            <button
              onClick={() => {
                setFields({
                  reason: conflict.current.reason,
                  exam: conflict.current.exam,
                  notes: conflict.current.notes,
                });
                setConflict(null);
                onSaved("");
              }}
            >
              {t("consult.conflict.theirs")}
            </button>
          </div>
        </div>
      )}
      {!disabled && (
        <button onClick={() => void save(consultation.version)}>{t("consult.save")}</button>
      )}
    </div>
  );
}

function Vitals({
  consultation,
  disabled,
  onChanged,
}: {
  consultation: Consultation;
  disabled: boolean;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [kind, setKind] = useState<string>(VITALS[0]);
  const [value, setValue] = useState("");
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const add = async (confirm: boolean): Promise<void> => {
    setError(null);
    try {
      await api(`/api/consultations/${consultation.id}/vitals`, {
        method: "POST",
        body: { kind, value: Number(value), ...(confirm ? { confirm: true } : {}) },
      });
      setValue("");
      setNeedsConfirm(false);
      await onChanged();
    } catch (e) {
      if (e instanceof ApiError && e.code === "value_needs_confirmation") setNeedsConfirm(true);
      else setError(e);
    }
  };

  return (
    <div>
      <h4>{t("consult.vitals")}</h4>
      <ul className="plain" data-vitals>
        {(consultation.vitals ?? []).map((v, i) => (
          <li key={i}>
            {t(`consult.vital.${v.kind}`)} : <strong>{v.value}</strong>{" "}
            {v.confirmedUnusual && <span className="flag abnormal">!</span>}
          </li>
        ))}
      </ul>
      {!disabled && (
        <div className="inline">
          <select
            aria-label={t("consult.vital.kind")}
            value={kind}
            onChange={(e) => {
              setKind(e.target.value);
              setNeedsConfirm(false);
            }}
          >
            {VITALS.map((k) => (
              <option key={k} value={k}>
                {t(`consult.vital.${k}`)}
              </option>
            ))}
          </select>
          <input
            aria-label={t("consult.vital.value")}
            inputMode="decimal"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setNeedsConfirm(false);
              setError(null);
            }}
          />
          <Btn
            why={!value.trim() || Number.isNaN(Number(value)) ? t("why.number") : null}
            onClick={() => void add(false)}
          >
            {t("consult.vital.add")}
          </Btn>
        </div>
      )}
      <ErrorBox error={error} />
      {needsConfirm && (
        <div role="alert" className="warn">
          <button onClick={() => void add(true)}>{t("consult.vital.confirm")}</button>
        </div>
      )}
    </div>
  );
}

function Diagnoses({
  consultation,
  disabled,
  onChanged,
}: {
  consultation: Consultation;
  disabled: boolean;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Diagnosis[]>([]);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ diagnoses: Diagnosis[] }>(`/api/catalog/diagnoses?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setHits(r.diagnoses))
        .catch(setError);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const add = async (code: string): Promise<void> => {
    setError(null);
    try {
      await api(`/api/consultations/${consultation.id}/diagnoses`, {
        method: "POST",
        body: { code },
      });
      setQ("");
      await onChanged();
    } catch (e) {
      setError(e);
    }
  };
  const remove = async (code: string): Promise<void> => {
    setError(null);
    try {
      await api(`/api/consultations/${consultation.id}/diagnoses/${encodeURIComponent(code)}`, {
        method: "DELETE",
      });
      await onChanged();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div>
      <h4>{t("consult.diagnoses")}</h4>
      <ul className="plain" data-diagnoses>
        {(consultation.diagnoses ?? []).map((d) => (
          <li key={d.code}>
            <strong>{d.code}</strong> {label(d.labelFr, d.labelAr)}{" "}
            {d.primary && <span className="badge">{t("consult.diagnosis.primary")}</span>}
            {!disabled && (
              <button className="ghost" onClick={() => void remove(d.code)}>
                {t("consult.diagnosis.remove")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {!disabled && (
        <>
          <input
            aria-label={t("consult.diagnosis.search")}
            placeholder={t("consult.diagnosis.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="list">
            {hits.map((h) => (
              <li key={h.code}>
                <button className="row" onClick={() => void add(h.code)}>
                  <strong>{h.code}</strong> {label(h.labelFr, h.labelAr)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <ErrorBox error={error} />
    </div>
  );
}

interface Drug {
  code: string;
  dci: string;
  form: string;
  strength: string;
  labelAr: string | null;
}
interface RxLine {
  drug: Drug;
  dose: string;
  perDay: string;
  days: string;
}
interface Alert {
  key: string;
  kind: string;
  drugCode: string;
  messageFr: string;
  messageAr: string;
}

function Prescription({
  patientId,
  consultationId,
}: {
  patientId: string;
  consultationId: string;
}): ReactNode {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Drug[]>([]);
  const [lines, setLines] = useState<RxLine[]>([]);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ drugs: Drug[] }>(`/api/catalog/drugs?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setHits(r.drugs))
        .catch(setError);
    }, 250);
    return () => clearTimeout(timer);
  }, [q]);

  const body = (): {
    lines: { drugCode: string; dose: number; perDay: number; days: number; route: string }[];
  } => ({
    lines: lines.map((l) => ({
      drugCode: l.drug.code,
      dose: Number(l.dose),
      perDay: Number(l.perDay),
      days: Number(l.days),
      route: "oral",
    })),
  });
  const valid =
    lines.length > 0 &&
    lines.every((l) => Number(l.dose) > 0 && Number(l.perDay) >= 1 && Number(l.days) >= 1);

  const check = async (): Promise<Alert[] | null> => {
    setError(null);
    try {
      const r = await api<{ alerts: Alert[] }>("/api/prescriptions/check", {
        method: "POST",
        body: { patientId, ...body() },
      });
      setAlerts(r.alerts);
      return r.alerts;
    } catch (e) {
      setError(e);
      return null;
    }
  };

  const sign = async (): Promise<void> => {
    const found = alerts ?? (await check());
    if (found === null) return;
    const overrides = found.map((a) => ({
      key: a.key,
      justification: (reasons[a.key] ?? "").trim(),
    }));
    if (overrides.some((o) => o.justification.length < 5)) {
      setError(new ApiError(409, "alerts_require_justification", t("rx.alertNeedsReason"), null));
      return;
    }
    setError(null);
    try {
      const rx = await api<{ id: string; number: string }>("/api/prescriptions", {
        method: "POST",
        body: { patientId, consultationId, ...body(), overrides },
      });
      setNotice(t("rx.signed", { number: rx.number }));
      setLines([]);
      setAlerts(null);
      setReasons({});
      const printed = await api<{ html: string }>(`/api/prescriptions/${rx.id}/print`);
      window.open(URL.createObjectURL(new Blob([printed.html], { type: "text/html" })), "_blank");
    } catch (e) {
      setError(e);
    }
  };

  const update = (i: number, patch: Partial<RxLine>): void => {
    setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setAlerts(null);
  };

  return (
    <div data-prescription>
      <h4>{t("rx.title")}</h4>
      <Notice>{notice}</Notice>
      <input
        aria-label={t("rx.drug.search")}
        placeholder={t("rx.drug.search")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="list">
        {hits.map((d) => (
          <li key={d.code}>
            <button
              className="row"
              onClick={() => {
                setLines([...lines, { drug: d, dose: "1", perDay: "3", days: "5" }]);
                setAlerts(null);
                setQ("");
              }}
            >
              {d.dci} {d.strength} <span className="muted">{d.form}</span> · {t("rx.add")}
            </button>
          </li>
        ))}
      </ul>
      {lines.length > 0 && (
        <ScrollTable>
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>{t("rx.dose")}</th>
                <th>{t("rx.perDay")}</th>
                <th>{t("rx.days")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={l.drug.code} data-rx-line={l.drug.code}>
                  <td>
                    {l.drug.dci} {l.drug.strength}
                  </td>
                  <td>
                    <input
                      aria-label={`${t("rx.dose")} ${l.drug.code}`}
                      inputMode="decimal"
                      value={l.dose}
                      onChange={(e) => update(i, { dose: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`${t("rx.perDay")} ${l.drug.code}`}
                      inputMode="numeric"
                      value={l.perDay}
                      onChange={(e) => update(i, { perDay: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      aria-label={`${t("rx.days")} ${l.drug.code}`}
                      inputMode="numeric"
                      value={l.days}
                      onChange={(e) => update(i, { days: e.target.value })}
                    />
                  </td>
                  <td>
                    <button
                      className="ghost"
                      onClick={() => {
                        setLines(lines.filter((_, j) => j !== i));
                        setAlerts(null);
                      }}
                    >
                      {t("rx.remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      )}
      {alerts && alerts.length === 0 && <p className="muted">{t("rx.noAlerts")}</p>}
      {alerts?.map((a) => (
        <div key={a.key} role="alert" className="warn" data-alert={a.kind}>
          <p>
            <strong>{label(a.messageFr, a.messageAr)}</strong>
          </p>
          <label>
            {t("rx.justification")}
            <textarea
              rows={2}
              value={reasons[a.key] ?? ""}
              onChange={(e) => setReasons({ ...reasons, [a.key]: e.target.value })}
            />
          </label>
        </div>
      ))}
      <ErrorBox error={error} />
      <div className="actions">
        <Btn why={!valid ? t("why.rx") : null} onClick={() => void check()}>
          {t("rx.check")}
        </Btn>
        <Btn className="primary" why={!valid ? t("why.rx") : null} onClick={() => void sign()}>
          {t("rx.sign")}
        </Btn>
      </div>
    </div>
  );
}

function CloseButton({
  consultationId,
  disabled,
  onClosed,
}: {
  consultationId: string;
  disabled: boolean;
  onClosed: () => void;
}): ReactNode {
  const [error, setError] = useState<unknown>(null);
  const close = async (): Promise<void> => {
    if (!confirmAction(t("confirm.closeConsult"))) return;
    setError(null);
    try {
      await api(`/api/consultations/${consultationId}/close`, { method: "POST" });
      onClosed();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div>
      <ErrorBox error={error} />
      <Btn
        className="primary"
        why={disabled ? t("why.diagnosis") : null}
        onClick={() => void close()}
      >
        {t("consult.close")}
      </Btn>
    </div>
  );
}

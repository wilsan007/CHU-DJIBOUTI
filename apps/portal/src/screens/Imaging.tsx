import { useCallback, useEffect, useState, type ReactNode } from "react";
import { accessToken } from "../auth.ts";
import { api } from "../api.ts";
import { label, t } from "../i18n.ts";
import { ErrorBox, Notice } from "../ui.tsx";

interface Request {
  id: string;
  number: string;
  actCode: string;
  labelFr: string;
  labelAr: string;
  status: string;
  scheduledFor: string | null;
  accession: string | null;
  patient: { name: string; identifier: string } | null;
}
export interface Study {
  id: string;
  modality: string | null;
  description: string | null;
  seriesCount: number;
  instanceCount: number;
  patientMatch: boolean;
}
interface Detail {
  studies: Study[];
  images: { id: string; filename: string; mime: string }[];
  reports: { version: number; findings: string; conclusion: string }[];
}

const toBase64 = (buf: ArrayBuffer): string => {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

async function authedBlob(path: string): Promise<string> {
  const res = await fetch(path, {
    headers: { authorization: `Bearer ${(await accessToken()) ?? ""}` },
  });
  if (!res.ok) throw new Error(String(res.status));
  return URL.createObjectURL(await res.blob());
}

/** Études DICOM rattachées à l'examen : aperçus chargés à la demande, jamais d'accès direct au serveur d'images. */
export function DicomStudies({ studies }: { studies: Study[] }): ReactNode {
  const [shown, setShown] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<unknown>(null);
  if (studies.length === 0) return null;
  const open = async (s: Study): Promise<void> => {
    setError(null);
    try {
      const list = await api<{ instances: { id: string }[] }>(
        `/api/imaging/studies/${s.id}/instances`,
      );
      const urls = await Promise.all(
        list.instances
          .slice(0, 12)
          .map((i) => authedBlob(`/api/imaging/studies/${s.id}/instances/${i.id}/preview`)),
      );
      setShown((cur) => ({ ...cur, [s.id]: urls }));
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div data-dicom>
      <h4>{t("imaging.dicom")}</h4>
      <ErrorBox error={error} />
      <ul className="plain">
        {studies.map((s) => (
          <li key={s.id} data-study={s.id} data-match={s.patientMatch}>
            {s.modality ?? "?"} · {t("imaging.dicom.count", { n: s.instanceCount })}{" "}
            {s.patientMatch ? (
              <button onClick={() => void open(s)}>{t("imaging.dicom.view")}</button>
            ) : (
              <span className="flag critical">{t("imaging.dicom.mismatch")}</span>
            )}
            <div className="thumbs">
              {(shown[s.id] ?? []).map((u) => (
                <img key={u} src={u} alt={t("imaging.dicom.image")} width={160} />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export async function openImage(id: string): Promise<void> {
  const res = await fetch(`/api/imaging/images/${id}`, {
    headers: { authorization: `Bearer ${(await accessToken()) ?? ""}` },
  });
  window.open(URL.createObjectURL(await res.blob()), "_blank");
}

export function Imaging(): ReactNode {
  const [list, setList] = useState<Request[]>([]);
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setList((await api<{ requests: Request[] }>("/api/imaging/requests")).requests);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);
  const open = list.filter((r) => r.status !== "reported");
  return (
    <section>
      <h1>{t("imaging.title")}</h1>
      <ErrorBox error={error} />
      {open.length === 0 && <p className="muted">{t("common.none")}</p>}
      <div className="grid">
        {open.map((r) => (
          <RequestCard key={r.id} request={r} onChanged={load} />
        ))}
      </div>
    </section>
  );
}

function RequestCard({
  request,
  onChanged,
}: {
  request: Request;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [when, setWhen] = useState("");
  const [detail, setDetail] = useState<Detail | null>(null);
  const [findings, setFindings] = useState("");
  const [conclusion, setConclusion] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const loadDetail = useCallback(async () => {
    if (request.status === "in_progress")
      setDetail(await api<Detail>(`/api/imaging/requests/${request.id}`));
  }, [request.id, request.status]);
  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);
  const run = async (fn: () => Promise<string | void>): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      const m = await fn();
      if (m) setNotice(m);
      await onChanged();
      await loadDetail();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <article className="card" data-exam={request.number}>
      <h3>
        {t("imaging.request", { number: request.number })}{" "}
        <span className="badge">{t(`imaging.status.${request.status}`)}</span>
      </h3>
      <p>
        <strong>{request.patient?.name}</strong>{" "}
        <span className="muted">
          {request.patient?.identifier} · {label(request.labelFr, request.labelAr)}
        </span>
      </p>
      {request.accession && (
        <p className="muted">{t("imaging.accession", { accession: request.accession })}</p>
      )}
      <ErrorBox error={error} />
      <Notice>{notice}</Notice>
      {(request.status === "pending" || request.status === "scheduled") && (
        <div className="form">
          {request.scheduledFor && (
            <p className="muted">{new Date(request.scheduledFor).toLocaleString()}</p>
          )}
          <label>
            {t("imaging.schedule.at")}
            <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />
          </label>
          <div className="actions">
            <button
              disabled={!when}
              onClick={() =>
                void run(async () => {
                  await api(`/api/imaging/requests/${request.id}/schedule`, {
                    method: "POST",
                    body: { scheduledFor: new Date(when).toISOString() },
                  });
                })
              }
            >
              {t("imaging.schedule")}
            </button>
            <button
              className="primary"
              onClick={() =>
                void run(async () => {
                  await api(`/api/imaging/requests/${request.id}/perform`, { method: "POST" });
                })
              }
            >
              {t("imaging.perform")}
            </button>
          </div>
        </div>
      )}
      {request.status === "in_progress" && (
        <div className="form">
          <DicomStudies studies={detail?.studies ?? []} />
          <p className="muted" data-image-count>
            {t("imaging.images", { count: detail?.images.length ?? 0 })}
          </p>
          <label>
            {t("imaging.upload")}
            <input
              type="file"
              accept="image/png,image/jpeg,application/pdf"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                void run(async () => {
                  await api(`/api/imaging/requests/${request.id}/images`, {
                    method: "POST",
                    body: {
                      filename: file.name,
                      mime: file.type,
                      dataBase64: toBase64(await file.arrayBuffer()),
                    },
                  });
                });
              }}
            />
          </label>
          <label>
            {t("imaging.findings")}
            <textarea rows={3} value={findings} onChange={(e) => setFindings(e.target.value)} />
          </label>
          <label>
            {t("imaging.conclusion")}
            <textarea rows={2} value={conclusion} onChange={(e) => setConclusion(e.target.value)} />
          </label>
          <button
            className="primary"
            disabled={findings.trim().length < 3 || conclusion.trim().length < 3}
            onClick={() =>
              void run(async () => {
                const r = await api<{ version: number }>(
                  `/api/imaging/requests/${request.id}/report`,
                  {
                    method: "POST",
                    body: { findings: findings.trim(), conclusion: conclusion.trim() },
                  },
                );
                return t("imaging.report.done", { version: r.version });
              })
            }
          >
            {t("imaging.report")}
          </button>
        </div>
      )}
    </article>
  );
}

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../api.ts";
import { t } from "../i18n.ts";
import { ErrorBox, Notice } from "../ui.tsx";

interface Mine {
  member: {
    name: string;
    matricule: string;
    category: string;
    jobTitle: string;
    departmentCode: string | null;
  };
  shifts: { id: string; departmentCode: string; kind: string; startsAt: string; endsAt: string }[];
  leaves: { id: string; kind: string; startsOn: string; endsOn: string; status: string }[];
}

const localDay = (iso: string): string =>
  new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
const localHour = (iso: string): string =>
  new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(11, 16);

/** Espace de chaque agent : mes gardes, mes congés et ma demande de congé. */
export function MySpace(): ReactNode {
  const [mine, setMine] = useState<Mine | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [f, setF] = useState({ kind: "annual", startsOn: "", endsOn: "", reason: "" });

  const load = useCallback(async () => {
    try {
      setMine(await api<Mine>("/api/staff/me"));
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setMine(null);
      else setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const request = async (): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      await api("/api/staff/me/leaves", {
        method: "POST",
        body: {
          kind: f.kind,
          startsOn: f.startsOn,
          endsOn: f.endsOn,
          ...(f.reason ? { reason: f.reason } : {}),
        },
      });
      setNotice(t("staff.leave.requested"));
      setF({ ...f, startsOn: "", endsOn: "", reason: "" });
      await load();
    } catch (e) {
      setError(e);
    }
  };
  const cancel = async (id: string): Promise<void> => {
    setError(null);
    try {
      await api(`/api/staff/me/leaves/${id}/cancel`, { method: "POST" });
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section>
      <h1>{t("nav.mySpace")}</h1>
      <ErrorBox error={error} />
      {mine === null && <p className="warn">{t("staff.me.noRecord")}</p>}
      {mine && (
        <div className="cols">
          <div className="card" data-my-record={mine.member.matricule}>
            <h2>
              {mine.member.name} <span className="muted">{mine.member.matricule}</span>
            </h2>
            <p>
              {t(`staff.cat.${mine.member.category}`)} · {mine.member.jobTitle}
            </p>
            <h3>{t("staff.me.shifts")}</h3>
            {mine.shifts.length === 0 && <p className="muted">{t("common.none")}</p>}
            <ul className="plain" data-my-shifts>
              {mine.shifts.map((s) => (
                <li key={s.id}>
                  {localDay(s.startsAt)} · {localHour(s.startsAt)}–{localHour(s.endsAt)} ·{" "}
                  {s.departmentCode} · {t(`staff.roster.kind.${s.kind}`)}
                </li>
              ))}
            </ul>
          </div>
          <div className="card form">
            <h3>{t("staff.me.leaves")}</h3>
            <Notice>{notice}</Notice>
            <ul className="plain" data-my-leaves>
              {mine.leaves.map((l) => (
                <li key={l.id} data-leave-status={l.status}>
                  {t(`staff.leave.kind.${l.kind}`)} · {l.startsOn} → {l.endsOn} ·{" "}
                  <span className="badge">{t(`staff.leave.status.${l.status}`)}</span>{" "}
                  {(l.status === "requested" || l.status === "approved") && (
                    <button className="ghost" onClick={() => void cancel(l.id)}>
                      {t("staff.leave.cancel")}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <label>
              {t("staff.leave.kind")}
              <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
                {["annual", "sick", "maternity", "unpaid", "other"].map((k) => (
                  <option key={k} value={k}>
                    {t(`staff.leave.kind.${k}`)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t("staff.leave.from")}
              <input
                type="date"
                value={f.startsOn}
                onChange={(e) => setF({ ...f, startsOn: e.target.value })}
              />
            </label>
            <label>
              {t("staff.leave.to")}
              <input
                type="date"
                value={f.endsOn}
                onChange={(e) => setF({ ...f, endsOn: e.target.value })}
              />
            </label>
            <label>
              {t("common.reason")}
              <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
            </label>
            <button
              className="primary"
              disabled={!f.startsOn || !f.endsOn}
              onClick={() => void request()}
            >
              {t("staff.leave.request")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

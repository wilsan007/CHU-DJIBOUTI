import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, ApiError, type Me } from "../api.ts";
import { label, t } from "../i18n.ts";
import { ErrorBox, Notice, confirmAction, ScrollTable, Btn } from "../ui.tsx";

const CATEGORIES = [
  "physician",
  "nurse",
  "care_assistant",
  "midwife",
  "lab_technician",
  "imaging_technician",
  "pharmacist",
  "biologist",
  "cashier",
  "reception",
  "storekeeper",
  "administration",
  "support",
  "management",
] as const;
const STATUSES = ["active", "on_leave", "suspended", "left"] as const;

interface Member {
  id: string;
  matricule: string;
  name: string;
  category: string;
  jobTitle: string;
  departmentCode: string | null;
  status: string;
  userId?: string | null;
  phone?: string | null;
  hiredOn?: string;
  qualifications?: Qualification[];
}
interface Qualification {
  id: number;
  kind: string;
  title: string;
  number: string | null;
  expiresOn: string | null;
  revoked: boolean;
}
interface Department {
  code: string;
  nameFr: string;
  nameAr: string;
}
interface Shift {
  id: string;
  memberId: string;
  name: string;
  departmentCode: string;
  kind: string;
  startsAt: string;
  endsAt: string;
}
interface Leave {
  id: string;
  memberId: string;
  name: string;
  kind: string;
  startsOn: string;
  endsOn: string;
  status: string;
  reason: string | null;
}

type Tab = "members" | "roster" | "leaves";

function useDepartments(): Department[] {
  const [list, setList] = useState<Department[]>([]);
  useEffect(() => {
    api<Department[]>("/api/catalog/departments")
      .then(setList)
      .catch(() => setList([]));
  }, []);
  return list;
}

/** Heure locale de Djibouti (UTC+3) : date AAAA-MM-JJ et heure → instant ISO. */
const instant = (date: string, hour: string): string =>
  `${date}T${hour.padStart(2, "0")}:00:00+03:00`;
const localDay = (iso: string): string =>
  new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(0, 10);
const localHour = (iso: string): string =>
  new Date(new Date(iso).getTime() + 3 * 3600_000).toISOString().slice(11, 16);

export function Staff({ me }: { me: Me }): ReactNode {
  const [tab, setTab] = useState<Tab>("members");
  const tabs: Tab[] = me.permissions.includes("leave:approve")
    ? ["members", "roster", "leaves"]
    : ["members"];
  return (
    <section>
      <h1>{t("staff.title")}</h1>
      <nav aria-label="personnel" className="subtabs">
        {tabs.map((x) => (
          <button
            key={x}
            className={tab === x ? "tab active" : "tab"}
            onClick={() => setTab(x)}
            data-tab={x}
          >
            {t(`staff.tab.${x}`)}
          </button>
        ))}
      </nav>
      {tab === "members" && <Members canManage={me.permissions.includes("staff:manage")} />}
      {tab === "roster" && <Roster />}
      {tab === "leaves" && <Leaves />}
    </section>
  );
}

function Members({ canManage }: { canManage: boolean }): ReactNode {
  const [q, setQ] = useState("");
  const [list, setList] = useState<Member[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setList(
        (await api<{ staff: Member[] }>(`/api/staff?q=${encodeURIComponent(q.trim())}`)).staff,
      );
    } catch (e) {
      setError(e);
    }
  }, [q]);
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  return (
    <div className="cols">
      <div className="card">
        <ErrorBox error={error} />
        <Notice>{notice}</Notice>
        <input
          aria-label={t("staff.search")}
          placeholder={t("staff.search")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ul className="list">
          {list.map((m) => (
            <li key={m.id}>
              <button
                className={selected === m.id ? "row active" : "row"}
                data-member={m.matricule}
                onClick={() => setSelected(m.id)}
              >
                <strong>{m.name}</strong>{" "}
                <span className="muted">
                  {m.matricule} · {t(`staff.cat.${m.category}`)} · {t(`staff.status.${m.status}`)}
                </span>
              </button>
            </li>
          ))}
        </ul>
        {canManage && (
          <NewMember
            onCreated={(m) => {
              setNotice(t("staff.created", { matricule: m.matricule }));
              setSelected(m.id);
              void load();
            }}
          />
        )}
      </div>
      <div className="card">
        {selected ? (
          <MemberPanel key={selected} id={selected} canManage={canManage} onChanged={load} />
        ) : (
          <p className="muted">{t("common.none")}</p>
        )}
      </div>
    </div>
  );
}

function NewMember({ onCreated }: { onCreated: (m: Member) => void }): ReactNode {
  const departments = useDepartments();
  const [open, setOpen] = useState(false);
  const [account, setAccount] = useState({ on: false, username: "", email: "", password: "" });
  const [f, setF] = useState({
    givenName: "",
    familyName: "",
    category: "nurse",
    jobTitle: "",
    departmentCode: "",
    hiredOn: "",
    phone: "",
  });
  const [error, setError] = useState<unknown>(null);
  const submit = async (): Promise<void> => {
    setError(null);
    try {
      const m = await api<Member>("/api/staff", {
        method: "POST",
        body: {
          givenName: f.givenName,
          familyName: f.familyName,
          category: f.category,
          jobTitle: f.jobTitle,
          hiredOn: f.hiredOn,
          ...(f.departmentCode ? { departmentCode: f.departmentCode } : {}),
          ...(f.phone ? { phone: f.phone } : {}),
          ...(account.on
            ? {
                account: {
                  username: account.username.trim(),
                  email: account.email.trim(),
                  temporaryPassword: account.password,
                },
              }
            : {}),
        },
      });
      setAccount({ on: false, username: "", email: "", password: "" });
      setOpen(false);
      setF({ ...f, givenName: "", familyName: "", jobTitle: "", phone: "" });
      onCreated(m);
    } catch (e) {
      setError(e);
    }
  };
  if (!open)
    return (
      <button className="primary" onClick={() => setOpen(true)}>
        {t("staff.new")}
      </button>
    );
  return (
    <div className="form">
      <h2>{t("staff.new")}</h2>
      <label>
        {t("staff.givenName")}
        <input value={f.givenName} onChange={(e) => setF({ ...f, givenName: e.target.value })} />
      </label>
      <label>
        {t("staff.familyName")}
        <input value={f.familyName} onChange={(e) => setF({ ...f, familyName: e.target.value })} />
      </label>
      <label>
        {t("staff.category")}
        <select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`staff.cat.${c}`)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("staff.jobTitle")}
        <input value={f.jobTitle} onChange={(e) => setF({ ...f, jobTitle: e.target.value })} />
      </label>
      <label>
        {t("staff.department")}
        <select
          value={f.departmentCode}
          onChange={(e) => setF({ ...f, departmentCode: e.target.value })}
        >
          <option value="" />
          {departments.map((d) => (
            <option key={d.code} value={d.code}>
              {label(d.nameFr, d.nameAr)}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("staff.hiredOn")}
        <input
          type="date"
          value={f.hiredOn}
          onChange={(e) => setF({ ...f, hiredOn: e.target.value })}
        />
      </label>
      <label>
        {t("staff.phone")}
        <input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
      </label>
      <label className="checks">
        <input
          type="checkbox"
          checked={account.on}
          onChange={(e) => setAccount({ ...account, on: e.target.checked })}
          data-create-account
        />
        {t("staff.account.create")}
      </label>
      {account.on && (
        <>
          <label>
            {t("staff.account.username")}
            <input
              value={account.username}
              onChange={(e) => setAccount({ ...account, username: e.target.value })}
            />
          </label>
          <label>
            {t("staff.account.email")}
            <input
              type="email"
              value={account.email}
              onChange={(e) => setAccount({ ...account, email: e.target.value })}
            />
          </label>
          <label>
            {t("staff.account.password")}
            <input
              type="password"
              value={account.password}
              onChange={(e) => setAccount({ ...account, password: e.target.value })}
            />
          </label>
        </>
      )}
      <ErrorBox error={error} />
      <div className="actions">
        <Btn
          className="primary"
          why={
            !f.givenName ||
            !f.familyName ||
            !f.jobTitle ||
            !f.hiredOn ||
            (account.on &&
              (account.username.trim().length < 3 ||
                !account.email.includes("@") ||
                account.password.length < 12))
              ? t("why.fields")
              : null
          }
          onClick={() => void submit()}
        >
          {t("staff.create")}
        </Btn>
        <button onClick={() => setOpen(false)}>{t("common.cancel")}</button>
      </div>
    </div>
  );
}

function MemberPanel({
  id,
  canManage,
  onChanged,
}: {
  id: string;
  canManage: boolean;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [m, setM] = useState<Member | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const [status, setStatus] = useState({ status: "suspended", reason: "" });
  const [account, setAccount] = useState("");
  const [q, setQ] = useState({ kind: "diploma", title: "", number: "", expiresOn: "" });

  const load = useCallback(async () => {
    try {
      setM(await api<Member>(`/api/staff/${id}`));
    } catch (e) {
      setError(e);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      await fn();
      await load();
      await onChanged();
    } catch (e) {
      setError(e);
    }
  };

  if (!m) return <ErrorBox error={error} />;
  return (
    <div className="form" data-member-panel={m.matricule}>
      <h2>
        {m.name} <span className="muted">{m.matricule}</span>
      </h2>
      <p>
        {t(`staff.cat.${m.category}`)} · {m.jobTitle} · {m.departmentCode ?? ""} ·{" "}
        <span className="badge">{t(`staff.status.${m.status}`)}</span>
      </p>
      <ErrorBox error={error} />
      <Notice>{notice}</Notice>
      {canManage && (
        <>
          <p className="muted">
            {m.phone} · {t("staff.hiredOn")} {m.hiredOn} ·{" "}
            {m.userId ? `${t("staff.link")} : ${m.userId}` : ""}
          </p>
          <h3>{t("staff.qualifications")}</h3>
          <ul className="plain" data-qualifications>
            {(m.qualifications ?? []).map((x) => (
              <li key={x.id} data-qualification={x.title}>
                <strong>{t(`staff.qualification.kind.${x.kind}`)}</strong> {x.title} {x.number}{" "}
                {x.expiresOn && `· ${t("staff.qualification.expires")} ${x.expiresOn}`}{" "}
                {x.revoked ? (
                  <span className="flag critical">{t("staff.qualification.revoked")}</span>
                ) : (
                  <button
                    className="ghost"
                    onClick={() =>
                      void run(async () => {
                        await api(`/api/staff/qualifications/${x.id}/revoke`, {
                          method: "POST",
                          body: { reason: "Retrait par les ressources humaines" },
                        });
                      })
                    }
                  >
                    {t("staff.qualification.revoke")}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="inline">
            <select
              aria-label={t("staff.qualification.kind")}
              value={q.kind}
              onChange={(e) => setQ({ ...q, kind: e.target.value })}
            >
              {["diploma", "certification"].map((k) => (
                <option key={k} value={k}>
                  {t(`staff.qualification.kind.${k}`)}
                </option>
              ))}
            </select>
            <input
              aria-label={t("staff.qualification.title")}
              placeholder={t("staff.qualification.title")}
              value={q.title}
              onChange={(e) => setQ({ ...q, title: e.target.value })}
            />
            <input
              aria-label={t("staff.qualification.expires")}
              type="date"
              value={q.expiresOn}
              onChange={(e) => setQ({ ...q, expiresOn: e.target.value })}
            />
            <Btn
              why={q.title.trim().length < 2 ? t("why.text", { n: 2 }) : null}
              onClick={() =>
                void run(async () => {
                  await api(`/api/staff/${id}/qualifications`, {
                    method: "POST",
                    body: {
                      kind: q.kind,
                      title: q.title.trim(),
                      ...(q.expiresOn ? { expiresOn: q.expiresOn } : {}),
                    },
                  });
                  setQ({ ...q, title: "", expiresOn: "" });
                })
              }
            >
              {t("staff.qualification.add")}
            </Btn>
          </div>

          <h3>{t("staff.status")}</h3>
          <div className="inline">
            <select
              aria-label={t("staff.status")}
              value={status.status}
              onChange={(e) => setStatus({ ...status, status: e.target.value })}
            >
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`staff.status.${s}`)}
                </option>
              ))}
            </select>
            <input
              aria-label={t("staff.status.reason")}
              placeholder={t("staff.status.reason")}
              value={status.reason}
              onChange={(e) => setStatus({ ...status, reason: e.target.value })}
            />
            <Btn
              why={status.reason.trim().length < 3 ? t("why.reason", { n: 3 }) : null}
              onClick={() =>
                void run(async () => {
                  if (status.status !== "active" && !confirmAction(t("confirm.staffStatus")))
                    return;
                  const r = await api<{ removedShifts: number; account: string | null }>(
                    `/api/staff/${id}/status`,
                    {
                      method: "POST",
                      body: {
                        status: status.status,
                        effectiveOn: new Date().toISOString().slice(0, 10),
                        reason: status.reason.trim(),
                      },
                    },
                  );
                  setNotice(
                    t("staff.status.done", {
                      shifts: r.removedShifts,
                      account: t(`staff.account.${r.account ?? "none"}`),
                    }),
                  );
                  setStatus({ ...status, reason: "" });
                })
              }
            >
              {t("staff.status.change")}
            </Btn>
          </div>

          <div className="inline">
            <input
              aria-label={t("staff.link")}
              placeholder={t("staff.link")}
              value={account}
              onChange={(e) => setAccount(e.target.value)}
            />
            <Btn
              why={!account.trim() ? t("why.account") : null}
              onClick={() =>
                void run(async () => {
                  await api(`/api/staff/${id}/link`, {
                    method: "POST",
                    body: { userId: account.trim() },
                  });
                  setAccount("");
                })
              }
            >
              {t("staff.link.go")}
            </Btn>
          </div>
        </>
      )}
    </div>
  );
}

function Roster(): ReactNode {
  const departments = useDepartments();
  const [dept, setDept] = useState("CONS");
  const [from, setFrom] = useState(new Date().toISOString().slice(0, 10));
  const [shifts, setShifts] = useState<Shift[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [duty, setDuty] = useState<Shift[]>([]);
  const [f, setF] = useState({
    memberId: "",
    kind: "day",
    date: new Date().toISOString().slice(0, 10),
    start: "8",
    end: "16",
  });
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const to = new Date(Date.parse(`${from}T00:00:00Z`) + 7 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      const [s, o] = await Promise.all([
        api<{ shifts: Shift[] }>(
          `/api/staff/shifts?from=${encodeURIComponent(instant(from, "0"))}&to=${encodeURIComponent(instant(to, "0"))}&department=${dept}`,
        ),
        api<{ onDuty: Shift[] }>(`/api/staff/on-duty?department=${dept}`),
      ]);
      setShifts(s.shifts);
      setDuty(o.onDuty);
    } catch (e) {
      setError(e);
    }
  }, [from, dept]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    api<{ staff: Member[] }>("/api/staff?status=active")
      .then((r) => setMembers(r.staff))
      .catch(() => setMembers([]));
  }, []);

  const add = async (): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      const endDate =
        Number(f.end) <= Number(f.start)
          ? new Date(Date.parse(`${f.date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
          : f.date;
      await api("/api/staff/shifts", {
        method: "POST",
        body: {
          memberId: f.memberId,
          departmentCode: dept,
          kind: f.kind,
          startsAt: instant(f.date, f.start),
          endsAt: instant(endDate, f.end),
        },
      });
      setNotice(t("staff.roster.added"));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e : e);
    }
  };
  const remove = async (id: string): Promise<void> => {
    setError(null);
    try {
      await api(`/api/staff/shifts/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="cols">
      <div className="card">
        <p className="muted">{t("staff.roster.hint")}</p>
        <label>
          {t("staff.department")}
          <select
            aria-label={t("staff.department")}
            value={dept}
            onChange={(e) => setDept(e.target.value)}
          >
            {departments.map((d) => (
              <option key={d.code} value={d.code}>
                {label(d.nameFr, d.nameAr)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("staff.roster.from")}
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <h2>{t("staff.roster.onDuty")}</h2>
        <ul className="plain" data-onduty>
          {duty.map((d) => (
            <li key={d.id}>{d.name}</li>
          ))}
        </ul>
        <ScrollTable>
          <table className="table" data-roster>
            <tbody>
              {shifts.map((s) => (
                <tr key={s.id} data-shift={s.name}>
                  <td>{localDay(s.startsAt)}</td>
                  <td>
                    {localHour(s.startsAt)}–{localHour(s.endsAt)}
                  </td>
                  <td>{s.name}</td>
                  <td>{t(`staff.roster.kind.${s.kind}`)}</td>
                  <td>
                    <button className="ghost" onClick={() => void remove(s.id)}>
                      {t("staff.roster.remove")}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      </div>
      <div className="card form">
        <Notice>{notice}</Notice>
        <label>
          {t("staff.roster.member")}
          <select
            aria-label={t("staff.roster.member")}
            value={f.memberId}
            onChange={(e) => setF({ ...f, memberId: e.target.value })}
          >
            <option value="" />
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.matricule})
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("staff.roster.kind")}
          <select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
            {["day", "night", "on_call"].map((k) => (
              <option key={k} value={k}>
                {t(`staff.roster.kind.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("staff.roster.date")}
          <input
            type="date"
            value={f.date}
            onChange={(e) => setF({ ...f, date: e.target.value })}
          />
        </label>
        <label>
          {t("staff.roster.start")}
          <input
            inputMode="numeric"
            value={f.start}
            onChange={(e) => setF({ ...f, start: e.target.value })}
          />
        </label>
        <label>
          {t("staff.roster.end")}
          <input
            inputMode="numeric"
            value={f.end}
            onChange={(e) => setF({ ...f, end: e.target.value })}
          />
        </label>
        <ErrorBox error={error} />
        <Btn
          className="primary"
          why={!f.memberId ? t("why.member") : null}
          onClick={() => void add()}
        >
          {t("staff.roster.add")}
        </Btn>
      </div>
    </div>
  );
}

function Leaves(): ReactNode {
  const [list, setList] = useState<Leave[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setList((await api<{ leaves: Leave[] }>("/api/staff/leaves?status=requested")).leaves);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const decide = async (id: string, approve: boolean): Promise<void> => {
    setError(null);
    try {
      await api(`/api/staff/leaves/${id}/decide`, {
        method: "POST",
        body: { approve, note: (notes[id] ?? "").trim() },
      });
      await load();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="card">
      <ErrorBox error={error} />
      {list.length === 0 && <p className="muted">{t("common.none")}</p>}
      {list.map((l) => (
        <div key={l.id} className="warn" data-leave={l.name}>
          <strong>{l.name}</strong> · {t(`staff.leave.kind.${l.kind}`)} · {l.startsOn} → {l.endsOn}{" "}
          {l.reason && `· ${l.reason}`}
          <div className="inline">
            <input
              aria-label={t("staff.leave.note")}
              placeholder={t("staff.leave.note")}
              value={notes[l.id] ?? ""}
              onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })}
            />
            <Btn
              className="primary"
              why={(notes[l.id] ?? "").trim().length < 3 ? t("why.reason", { n: 3 }) : null}
              onClick={() => void decide(l.id, true)}
            >
              {t("staff.leave.approve")}
            </Btn>
            <Btn
              why={(notes[l.id] ?? "").trim().length < 3 ? t("why.reason", { n: 3 }) : null}
              onClick={() => void decide(l.id, false)}
            >
              {t("staff.leave.reject")}
            </Btn>
          </div>
        </div>
      ))}
    </div>
  );
}

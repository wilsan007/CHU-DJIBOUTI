import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ErrorBox, Notice, confirmAction, Btn } from "../ui.tsx";

const ROLES = [
  "reception",
  "cashier",
  "doctor",
  "nurse",
  "lab",
  "biologist",
  "imaging",
  "pharmacy",
  "storekeeper",
  "hr",
  "direction",
  "admin",
] as const;

interface User {
  id: string;
  username: string;
  roles: string[];
  status: string;
  lastSeen: string;
  disabledReason: string | null;
}

/** Administration des comptes : désactivation immédiate (tous modules), création et changement de rôle par Keycloak. */
export function Admin(): ReactNode {
  const [users, setUsers] = useState<User[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ username: "", email: "", role: "nurse", password: "" });
  const [q, setQ] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      setUsers((await api<{ users: User[] }>("/api/admin/users")).users);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (fn: () => Promise<string | undefined>): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      setNotice((await fn()) ?? "");
      await load();
    } catch (e) {
      setError(e);
    }
  };
  const shown = users.filter((u) => u.username.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <section>
      <h1>{t("admin.title")}</h1>
      <ErrorBox error={error} />
      <Notice>{notice}</Notice>
      <div className="cols">
        <div className="card">
          <h2>{t("admin.users")}</h2>
          <input
            aria-label={t("common.search")}
            placeholder={t("common.search")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="list">
            {shown.map((u) => (
              <li key={u.id} className="card" data-user={u.username} data-status={u.status}>
                <strong>{u.username}</strong> {u.roles.map((r) => t(`role.${r}`)).join(", ")}{" "}
                <span className={u.status === "active" ? "flag ok" : "flag critical"}>
                  {t(`admin.status.${u.status}`)}
                </span>
                <div className="inline">
                  {u.status === "active" ? (
                    <>
                      <input
                        aria-label={t("admin.reason")}
                        placeholder={t("admin.reason")}
                        value={reasons[u.id] ?? ""}
                        onChange={(e) => setReasons({ ...reasons, [u.id]: e.target.value })}
                      />
                      <Btn
                        why={
                          (reasons[u.id] ?? "").trim().length < 3 ? t("why.reason", { n: 3 }) : null
                        }
                        onClick={() =>
                          void run(async () => {
                            if (!confirmAction(t("confirm.disableAccount"))) return undefined;
                            await api(`/api/admin/users/${u.id}/disable`, {
                              method: "POST",
                              body: { reason: reasons[u.id]?.trim() },
                            });
                            return t("admin.disabled.done");
                          })
                        }
                      >
                        {t("admin.disable")}
                      </Btn>
                    </>
                  ) : (
                    <button
                      onClick={() =>
                        void run(async () => {
                          await api(`/api/admin/users/${u.id}/enable`, {
                            method: "POST",
                            body: {},
                          });
                          return t("admin.enabled.done");
                        })
                      }
                    >
                      {t("admin.enable")}
                    </button>
                  )}
                </div>
                <div className="inline">
                  <select
                    aria-label={t("admin.new.role")}
                    value={roles[u.id] ?? u.roles[0] ?? ""}
                    onChange={(e) => setRoles({ ...roles, [u.id]: e.target.value })}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {t(`role.${r}`)}
                      </option>
                    ))}
                  </select>
                  <button
                    onClick={() =>
                      void run(async () => {
                        await api(`/api/admin/users/${u.id}/role`, {
                          method: "PUT",
                          body: { role: roles[u.id] ?? u.roles[0] },
                        });
                        return t("admin.role.done");
                      })
                    }
                  >
                    {t("admin.role.change")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <div className="card form">
          <h2>{t("admin.new")}</h2>
          <label>
            {t("admin.new.username")}
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
          </label>
          <label>
            {t("admin.new.email")}
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </label>
          <label>
            {t("admin.new.role")}
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`role.${r}`)}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("admin.new.password")}
            <input
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </label>
          <Btn
            className="primary"
            why={
              form.username.trim().length < 3 ||
              !form.email.includes("@") ||
              form.password.length < 12
                ? t("why.fields")
                : null
            }
            onClick={() =>
              void run(async () => {
                await api("/api/admin/users", {
                  method: "POST",
                  body: {
                    username: form.username.trim(),
                    email: form.email.trim(),
                    role: form.role,
                    temporaryPassword: form.password,
                  },
                });
                setForm({ ...form, username: "", email: "", password: "" });
                return t("admin.new.created", { username: form.username.trim() });
              })
            }
          >
            {t("admin.new.create")}
          </Btn>
        </div>
      </div>
    </section>
  );
}

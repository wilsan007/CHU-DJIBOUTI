import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { t } from "../i18n.ts";
import { ErrorBox, fdj, Notice, confirmAction } from "../ui.tsx";

interface Invoice {
  id: string;
  number: string;
  orderNumber: string | null;
  patientAmount: number;
  amountDue: number;
  discount: { amount: number; percent: number | null } | null;
  patient?: { name: string; identifier: string };
}

export function Cashier(): ReactNode {
  const [session, setSession] = useState<{ id: string } | null | undefined>(undefined);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [paid, setPaid] = useState<Invoice[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, i, p] = await Promise.all([
        api<{ session: { id: string } | null }>("/api/billing/cash-sessions/current"),
        api<{ invoices: Invoice[] }>("/api/billing/invoices?status=pending"),
        api<{ invoices: Invoice[] }>("/api/billing/invoices?status=paid&newest=true&limit=20"),
      ]);
      setSession(s.session);
      setInvoices(i.invoices);
      setPaid(p.invoices);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, [load]);

  const needle = filter.trim().toLowerCase();
  const shown = invoices.filter(
    (i) =>
      !needle ||
      `${i.number} ${i.patient?.name ?? ""} ${i.patient?.identifier ?? ""} ${i.orderNumber ?? ""}`
        .toLowerCase()
        .includes(needle),
  );

  const open = async (): Promise<void> => {
    setError(null);
    try {
      await api("/api/billing/cash-sessions/open", { method: "POST" });
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <section>
      <h1>{t("cashier.title")}</h1>
      <ErrorBox error={error} />
      <Notice>{notice}</Notice>
      {session === null && (
        <div className="notice" data-no-session>
          <p>{t("cashier.needSession")}</p>
          <button className="primary" onClick={() => void open()}>
            {t("cashier.openSession")}
          </button>
        </div>
      )}
      {session && <p className="muted">{t("cashier.sessionOpen")}</p>}
      {session && (
        <CloseSession
          sessionId={session.id}
          onClosed={(m) => {
            setNotice(m);
            void load();
          }}
        />
      )}
      <div className="inline" data-cashier-bar>
        <input
          type="search"
          aria-label={t("cashier.filter")}
          placeholder={t("cashier.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <p className="muted">
          {t("cashier.count", {
            n: shown.length,
            total: fdj(shown.reduce((a, i) => a + i.amountDue, 0)),
          })}
        </p>
      </div>
      {invoices.length === 0 && <p className="muted empty">{t("cashier.empty")}</p>}
      <div className="grid">
        {shown.map((inv) => (
          <InvoiceCard
            key={inv.id}
            invoice={inv}
            canPay={!!session}
            onChanged={load}
            onPaid={(r) => {
              setNotice(t("cashier.paid", { receipt: r }));
              void load();
            }}
          />
        ))}
      </div>
      <details className="card" data-credit-section>
        <summary>{t("cashier.credit.title")}</summary>
        <p className="muted">{t("cashier.credit.hint")}</p>
        {paid.length === 0 && <p className="muted">{t("common.none")}</p>}
        <ul className="plain">
          {paid.map((inv) => (
            <PaidRow
              key={inv.id}
              invoice={inv}
              onCredited={(n) => {
                setNotice(t("cashier.credit.done", { number: n }));
                void load();
              }}
            />
          ))}
        </ul>
      </details>
    </section>
  );
}

function CloseSession({
  sessionId,
  onClosed,
}: {
  sessionId: string;
  onClosed: (message: string) => void;
}): ReactNode {
  const [counted, setCounted] = useState("");
  const [error, setError] = useState<unknown>(null);
  const close = async (): Promise<void> => {
    if (!confirmAction(t("confirm.closeCash", { counted }))) return;
    setError(null);
    try {
      const r = await api<{ expectedCash: number; countedCash: number; difference: number }>(
        `/api/billing/cash-sessions/${sessionId}/close`,
        { method: "POST", body: { countedCash: Number(counted) } },
      );
      onClosed(
        t("cashier.close.done", {
          expected: r.expectedCash,
          counted: r.countedCash,
          difference: r.difference,
        }),
      );
    } catch (e) {
      setError(e);
    }
  };
  return (
    <details data-close-session>
      <summary>{t("cashier.close.title")}</summary>
      <div className="inline">
        <input
          aria-label={t("cashier.close.counted")}
          placeholder={t("cashier.close.counted")}
          inputMode="numeric"
          value={counted}
          onChange={(e) => setCounted(e.target.value.replace(/\D/g, ""))}
        />
        <button className="primary" disabled={counted === ""} onClick={() => void close()}>
          {t("cashier.close.go")}
        </button>
      </div>
      <ErrorBox error={error} />
    </details>
  );
}

function PaidRow({
  invoice,
  onCredited,
}: {
  invoice: Invoice;
  onCredited: (creditNumber: string) => void;
}): ReactNode {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<unknown>(null);
  const credit = async (): Promise<void> => {
    if (!confirmAction(t("confirm.credit", { number: invoice.number }))) return;
    setError(null);
    try {
      const r = await api<{ creditNote: { number: string } }>(
        `/api/billing/invoices/${invoice.id}/credit-note`,
        { method: "POST", body: { reason } },
      );
      onCredited(r.creditNote.number);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <li data-paid-invoice={invoice.number}>
      <strong>{invoice.number}</strong> {invoice.patient?.name} · {fdj(invoice.patientAmount)}
      <div className="inline">
        <input
          aria-label={t("cashier.credit.reason")}
          placeholder={t("cashier.credit.reason")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <button disabled={reason.trim().length < 5} onClick={() => void credit()}>
          {t("cashier.credit.go")}
        </button>
      </div>
      <ErrorBox error={error} />
    </li>
  );
}

function InvoiceCard({
  invoice,
  canPay,
  onChanged,
  onPaid,
}: {
  invoice: Invoice;
  canPay: boolean;
  onChanged: () => Promise<void>;
  onPaid: (receipt: string) => void;
}): ReactNode {
  const [percent, setPercent] = useState("");
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState("cash");
  const [error, setError] = useState<unknown>(null);

  const discount = async (): Promise<void> => {
    setError(null);
    try {
      await api(`/api/billing/invoices/${invoice.id}/discount`, {
        method: "POST",
        body: { percent: Number(percent), reason },
      });
      setPercent("");
      await onChanged();
    } catch (e) {
      setError(e);
    }
  };
  const pay = async (): Promise<void> => {
    setError(null);
    try {
      const r = await api<{ payment: { receiptNumber: string } }>(
        `/api/billing/invoices/${invoice.id}/pay`,
        {
          method: "POST",
          body: {
            method: invoice.amountDue === 0 ? "exempt" : method,
            ...(method === "cash" ? { receivedAmount: invoice.amountDue } : {}),
          },
        },
      );
      onPaid(r.payment.receiptNumber);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <article className="card" data-invoice={invoice.number}>
      <h2>
        {t("cashier.invoice")} {invoice.number}
      </h2>
      {invoice.orderNumber && (
        <p className="muted">{t("cashier.order", { number: invoice.orderNumber })}</p>
      )}
      <p>
        {t("cashier.patient")} : <strong>{invoice.patient?.name}</strong>{" "}
        <span className="muted">{invoice.patient?.identifier}</span>
      </p>
      <p className="amount">
        {t("cashier.due")} : <strong>{fdj(invoice.amountDue)}</strong>
        {invoice.discount && (
          <span className="muted">
            {" "}
            ({t("cashier.discount")} {fdj(invoice.discount.amount)})
          </span>
        )}
      </p>
      <details className="discount">
        <summary>{t("cashier.discount")}</summary>
        <div className="inline">
          <input
            aria-label={t("cashier.discountPercent")}
            placeholder={t("cashier.discountPercent")}
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
          />
          <input
            aria-label={t("common.reason")}
            placeholder={t("common.reason")}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <button onClick={() => void discount()} disabled={!percent || reason.trim().length < 3}>
            {t("cashier.apply")}
          </button>
        </div>
      </details>
      <div className="inline">
        <select
          aria-label={t("cashier.method")}
          value={method}
          onChange={(e) => setMethod(e.target.value)}
        >
          <option value="cash">{t("cashier.method.cash")}</option>
          <option value="mobile">{t("cashier.method.mobile")}</option>
          <option value="card">{t("cashier.method.card")}</option>
        </select>
        <button
          className="primary"
          disabled={!canPay}
          title={canPay ? undefined : t("cashier.needSession")}
          onClick={() => void pay()}
        >
          {t("cashier.pay")} {fdj(invoice.amountDue)}
        </button>
      </div>
      <ErrorBox error={error} />
    </article>
  );
}

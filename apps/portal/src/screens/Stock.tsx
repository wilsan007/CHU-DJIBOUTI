import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "../api.ts";
import { label, t } from "../i18n.ts";
import { ErrorBox, Notice, ScrollTable } from "../ui.tsx";

export interface Item {
  code: string;
  labelFr: string;
  labelAr: string | null;
  kind: string;
  unit: string;
}
interface Depot {
  code: string;
  name: string;
  kind: string;
}
interface Lot {
  lotId: string;
  itemCode: string;
  labelFr: string;
  labelAr: string | null;
  kind: string;
  unit: string;
  lotNumber: string;
  expiresOn: string;
  depot: string;
  quantity: number;
  status: "expired" | "expiring" | "ok";
}
interface Alerts {
  belowThreshold: {
    itemCode: string;
    labelFr: string;
    labelAr: string | null;
    total: number;
    minimum: number;
  }[];
  expiry: {
    lotId: string;
    itemCode: string;
    lotNumber: string;
    expiresOn: string;
    status: string;
    depot: string;
  }[];
}
interface Act {
  code: string;
  labelFr: string;
  labelAr: string;
}
interface RecipeLine {
  itemCode: string;
  labelFr: string;
  unit: string;
  quantity: number;
}
interface Shortfall {
  id: number;
  actCode: string | null;
  itemCode: string;
  labelFr: string;
  depot: string;
  missing: number;
  refId: string | null;
}

type Tab = "levels" | "receive" | "transfer" | "recipes" | "shortfalls" | "items";

/** Recherche d'article avec liste de choix : partagée par les formulaires du stock. */
export function ItemPicker({
  onPick,
  kinds,
}: {
  onPick: (item: Item) => void;
  kinds?: string[];
}): ReactNode {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Item[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const timer = setTimeout(() => {
      api<{ items: Item[] }>(`/api/stock/items?q=${encodeURIComponent(q.trim())}`)
        .then((r) => setHits(kinds ? r.items.filter((i) => kinds.includes(i.kind)) : r.items))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [q, kinds]);
  return (
    <div>
      <input
        aria-label={t("stock.item.search")}
        placeholder={t("stock.item.search")}
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <ul className="list">
        {hits.map((i) => (
          <li key={i.code}>
            <button
              className="row"
              data-item={i.code}
              onClick={() => {
                onPick(i);
                setQ("");
              }}
            >
              <strong>{i.code}</strong> {label(i.labelFr, i.labelAr)}{" "}
              <span className="muted">
                {t(`stock.kind.${i.kind}`)} · {i.unit}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Stock({ me }: { me: Me }): ReactNode {
  const [tab, setTab] = useState<Tab>("levels");
  const tabs: Tab[] = [
    "levels",
    "receive",
    "transfer",
    ...(me.permissions.includes("stock:recipes") ? (["recipes"] as Tab[]) : []),
    "shortfalls",
    "items",
  ];
  return (
    <section>
      <h1>{t("stock.title")}</h1>
      <nav aria-label="stocks" className="subtabs">
        {tabs.map((x) => (
          <button
            key={x}
            className={tab === x ? "tab active" : "tab"}
            onClick={() => setTab(x)}
            data-tab={x}
          >
            {t(`stock.tab.${x}`)}
          </button>
        ))}
      </nav>
      {tab === "levels" && <Levels />}
      {tab === "receive" && <Receive />}
      {tab === "transfer" && <Transfer />}
      {tab === "recipes" && <Recipes />}
      {tab === "shortfalls" && <Shortfalls />}
      {tab === "items" && <Items />}
    </section>
  );
}

function useDepots(): Depot[] {
  const [depots, setDepots] = useState<Depot[]>([]);
  useEffect(() => {
    api<{ depots: Depot[] }>("/api/stock/depots")
      .then((r) => setDepots(r.depots))
      .catch(() => setDepots([]));
  }, []);
  return depots;
}

function Levels(): ReactNode {
  const depots = useDepots();
  const [depot, setDepot] = useState("");
  const [lots, setLots] = useState<Lot[]>([]);
  const [alerts, setAlerts] = useState<Alerts | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [threshold, setThreshold] = useState<{ item: Item | null; minimum: string }>({
    item: null,
    minimum: "",
  });
  const [notice, setNotice] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, a] = await Promise.all([
        api<{ lots: Lot[] }>(`/api/stock/levels${depot ? `?depot=${depot}` : ""}`),
        api<Alerts>("/api/stock/alerts"),
      ]);
      setLots(s.lots);
      setAlerts(a);
    } catch (e) {
      setError(e);
    }
  }, [depot]);
  useEffect(() => {
    void load();
  }, [load]);

  const setMin = async (): Promise<void> => {
    if (!threshold.item) return;
    setError(null);
    try {
      await api(`/api/stock/thresholds/${encodeURIComponent(threshold.item.code)}`, {
        method: "PUT",
        body: { minimum: Number(threshold.minimum) },
      });
      setNotice(`${threshold.item.code} : ${threshold.minimum}`);
      setThreshold({ item: null, minimum: "" });
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="cols">
      <div className="card">
        <h2>{t("stock.alerts")}</h2>
        <ErrorBox error={error} />
        <Notice>{notice}</Notice>
        {alerts?.belowThreshold.map((b) => (
          <p key={b.itemCode} className="warn" data-below={b.itemCode}>
            {t("stock.belowThreshold", {
              item: label(b.labelFr, b.labelAr),
              total: b.total,
              minimum: b.minimum,
            })}
          </p>
        ))}
        {alerts?.expiry.map((e) => (
          <p key={`${e.lotId}-${e.depot}`} className={e.status === "expired" ? "error" : "warn"}>
            {e.itemCode} · {t("stock.lot")} {e.lotNumber} · {t(`stock.expiry.${e.status}`)} (
            {e.expiresOn})
          </p>
        ))}
        {alerts && alerts.belowThreshold.length === 0 && alerts.expiry.length === 0 && (
          <p className="muted">{t("common.none")}</p>
        )}
        <h3>{t("stock.threshold")}</h3>
        {threshold.item ? (
          <p>
            <strong>{threshold.item.code}</strong>
          </p>
        ) : (
          <ItemPicker onPick={(item) => setThreshold({ ...threshold, item })} />
        )}
        <div className="inline">
          <input
            aria-label={t("stock.threshold")}
            inputMode="numeric"
            value={threshold.minimum}
            onChange={(e) => setThreshold({ ...threshold, minimum: e.target.value })}
          />
          <button
            disabled={!threshold.item || !threshold.minimum.trim()}
            onClick={() => void setMin()}
          >
            {t("stock.threshold.set")}
          </button>
        </div>
      </div>
      <div className="card">
        <label>
          {t("stock.depot")}
          <select
            value={depot}
            onChange={(e) => setDepot(e.target.value)}
            aria-label={t("stock.depot")}
          >
            <option value="">{t("stock.allDepots")}</option>
            {depots.map((d) => (
              <option key={d.code} value={d.code}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <ScrollTable>
          <table className="table">
            <thead>
              <tr>
                <th>{t("stock.item")}</th>
                <th>{t("stock.lot")}</th>
                <th>{t("stock.expires")}</th>
                <th>{t("stock.quantity")}</th>
              </tr>
            </thead>
            <tbody>
              {lots.map((l) => (
                <tr key={`${l.lotId}-${l.depot}`} data-lot={l.lotNumber} data-depot={l.depot}>
                  <td>
                    {label(l.labelFr, l.labelAr)}{" "}
                    <span className="muted">{t(`stock.kind.${l.kind}`)}</span>
                  </td>
                  <td>
                    {l.lotNumber} ({l.depot})
                  </td>
                  <td>
                    {l.expiresOn}{" "}
                    <span
                      className={
                        l.status === "ok"
                          ? "flag ok"
                          : l.status === "expiring"
                            ? "flag abnormal"
                            : "flag critical"
                      }
                    >
                      {t(`stock.expiry.${l.status}`)}
                    </span>
                  </td>
                  <td>
                    {l.quantity} {l.unit}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      </div>
    </div>
  );
}

function Receive(): ReactNode {
  const depots = useDepots();
  const [depot, setDepot] = useState("");
  const [item, setItem] = useState<Item | null>(null);
  const [lot, setLot] = useState("");
  const [expires, setExpires] = useState("");
  const [qty, setQty] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!depot && depots[0]) setDepot(depots[0].code);
  }, [depots, depot]);

  const submit = async (): Promise<void> => {
    if (!item) return;
    setError(null);
    setNotice("");
    try {
      await api("/api/stock/receipts", {
        method: "POST",
        body: {
          depot,
          lines: [
            {
              itemCode: item.code,
              lotNumber: lot.trim(),
              expiresOn: expires,
              quantity: Number(qty),
            },
          ],
        },
      });
      setNotice(t("stock.received", { item: item.code, lot: lot.trim() }));
      setItem(null);
      setLot("");
      setQty("");
    } catch (e) {
      setError(e);
    }
  };

  return (
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
          <button className="ghost" aria-label={t("common.remove")} onClick={() => setItem(null)}>
            ×
          </button>
        </p>
      ) : (
        <ItemPicker onPick={setItem} />
      )}
      <label>
        {t("stock.lotNumber")}
        <input value={lot} onChange={(e) => setLot(e.target.value)} />
      </label>
      <label>
        {t("stock.expires")}
        <input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
      </label>
      <label>
        {t("stock.quantity")}
        <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <button
        className="primary"
        disabled={!item || !lot.trim() || !expires || !qty.trim()}
        onClick={() => void submit()}
      >
        {t("stock.receive")}
      </button>
    </div>
  );
}

function Transfer(): ReactNode {
  const depots = useDepots();
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [lots, setLots] = useState<Lot[]>([]);
  const [lotId, setLotId] = useState("");
  const [qty, setQty] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (!from && depots[0]) setFrom(depots[0].code);
    if (!to && depots[1]) setTo(depots[1].code);
  }, [depots, from, to]);
  const loadLots = useCallback(async () => {
    if (!from) return;
    try {
      const r = await api<{ lots: Lot[] }>(`/api/stock/levels?depot=${from}`);
      setLots(r.lots.filter((l) => l.status !== "expired"));
      setLotId("");
    } catch (e) {
      setError(e);
    }
  }, [from]);
  useEffect(() => {
    void loadLots();
  }, [loadLots]);

  const go = async (): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      const r = await api<{ number: string }>("/api/stock/transfers", {
        method: "POST",
        body: { from, to, lines: [{ lotId, quantity: Number(qty) }] },
      });
      setNotice(t("stock.transferred", { number: r.number }));
      setQty("");
      await loadLots();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="card form">
      <Notice>{notice}</Notice>
      <label>
        {t("stock.transfer.from")}
        <select
          aria-label={t("stock.transfer.from")}
          value={from}
          onChange={(e) => setFrom(e.target.value)}
        >
          {depots.map((d) => (
            <option key={d.code} value={d.code}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("stock.transfer.to")}
        <select
          aria-label={t("stock.transfer.to")}
          value={to}
          onChange={(e) => setTo(e.target.value)}
        >
          {depots.map((d) => (
            <option key={d.code} value={d.code}>
              {d.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("stock.lot")}
        <select
          aria-label={t("stock.lot")}
          value={lotId}
          onChange={(e) => setLotId(e.target.value)}
        >
          <option value="" />
          {lots.map((l) => (
            <option key={l.lotId} value={l.lotId}>
              {l.itemCode} · {l.lotNumber} · {l.quantity} {l.unit} · {l.expiresOn}
            </option>
          ))}
        </select>
      </label>
      <label>
        {t("stock.quantity")}
        <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <button
        className="primary"
        disabled={!lotId || !qty.trim() || !from || !to}
        onClick={() => void go()}
      >
        {t("stock.transfer.go")}
      </button>
    </div>
  );
}

function Recipes(): ReactNode {
  const [acts, setActs] = useState<Act[]>([]);
  const [act, setAct] = useState("");
  const [lines, setLines] = useState<RecipeLine[]>([]);
  const [responsible, setResponsible] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    api<Act[]>("/api/catalog/acts")
      .then((a) => {
        setActs(a);
        setAct((cur) => cur || a[0]?.code || "");
      })
      .catch(setError);
  }, []);
  useEffect(() => {
    if (!act) return;
    api<{ recipes: (RecipeLine & { responsible: string })[] }>(
      `/api/stock/recipes?act=${encodeURIComponent(act)}`,
    )
      .then((r) => {
        setLines(r.recipes);
        setResponsible(r.recipes[0]?.responsible ?? "");
      })
      .catch(setError);
  }, [act]);

  const save = async (): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      await api(`/api/stock/recipes/${encodeURIComponent(act)}`, {
        method: "PUT",
        body: {
          items: lines.map((l) => ({ itemCode: l.itemCode, quantity: l.quantity })),
          responsible: responsible.trim(),
          updatedOn: new Date().toISOString().slice(0, 10),
        },
      });
      setNotice(t("stock.recipes.saved", { act }));
    } catch (e) {
      setError(e);
    }
  };

  return (
    <div className="card form">
      <p className="muted">{t("stock.recipes.hint")}</p>
      <Notice>{notice}</Notice>
      <label>
        {t("stock.recipes.act")}
        <select
          aria-label={t("stock.recipes.act")}
          value={act}
          onChange={(e) => setAct(e.target.value)}
        >
          {acts.map((a) => (
            <option key={a.code} value={a.code}>
              {a.code} · {label(a.labelFr, a.labelAr)}
            </option>
          ))}
        </select>
      </label>
      <ScrollTable>
        <table className="table" data-recipe={act}>
          <tbody>
            {lines.map((l, i) => (
              <tr key={l.itemCode} data-line={l.itemCode}>
                <td>
                  {l.itemCode} {l.labelFr}
                </td>
                <td>
                  <input
                    aria-label={`${t("stock.quantity")} ${l.itemCode}`}
                    inputMode="numeric"
                    value={l.quantity}
                    onChange={(e) =>
                      setLines(
                        lines.map((x, j) =>
                          j === i ? { ...x, quantity: Number(e.target.value) || 0 } : x,
                        ),
                      )
                    }
                  />
                </td>
                <td>
                  <button
                    className="ghost"
                    aria-label={t("common.remove")}
                    onClick={() => setLines(lines.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollTable>
      <h2>{t("stock.recipes.add")}</h2>
      <ItemPicker
        onPick={(i) =>
          !lines.some((l) => l.itemCode === i.code) &&
          setLines([...lines, { itemCode: i.code, labelFr: i.labelFr, unit: i.unit, quantity: 1 }])
        }
      />
      <label>
        {t("stock.recipes.responsible")}
        <input value={responsible} onChange={(e) => setResponsible(e.target.value)} />
      </label>
      <ErrorBox error={error} />
      <button
        className="primary"
        disabled={!act || !responsible.trim() || lines.some((l) => l.quantity < 1)}
        onClick={() => void save()}
      >
        {t("stock.recipes.save")}
      </button>
    </div>
  );
}

function Shortfalls(): ReactNode {
  const [list, setList] = useState<Shortfall[]>([]);
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [error, setError] = useState<unknown>(null);
  const load = useCallback(async () => {
    try {
      setList((await api<{ shortfalls: Shortfall[] }>("/api/stock/shortfalls")).shortfalls);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const resolve = async (id: number): Promise<void> => {
    setError(null);
    try {
      await api(`/api/stock/shortfalls/${id}/resolve`, {
        method: "POST",
        body: { resolution: (reasons[id] ?? "").trim() },
      });
      await load();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="card">
      <p className="muted">{t("stock.shortfalls.hint")}</p>
      <ErrorBox error={error} />
      {list.length === 0 && <p className="muted">{t("common.none")}</p>}
      {list.map((s) => (
        <div key={s.id} className="warn" data-shortfall={s.itemCode}>
          <strong>{s.itemCode}</strong> {s.labelFr} ·{" "}
          {t("stock.shortfalls.missing", { missing: s.missing })} · {s.depot} · {s.actCode}{" "}
          {s.refId}
          <div className="inline">
            <input
              aria-label={t("stock.shortfalls.resolution")}
              placeholder={t("stock.shortfalls.resolution")}
              value={reasons[s.id] ?? ""}
              onChange={(e) => setReasons({ ...reasons, [s.id]: e.target.value })}
            />
            <button
              disabled={(reasons[s.id] ?? "").trim().length < 5}
              onClick={() => void resolve(s.id)}
            >
              {t("stock.shortfalls.resolve")}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Items(): ReactNode {
  const [items, setItems] = useState<Item[]>([]);
  const [csv, setCsv] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    try {
      setItems((await api<{ items: Item[] }>("/api/stock/items")).items);
    } catch (e) {
      setError(e);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const run = async (): Promise<void> => {
    setError(null);
    setNotice("");
    try {
      const r = await api<{ imported: number; rejected: unknown[] }>("/api/stock/items/import", {
        method: "POST",
        csv,
      });
      setNotice(t("stock.items.imported", { count: r.imported, rejected: r.rejected.length }));
      setCsv("");
      await load();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="cols">
      <div className="card form">
        <label>
          {t("stock.items.import")}
          <textarea
            rows={6}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder="code,libelle_fr,libelle_ar,famille,unite,responsable,date_maj"
          />
        </label>
        <ErrorBox error={error} />
        <Notice>{notice}</Notice>
        <button className="primary" disabled={!csv.trim()} onClick={() => void run()}>
          {t("stock.items.import.go")}
        </button>
      </div>
      <div className="card">
        <ScrollTable>
          <table className="table">
            <tbody>
              {items.map((i) => (
                <tr key={i.code}>
                  <td>{i.code}</td>
                  <td>{label(i.labelFr, i.labelAr)}</td>
                  <td>{t(`stock.kind.${i.kind}`)}</td>
                  <td>{i.unit}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ScrollTable>
      </div>
    </div>
  );
}

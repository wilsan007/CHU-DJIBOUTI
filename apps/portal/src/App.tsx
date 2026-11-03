import { useEffect, useState, type ReactNode } from "react";
import { api, type Me } from "./api.ts";
import { manager } from "./auth.ts";
import { setLang, t, useLang } from "./i18n.ts";
import { Cashier } from "./screens/Cashier.tsx";
import { Doctor } from "./screens/Doctor.tsx";
import { Admin } from "./screens/Admin.tsx";
import { Direction } from "./screens/Direction.tsx";
import { Hospitalization } from "./screens/Hospitalization.tsx";
import { Imaging } from "./screens/Imaging.tsx";
import { Lab } from "./screens/Lab.tsx";
import { MySpace } from "./screens/MySpace.tsx";
import { Staff } from "./screens/Staff.tsx";
import { Material } from "./screens/Material.tsx";
import { Stock } from "./screens/Stock.tsx";
import { Pharmacy } from "./screens/Pharmacy.tsx";
import { Reception } from "./screens/Reception.tsx";
import { ErrorBox } from "./ui.tsx";

interface Screen {
  id: string;
  label: string;
  permission: string;
  render: (me: Me) => ReactNode;
  /** Masque l'écran pour certains profils (ex. le matériel utilisé n'est pas pour qui gère le stock). */
  visible?: (me: Me) => boolean;
}

const SCREENS: Screen[] = [
  {
    id: "reception",
    label: "nav.reception",
    permission: "billing:admit",
    render: () => <Reception />,
  },
  { id: "cashier", label: "nav.cashier", permission: "billing:pay", render: () => <Cashier /> },
  { id: "doctor", label: "nav.doctor", permission: "clinical:write", render: () => <Doctor /> },
  { id: "lab", label: "nav.lab", permission: "lab:write", render: (me) => <Lab me={me} /> },
  {
    id: "pharmacy",
    label: "nav.pharmacy",
    permission: "pharmacy:dispense",
    render: () => <Pharmacy />,
  },
  {
    id: "stock",
    label: "nav.stock",
    permission: "stock:manage",
    render: (me) => <Stock me={me} />,
  },
  {
    id: "material",
    label: "nav.material",
    permission: "stock:consume",
    render: () => <Material />,
    visible: (me) => !me.permissions.includes("stock:manage"),
  },
  {
    id: "staff",
    label: "nav.staff",
    permission: "staff:manage",
    render: (me) => <Staff me={me} />,
  },
  { id: "mySpace", label: "nav.mySpace", permission: "staff:directory", render: () => <MySpace /> },
  {
    id: "hosp",
    label: "nav.hosp",
    permission: "stay:read",
    render: (me) => <Hospitalization me={me} />,
  },
  { id: "imaging", label: "nav.imaging", permission: "imaging:write", render: () => <Imaging /> },
  {
    id: "direction",
    label: "nav.direction",
    permission: "dashboard:read",
    render: () => <Direction />,
  },
  { id: "admin", label: "nav.admin", permission: "admin:manage", render: () => <Admin /> },
];

export function App(): ReactNode {
  const lang = useLang();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [current, setCurrent] = useState<string | null>(null);

  useEffect(() => {
    api<Me>("/api/me").then(setMe).catch(setError);
  }, []);

  const allowed = me
    ? SCREENS.filter((s) => me.permissions.includes(s.permission) && (s.visible?.(me) ?? true))
    : [];
  const screen = allowed.find((s) => s.id === current) ?? allowed[0];

  return (
    <div className="shell" data-lang={lang}>
      <EnvBanner />
      <header className="bar">
        <strong className="brand">{t("app.name")}</strong>
        <nav aria-label="principal">
          {allowed.map((s) => (
            <button
              key={s.id}
              className={s.id === screen?.id ? "tab active" : "tab"}
              onClick={() => setCurrent(s.id)}
            >
              {t(s.label)}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        {me && <span className="who">{t("common.signedInAs", { name: me.name })}</span>}
        <button className="ghost" onClick={() => setLang(lang === "fr" ? "ar" : "fr")}>
          {t("nav.language")}
        </button>
        <button className="ghost" onClick={() => void manager.signoutRedirect()}>
          {t("nav.logout")}
        </button>
      </header>
      <main>
        <ErrorBox error={error} />
        {me && !screen && <p>{t("common.noAccess")}</p>}
        {me && screen?.render(me)}
      </main>
    </div>
  );
}

/** Bandeau d'environnement (ex. « FORMATION : données fictives ») : défini à la construction par VITE_ENV_BANNER ; absent en production. */
export function EnvBanner(): ReactNode {
  const text = import.meta.env.VITE_ENV_BANNER as string | undefined;
  return text ? (
    <div className="env-banner" role="note" data-env-banner>
      {text}
    </div>
  ) : null;
}

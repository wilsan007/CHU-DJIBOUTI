import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { ApiError, getPending, subscribePending } from "./api.ts";
import { t } from "./i18n.ts";

/** Fait défiler jusqu'au message quand il apparaît (l'agent est peut-être en bas d'une longue page). */
function useRevealOnMount<T extends HTMLElement>(): React.RefObject<T | null> {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
  }, []);
  return ref;
}

export function ErrorBox({ error }: { error: unknown }): ReactNode {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : t("error.generic");
  return <ErrorLine message={message} />;
}

function ErrorLine({ message }: { message: string }): ReactNode {
  const ref = useRevealOnMount<HTMLParagraphElement>();
  return (
    <p ref={ref} role="alert" className="error">
      {message}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }): ReactNode {
  return children ? <NoticeLine>{children}</NoticeLine> : null;
}

function NoticeLine({ children }: { children: ReactNode }): ReactNode {
  const ref = useRevealOnMount<HTMLParagraphElement>();
  return (
    <p ref={ref} role="status" className="notice">
      {children}
    </p>
  );
}

export const fdj = (n: number): string => `${n.toLocaleString("fr-FR")} FDJ`;

/** Confirmation avant une action grave ou difficile à défaire (boîte du navigateur : claire, accessible, au clavier). */
export const confirmAction = (message: string): boolean => window.confirm(message);

/** Fine barre en haut de l'écran pendant qu'une action ou un chargement dure (plus de 300 ms : pas de clignotement). */
export function ProgressBar(): ReactNode {
  const pending = useSyncExternalStore(subscribePending, getPending);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (pending === 0) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), 300);
    return () => clearTimeout(timer);
  }, [pending]);
  return shown ? (
    <div className="progress" role="progressbar" aria-label={t("common.loading")} />
  ) : null;
}

/** Tableau qui défile horizontalement sur petit écran : la zone reçoit le focus clavier et porte un nom (lecteurs d'écran). */
export function ScrollTable({ children }: { children: ReactNode }): ReactNode {
  return (
    <div className="scroll" tabIndex={0} role="region" aria-label={t("common.table")}>
      {children}
    </div>
  );
}

/**
 * Bouton qui dit POURQUOI il est inactif : tant que `why` est renseigné, le bouton est désactivé et la raison s'affiche juste
 * dessous (et dans l'info-bulle), reliée au bouton pour les lecteurs d'écran. Plus de bouton grisé et muet.
 */
export function Btn({
  why,
  children,
  ...rest
}: { why?: string | null } & Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "disabled"
>): ReactNode {
  const id = useId();
  return (
    <>
      <button
        {...rest}
        disabled={Boolean(why)}
        title={why ?? rest.title}
        aria-describedby={why ? id : undefined}
      >
        {children}
      </button>
      {why ? (
        <small id={id} className="why">
          {why}
        </small>
      ) : null}
    </>
  );
}

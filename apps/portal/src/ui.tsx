import type { ReactNode } from "react";
import { ApiError } from "./api.ts";
import { t } from "./i18n.ts";

export function ErrorBox({ error }: { error: unknown }): ReactNode {
  if (!error) return null;
  const message = error instanceof ApiError ? error.message : t("error.generic");
  return (
    <p role="alert" className="error">
      {message}
    </p>
  );
}

export function Notice({ children }: { children: ReactNode }): ReactNode {
  return children ? (
    <p role="status" className="notice">
      {children}
    </p>
  ) : null;
}

export const fdj = (n: number): string => `${n.toLocaleString("fr-FR")} FDJ`;

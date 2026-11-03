import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ensureSignedIn } from "./auth.ts";
import { PatientApp } from "./patient/PatientApp.tsx";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);
if (window.location.pathname.startsWith("/patient")) {
  // Espace patient : pas de Keycloak, connexion par code envoyé par SMS.
  root.render(
    <StrictMode>
      <PatientApp />
    </StrictMode>,
  );
} else {
  ensureSignedIn()
    .then((user) => {
      if (user)
        root.render(
          <StrictMode>
            <App />
          </StrictMode>,
        );
    })
    .catch((error: unknown) => {
      console.error(error);
      root.render(<p role="alert">Connexion impossible. / تعذر تسجيل الدخول.</p>);
    });
}

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ensureSignedIn } from "./auth.ts";
import "./styles.css";

const root = createRoot(document.getElementById("root") as HTMLElement);
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

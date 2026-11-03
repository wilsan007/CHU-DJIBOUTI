import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Le portail et l'API partagent l'origine (comme avec Nginx) : /api est relayé vers le noyau applicatif.
export default defineConfig({
  plugins: [react()],
  server: {
    // Autorise l'accès par un nom d'hôte public (GitHub Codespaces, serveur de recette).
    allowedHosts: true,
    proxy: {
      "/api": { target: process.env.API_URL ?? "http://localhost:3100", changeOrigin: false },
      // Keycloak sous /auth de la même origine (mode PUBLIC_URL de tools/dev-stack/stack.sh).
      "/auth": {
        target: process.env.KC_URL ?? "http://localhost:8081",
        changeOrigin: false,
        xfwd: true,
      },
    },
    fs: { allow: ["../.."] },
  },
});

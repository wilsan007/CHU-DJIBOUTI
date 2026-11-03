import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Le portail et l'API partagent l'origine (comme avec Nginx) : /api est relayé vers le noyau applicatif.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: process.env.API_URL ?? "http://localhost:3100", changeOrigin: false },
    },
    fs: { allow: ["../.."] },
  },
});

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/node_modules/**", "**/out/**", "**/dist/**", "pnpm-lock.yaml"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Règle du plan (section 2) : pas de texte d'interface en dur, pas de console oubliée.
      "no-console": ["error", { allow: ["error", "warn"] }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Test de bout en bout du portail : script Node qui pilote un navigateur.
    files: ["apps/portal/e2e/**/*.mjs"],
    languageOptions: {
      globals: {
        process: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        console: "readonly",
        localStorage: "readonly",
        document: "readonly",
      },
    },
    rules: { "no-console": "off" },
  },
  {
    // Les outils en ligne de commande et les tests ont le droit d'écrire sur la sortie standard.
    files: ["tools/**/src/cli.ts", "services/**/src/*-cli.ts", "**/test/**/*.ts"],
    rules: { "no-console": "off" },
  },
);

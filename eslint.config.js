import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/", "*.config.*"],
    languageOptions: {
      globals: {
        AbortSignal: "readonly",
        Buffer: "readonly",
        fetch: "readonly",
        process: "readonly",
        structuredClone: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
      },
    },
  },
);

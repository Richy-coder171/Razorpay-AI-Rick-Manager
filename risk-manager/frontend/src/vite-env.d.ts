/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_DEMO_API_KEY?: string;
  /** Absolute base URL of a hosted backend, e.g. https://risk-manager-api.onrender.com (defaults to the dev proxy /api). */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

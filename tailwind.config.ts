import type { Config } from "tailwindcss";

/**
 * Padrão visual Azuos — extraído de dashboard-azuos.html
 * (github.com/thyagosouzaoficial/asaas-dashboard, 07/08/2026).
 * Ver docs/PADRAO_VISUAL.md. Não inventar cor fora desta paleta.
 */
const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        azuos: {
          dark: "#102a60",
          DEFAULT: "#183a83",
          primary: "#183a83",
          accent: "#183a83",
          light: "#e8f0fe",
          gold: "#f0e915",
        },
        surface: {
          bg: "#f0f2f5",
          main: "#f8fafc",
          card: "#ffffff",
          border: "#e2e8f0",
          sidebar: "#0f172a",
          "sidebar-border": "#1e293b",
        },
        content: {
          DEFAULT: "#1e293b",
          muted: "#64748b",
        },
        estado: {
          success: "#10b981",
          warning: "#f59e0b",
          danger: "#ef4444",
          info: "#06b6d4",
        },
      },
      fontFamily: {
        sans: ["Inter", "-apple-system", "Segoe UI", "Arial", "sans-serif"],
        mono: ["SF Mono", "Menlo", "ui-monospace", "monospace"],
      },
      fontSize: {
        // A interface é densa, de planilha. O corpo é 12px, não 16px.
        base: ["0.75rem", { lineHeight: "1.5" }],
      },
      boxShadow: {
        card: "0 1px 3px rgba(0,0,0,.08)",
      },
      borderRadius: {
        card: "10px",
      },
    },
  },
  plugins: [],
};

export default config;

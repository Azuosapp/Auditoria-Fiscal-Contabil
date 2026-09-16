import type { Config } from "tailwindcss";

/**
 * Padrão visual Azuos — extraído de azuos-brand (Azuosapp) e trilha-azuos
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
          darkest: "#0a1a4a",
          dark: "#0f2460",
          DEFAULT: "#1b3a8c",
          primary: "#1b3a8c",
          accent: "#1b3a8c",
          light: "#e1e6f5",
          "blue-light": "#2b5ce6",
          gold: "#f5c518",
          yellow: "#f5c518",
        },
        surface: {
          bg: "#f0f4ff",
          main: "#f0f4ff",
          card: "#ffffff",
          border: "#e2e8f0",
          sidebar: "#0a1a4a",
          "sidebar-border": "#1b3a8c",
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
        sans: ["Inter", "system-ui", "-apple-system", "Segoe UI", "Arial", "sans-serif"],
        mono: ["JetBrains Mono", "SF Mono", "Menlo", "ui-monospace", "monospace"],
      },
      fontSize: {
        // A interface é densa, de planilha. O corpo é 12px, não 16px.
        base: ["0.75rem", { lineHeight: "1.5" }],
      },
      boxShadow: {
        card: "0 2px 12px rgba(27,58,140,.08)",
      },
      borderRadius: {
        card: "16px",
      },
    },
  },
  plugins: [],
};

export default config;

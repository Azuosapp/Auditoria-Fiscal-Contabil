/** Formatação pt-BR. Toda exibição de dinheiro do sistema passa por aqui. */

const MOEDA = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
});

const NUMERO = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Aceita Decimal do Prisma, string ou number — sempre via string, para não perder precisão. */
export function moeda(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const n = Number(String(v));
  return Number.isFinite(n) ? MOEDA.format(n) : "—";
}

export function numero(v: unknown): string {
  if (v === null || v === undefined) return "—";
  const n = Number(String(v));
  return Number.isFinite(n) ? NUMERO.format(n) : "—";
}

/** "2024-03" → "03/2024" */
export function competencia(c: string | null | undefined): string {
  if (!c) return "—";
  const [ano, mes] = c.split("-");
  return mes ? `${mes}/${ano}` : c;
}

export function cnpj(v: string | null | undefined): string {
  if (!v) return "—";
  const d = v.replace(/\D/g, "");
  if (d.length !== 14) return v;
  return `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`;
}

import { Prisma } from "@prisma/client";

/**
 * Aritmética monetária e tributária do sistema.
 *
 * Regra inegociável: dinheiro e tributo NUNCA transitam como `number`.
 * O tipo `number` do JavaScript é ponto flutuante IEEE 754 — 0.1 + 0.2 não é 0.3.
 * Em apuração fiscal isso vira centavo errado, e centavo errado vira autuação.
 *
 * `Prisma.Decimal` é o decimal.js que já vem com o Prisma Client: sem dependência
 * nova, e é exatamente o tipo que as colunas `Decimal` do schema esperam.
 */
export type Money = Prisma.Decimal;

export const ZERO = new Prisma.Decimal(0);

/**
 * Converte valor bruto (string do XML, string do SPED, Decimal do banco) em Decimal.
 *
 * Aceita vírgula como separador decimal. Devolve `undefined` para ausente/vazio/inválido,
 * nunca zero — ausência de informação não é o mesmo que valor zero, e confundir os dois
 * falseia totalizador.
 *
 * Recebe `string` sempre que possível: converter a partir de `number` já implica que
 * a precisão foi perdida antes de chegar aqui.
 */
export function dec(v: unknown): Money | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const raw = typeof v === "string" ? v.trim().replace(",", ".") : String(v);
  if (raw === "") return undefined;
  try {
    const d = new Prisma.Decimal(raw);
    return d.isFinite() ? d : undefined;
  } catch {
    return undefined;
  }
}

/** Soma tratando ausência como neutro. Devolve Decimal sempre. */
export function sum(...values: Array<Money | undefined>): Money {
  return values.reduce<Money>((acc, v) => (v ? acc.add(v) : acc), ZERO);
}

/**
 * Arredonda para centavos (2 casas) com HALF_UP — o critério da legislação
 * tributária brasileira e o que o contribuinte espera ver no documento fiscal.
 */
export function toCents(v: Money): Money {
  return v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Percentual sobre base: `base × pct / 100`, sem arredondamento intermediário.
 * O arredondamento é decisão de quem apura, e acontece uma vez, no fim.
 */
export function pctOf(base: Money, pct: Money | number | string): Money {
  const p = pct instanceof Prisma.Decimal ? pct : new Prisma.Decimal(String(pct));
  return base.mul(p).div(100);
}

/** Carga efetiva em pontos percentuais: `tributo / receita × 100`. */
export function effectiveLoadPct(tax: Money, revenue: Money): Money {
  if (revenue.isZero() || revenue.isNegative()) return ZERO;
  return tax.div(revenue).mul(100);
}

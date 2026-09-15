import type { Prisma } from "@prisma/client";

/**
 * Formatação usada no texto dos achados.
 *
 * Separada de `lib/formato.ts` de propósito: aquela é de exibição e converte
 * para `number` via `Intl`. Aqui o valor vai para dentro do texto do relatório
 * que o cliente lê, e passar por ponto flutuante — ainda que só para formatar —
 * é exatamente o hábito que produz o centavo errado. O Decimal é formatado a
 * partir da sua própria representação decimal, sem conversão.
 */

export function moeda(v: Prisma.Decimal): string {
  const [inteiro, decimais] = v.toFixed(2).split(".");
  const negativo = inteiro.startsWith("-");
  const digitos = negativo ? inteiro.slice(1) : inteiro;
  const comMilhar = digitos.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negativo ? "-" : ""}R$ ${comMilhar},${decimais}`;
}

/** "2024-03" → "03/2024" */
export function mesAno(competencia: string): string {
  const [ano, mes] = competencia.split("-");
  return `${mes}/${ano}`;
}

export function percentual(v: Prisma.Decimal): string {
  return `${v.toFixed(1).replace(".", ",")}%`;
}

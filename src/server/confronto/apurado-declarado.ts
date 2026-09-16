import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Confronto entre o tributo federal que a empresa apurou nas escriturações e o
 * que confessou à Receita em DCTF (ou DCTFWeb/MIT).
 *
 *   IRPJ e CSLL    ECF (N630/N670 no Real, P300/P500 no Presumido) — a pagar
 *   PIS e COFINS   EFD-Contribuições (M200/M600) — total a recolher
 *   IPI            EFD ICMS/IPI (E520) — saldo devedor
 *
 * ICMS fica de fora: é estadual e não passa pela DCTF nem pela situação fiscal
 * federal.
 *
 * O confronto usa a última versão de cada lado — ECF, EFD e DCTF retificadoras
 * substituem as anteriores. Só entra exercício em que existe alguma DCTF: sem
 * nenhuma, a ausência é falta de documento, não de declaração.
 */

export type TributoFederal = "IRPJ" | "CSLL" | "PIS" | "COFINS" | "IPI";

export type SituacaoConfronto =
  | "CONFERE"
  | "DECLARADO_A_MENOR"
  | "DECLARADO_A_MAIOR"
  | "NAO_DECLARADO"
  | "SEM_ESCRITURACAO";

export interface LinhaConfronto {
  tributo: TributoFederal;
  competencia: string;
  /** "1º trimestre de 2025" ou "03/2025". */
  periodo: string;
  /** Lucro/base de cálculo, quando a fonte informa (IRPJ e CSLL). */
  base?: Prisma.Decimal;
  apurado: Prisma.Decimal;
  fonteApurado: string;
  declarado: Prisma.Decimal;
  /** declarado − apurado: negativo é imposto não declarado. */
  diferenca: Prisma.Decimal;
  situacao: SituacaoConfronto;
}

export interface ResumoConfronto {
  linhas: LinhaConfronto[];
  /** Soma do que deixou de ser declarado (apurado acima do declarado). */
  naoDeclarado: Prisma.Decimal;
  /** Soma do declarado acima do apurado — pagamento a maior, se recolhido. */
  declaradoAMaior: Prisma.Decimal;
  periodosConferidos: number;
  periodosDivergentes: number;
  temDctf: boolean;
}

const ZERO = new Prisma.Decimal(0);
const TOLERANCIA = new Prisma.Decimal("1.00");

export const FONTE: Record<TributoFederal, string> = {
  IRPJ: "ECF",
  CSLL: "ECF",
  PIS: "EFD-Contribuições",
  COFINS: "EFD-Contribuições",
  IPI: "EFD ICMS/IPI",
};

export function rotuloPeriodo(competencia: string, trimestral: boolean): string {
  const [ano, mes] = competencia.split("-").map(Number);
  if (trimestral && mes % 3 === 0) return `${mes / 3}º trimestre de ${ano}`;
  return `${String(mes).padStart(2, "0")}/${ano}`;
}

export async function confrontoApuradoDeclarado(auditoriaId: string): Promise<ResumoConfronto> {
  const [ecf, contrib, ipi, confissoes] = await Promise.all([
    prisma.apuracaoEcf.findMany({
      where: { documento: { auditoriaId } },
      include: { documento: { select: { createdAt: true } } },
      orderBy: { documento: { createdAt: "asc" } },
    }),
    prisma.apuracaoContribuicoes.findMany({
      where: { documento: { auditoriaId } },
      include: { documento: { select: { createdAt: true } } },
      orderBy: { documento: { createdAt: "asc" } },
    }),
    prisma.apuracaoIpi.findMany({
      where: { documento: { auditoriaId } },
      include: { documento: { select: { id: true, createdAt: true } } },
      orderBy: { documento: { createdAt: "asc" } },
    }),
    prisma.confissao.findMany({
      where: { documento: { auditoriaId }, tributo: { in: ["IRPJ", "CSLL", "PIS", "COFINS", "IPI"] } },
      orderBy: { dataDeclaracao: "asc" },
    }),
  ]);

  // Apurado — a última versão de cada período vence.
  const apurado = new Map<string, { valor: Prisma.Decimal; base?: Prisma.Decimal; trimestral: boolean }>();
  for (const e of ecf) {
    apurado.set(`${e.tributo}|${e.periodo}`, { valor: e.aPagar, base: e.baseCalculo, trimestral: true });
  }
  for (const c of contrib) {
    const retencoes = c.retencoes ?? ZERO;
    apurado.set(`${c.contribuicao}|${c.competencia}`, {
      valor: c.aRecolher,
      // Guardado para aceitar a DCTF que confessa antes de descontar retenções.
      base: retencoes.isZero() ? undefined : c.aRecolher.plus(retencoes),
      trimestral: false,
    });
  }
  // IPI: um arquivo pode ter mais de um período de apuração no mês; soma por
  // documento e fica com o documento mais recente.
  const ipiPorDoc = new Map<string, Map<string, Prisma.Decimal>>();
  for (const a of ipi) {
    const m = ipiPorDoc.get(a.competencia) ?? new Map<string, Prisma.Decimal>();
    m.set(a.documento.id, (m.get(a.documento.id) ?? ZERO).plus(a.aRecolher));
    ipiPorDoc.set(a.competencia, m);
  }
  for (const [competencia, docs] of ipiPorDoc) {
    const ultimo = [...docs.values()].pop()!;
    apurado.set(`IPI|${competencia}`, { valor: ultimo, trimestral: false });
  }

  // Declarado — última declaração por (competência, código de receita).
  const ultima = new Map<string, (typeof confissoes)[number]>();
  for (const c of confissoes) ultima.set(`${c.competencia}|${c.codigoReceita ?? c.tributo}`, c);
  const declarado = new Map<string, Prisma.Decimal>();
  for (const c of ultima.values()) {
    const k = `${c.tributo}|${c.competencia}`;
    declarado.set(k, (declarado.get(k) ?? ZERO).plus(c.valorDebito));
  }

  const anosComDctf = new Set(confissoes.map((c) => c.competencia.slice(0, 4)));
  const anosComFonte = new Map<string, Set<string>>();
  for (const k of apurado.keys()) {
    const [tributo, competencia] = k.split("|");
    const fonte = FONTE[tributo as TributoFederal];
    const s = anosComFonte.get(fonte) ?? new Set<string>();
    s.add(competencia.slice(0, 4));
    anosComFonte.set(fonte, s);
  }

  const linhas: LinhaConfronto[] = [];
  const chaves = new Set([...apurado.keys(), ...declarado.keys()]);
  for (const k of chaves) {
    const [t, competencia] = k.split("|");
    const tributo = t as TributoFederal;
    const ano = competencia.slice(0, 4);
    if (!anosComDctf.has(ano)) continue;
    const a = apurado.get(k);
    const d = declarado.get(k) ?? ZERO;
    const trimestral = tributo === "IRPJ" || tributo === "CSLL";

    if (!a) {
      // Declarado sem escrituração do período: só conta se a escrituração
      // daquele tributo existe no ano (senão é arquivo que não veio).
      if (d.isZero() || !anosComFonte.get(FONTE[tributo])?.has(ano)) continue;
      linhas.push({
        tributo, competencia, periodo: rotuloPeriodo(competencia, trimestral),
        apurado: ZERO, fonteApurado: FONTE[tributo], declarado: d, diferenca: d, situacao: "SEM_ESCRITURACAO",
      });
      continue;
    }
    if (a.valor.isZero() && d.isZero()) continue;

    let diferenca = d.minus(a.valor);
    // PIS/COFINS: DCTF que confessa o valor antes das retenções também confere.
    if (!trimestral && a.base && d.minus(a.base).abs().lessThanOrEqualTo(TOLERANCIA)) diferenca = ZERO;

    const situacao: SituacaoConfronto =
      diferenca.abs().lessThanOrEqualTo(TOLERANCIA)
        ? "CONFERE"
        : d.isZero()
          ? "NAO_DECLARADO"
          : diferenca.isNegative()
            ? "DECLARADO_A_MENOR"
            : "DECLARADO_A_MAIOR";
    linhas.push({
      tributo, competencia, periodo: rotuloPeriodo(competencia, trimestral),
      base: trimestral ? a.base : undefined,
      apurado: a.valor, fonteApurado: FONTE[tributo], declarado: d,
      diferenca: situacao === "CONFERE" ? ZERO : diferenca, situacao,
    });
  }

  const ordemTributo: TributoFederal[] = ["IRPJ", "CSLL", "PIS", "COFINS", "IPI"];
  linhas.sort((x, y) =>
    ordemTributo.indexOf(x.tributo) - ordemTributo.indexOf(y.tributo) || x.competencia.localeCompare(y.competencia),
  );

  let naoDeclarado = ZERO;
  let declaradoAMaior = ZERO;
  for (const l of linhas) {
    if (l.situacao === "DECLARADO_A_MENOR" || l.situacao === "NAO_DECLARADO") naoDeclarado = naoDeclarado.plus(l.diferenca.abs());
    if (l.situacao === "DECLARADO_A_MAIOR" || l.situacao === "SEM_ESCRITURACAO") declaradoAMaior = declaradoAMaior.plus(l.diferenca);
  }

  return {
    linhas,
    naoDeclarado,
    declaradoAMaior,
    periodosConferidos: linhas.length,
    periodosDivergentes: linhas.filter((l) => l.situacao !== "CONFERE").length,
    temDctf: anosComDctf.size > 0,
  };
}

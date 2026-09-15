import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família C — crédito indevido e crédito perdido.
 *
 * É onde mora a oportunidade: o que o cliente pagou a mais e pode recuperar. Mas
 * é também a família mais fácil de errar, porque crédito depende do regime: no
 * Simples e no Lucro Presumido cumulativo não há crédito de PIS/COFINS a tomar,
 * e acusar "crédito indevido" nesses regimes seria constrangedor.
 */

const ZERO = new Prisma.Decimal(0);

/**
 * CST de PIS/COFINS na ENTRADA que NÃO geram direito a crédito.
 *
 * 04 monofásico, 05 substituição tributária, 06 alíquota zero, 07 isenta,
 * 08 sem incidência, 09 suspensão. Comprar item assim e tomar crédito é glosa
 * certa em fiscalização.
 */
const CST_SEM_CREDITO = new Set(["04", "05", "06", "07", "08", "09"]);

export const familiaC: Regra = {
  codigos: ["C01"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    return c01CreditoSobreItemSemDireito(ctx);
  },
};

/**
 * C01 — entradas sem direito a crédito enquanto a empresa apropria crédito.
 *
 * O achado NÃO afirma que o crédito daquele item específico foi tomado — isso
 * exigiria o bloco C/M da EFD-Contribuições item a item. O que ele afirma é
 * mensurável e verdadeiro: a empresa apropriou crédito na competência E comprou
 * itens que não geram crédito algum, no valor X. É um alerta quantificado para
 * conferência, não uma acusação fechada — e sai com confiança MÉDIA, dizendo
 * isso.
 *
 * Só roda no Lucro Real: é o único regime em que há crédito de PIS/COFINS a
 * tomar. No Simples e no Presumido cumulativo o achado não faria sentido.
 */
async function c01CreditoSobreItemSemDireito(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (!ctx.fontesDisponiveis.has("SPED_CONTRIBUICOES")) return [];

  const temEntradas =
    ctx.fontesDisponiveis.has("NFE_XML") || ctx.fontesDisponiveis.has("SPED_FISCAL");
  if (!temEntradas) return [];

  // Competências com crédito efetivamente apropriado. Sem crédito apropriado,
  // comprar item monofásico é apenas uma compra — não há achado.
  const comCredito = await prisma.apuracaoContribuicoes.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      creditos: { gt: 0 },
    },
    select: { competencia: true, creditos: true, contribuicao: true },
  });
  if (comCredito.length === 0) return [];

  const creditoPorCompetencia = new Map<string, Prisma.Decimal>();
  for (const c of comCredito) {
    const atual = creditoPorCompetencia.get(c.competencia) ?? ZERO;
    creditoPorCompetencia.set(c.competencia, atual.plus(c.creditos ?? ZERO));
  }

  const itensEntrada = await prisma.notaFiscalItem.findMany({
    where: {
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        direcao: "ENTRADA",
        situacao: "AUTORIZADA",
        competencia: { in: [...creditoPorCompetencia.keys()] },
      },
      OR: [
        { cstPis: { in: [...CST_SEM_CREDITO] } },
        { cstCofins: { in: [...CST_SEM_CREDITO] } },
      ],
    },
    select: {
      cstPis: true,
      cstCofins: true,
      valorItem: true,
      descricao: true,
      nota: { select: { numero: true, competencia: true } },
    },
  });

  const porCompetencia = new Map<
    string,
    { quantidade: number; soma: Prisma.Decimal; exemplos: string[] }
  >();

  for (const item of itensEntrada) {
    const c = item.nota.competencia;
    const atual = porCompetencia.get(c) ?? {
      quantidade: 0,
      soma: ZERO,
      exemplos: [],
    };
    atual.quantidade += 1;
    atual.soma = atual.soma.plus(item.valorItem);
    if (atual.exemplos.length < 5) {
      atual.exemplos.push(
        `nota ${item.nota.numero}: ${item.descricao ?? "item"} — ` +
          `CST PIS ${item.cstPis ?? "-"} / COFINS ${item.cstCofins ?? "-"}, ` +
          `${moeda(item.valorItem)}`,
      );
    }
    porCompetencia.set(c, atual);
  }

  return [...porCompetencia.entries()]
    .filter(([, d]) => d.quantidade > 0)
    .map(([competencia, d]) => {
      const creditoApropriado = creditoPorCompetencia.get(competencia) ?? ZERO;
      return {
        codigo: "C01",
        competencia,
        confianca: "MEDIA" as const,
        descricao:
          `${d.quantidade} item(ns) de entrada com CST que não gera crédito ` +
          `(monofásico, ST, alíquota zero, isento ou suspenso), somando ` +
          `${moeda(d.soma)}, em competência com ${moeda(creditoApropriado)} de ` +
          `crédito apropriado.`,
        textoCliente:
          `Em ${mesAno(competencia)} a empresa apropriou ${moeda(creditoApropriado)} ` +
          `de crédito de PIS/COFINS e, no mesmo período, comprou ${moeda(d.soma)} ` +
          `em produtos que não geram crédito algum. Crédito tomado sobre esses ` +
          `itens é glosado em fiscalização.`,
        recomendacao:
          "Conferir, no bloco de créditos da EFD-Contribuições, se esses itens " +
          "entraram na base de crédito. Havendo apropriação indevida, retificar e " +
          "recolher a diferença com denúncia espontânea.",
        valorExposicao: d.soma,
        declarado: true,
        ressalva:
          "O achado compara compras sem direito a crédito com crédito apropriado " +
          "na mesma competência. Confirmar item a item no bloco de créditos da " +
          "EFD-Contribuições antes de tratar como crédito indevido — o valor " +
          "apontado é o das compras, não o do crédito glosável.",
        evidencias: d.exemplos.map((e) => ({
          arquivo: `Documentos de entrada de ${mesAno(competencia)}`,
          campo: "CST de PIS/COFINS",
          observacao: e,
        })),
      };
    });
}

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família E — ICMS operacional.
 *
 * O que os XMLs sustentam sozinhos: coerência entre CFOP, CST e destino. O DIFAL
 * e a substituição tributária exigem o confronto com a arrecadação e com a tabela
 * de MVA por NCM, que ainda não estão no sistema — viram lacuna.
 */

const ZERO = new Prisma.Decimal(0);

export const familiaE: Regra = {
  codigos: ["E05"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    return e05CoerenciaCfopCst(ctx);
  },
};

/**
 * E05 — CFOP incompatível com o destino da operação.
 *
 * O primeiro dígito do CFOP diz a abrangência: 1/2/3 são entradas (estadual,
 * interestadual, exterior) e 5/6/7 são saídas na mesma ordem. Uma venda com CFOP
 * 5xxx (interno) para destinatário de outra UF está errada — ou o CFOP, ou o
 * cadastro do destinatário.
 *
 * Erra a alíquota, erra a apuração e erra o DIFAL: por isso é achado, não
 * detalhe cadastral.
 */
async function e05CoerenciaCfopCst(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  const ufEmpresa = ctx.empresaUf;
  if (!ufEmpresa) return [];

  const itens = await prisma.notaFiscalItem.findMany({
    where: {
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "XML_AUTORIZADO",
        direcao: "SAIDA",
        situacao: "AUTORIZADA",
        ufDestino: { not: null },
      },
      cfop: { not: null },
    },
    select: {
      cfop: true,
      valorItem: true,
      nota: {
        select: { numero: true, competencia: true, ufDestino: true },
      },
    },
  });

  const porCompetencia = new Map<
    string,
    { quantidade: number; soma: Prisma.Decimal; exemplos: typeof itens }
  >();

  for (const item of itens) {
    const cfop = item.cfop!;
    const ufDestino = item.nota.ufDestino!;
    const abrangencia = cfop[0];

    const interestadual = ufDestino !== ufEmpresa;
    // Saída interna (5xxx) para outra UF, ou interestadual (6xxx) dentro do
    // próprio estado. O exterior (7xxx) tem regra própria e fica de fora.
    const incoerente =
      (abrangencia === "5" && interestadual) ||
      (abrangencia === "6" && !interestadual);

    if (!incoerente) continue;

    const c = item.nota.competencia;
    const atual = porCompetencia.get(c) ?? {
      quantidade: 0,
      soma: ZERO,
      exemplos: [] as typeof itens,
    };
    atual.quantidade += 1;
    atual.soma = atual.soma.plus(item.valorItem);
    if (atual.exemplos.length < 10) atual.exemplos.push(item);
    porCompetencia.set(c, atual);
  }

  return [...porCompetencia.entries()].map(([competencia, d]) => ({
    codigo: "E05",
    competencia,
    severidade: "MEDIO" as const,
    descricao:
      `${d.quantidade} item(ns) com CFOP incompatível com a UF de destino, ` +
      `somando ${moeda(d.soma)}.`,
    textoCliente:
      `Em ${mesAno(competencia)} há ${d.quantidade} itens emitidos com CFOP ` +
      `incompatível com o destino da operação. O CFOP errado leva à alíquota ` +
      `errada e compromete a apuração do ICMS e do diferencial de alíquota.`,
    recomendacao:
      "Corrigir o cadastro de operações e de destinatários no emissor e avaliar " +
      "a necessidade de retificar a escrituração das competências afetadas.",
    valorExposicao: d.soma,
    declarado: true,
    ressalva:
      "A UF de destino considerada é a do endereço do destinatário no XML. " +
      "Operações com entrega em endereço diverso do destinatário podem ser " +
      "legítimas e precisam ser conferidas individualmente.",
    evidencias: d.exemplos.map((item) => ({
      tipo: "EXEMPLO" as const,
      arquivo: `XML de ${mesAno(competencia)}`,
      documentoNumero: item.nota.numero,
      campo: "CFOP × UF do destinatário",
      valor: `CFOP ${item.cfop} · destino ${item.nota.ufDestino} · ${moeda(item.valorItem)}`,
      observacao:
        item.cfop?.[0] === "5"
          ? `CFOP de operação interna, mas o destinatário está em ${item.nota.ufDestino} e a empresa em ${ufEmpresa}`
          : `CFOP interestadual, mas o destinatário está na mesma UF da empresa (${ufEmpresa})`,
    })),
  }));
}

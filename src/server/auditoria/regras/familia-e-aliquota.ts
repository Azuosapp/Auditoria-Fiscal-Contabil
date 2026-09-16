import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";
import { aliquotaInterestadual } from "./familia-e-documento";

/**
 * Família E — alíquota abaixo da devida e crédito do ICMS retido.
 *
 * Regras vindas do Agente Tributário Azuos (RCTE-GO e Anexo VIII):
 *
 *   E18 — saída interna em Goiás a 17% depois de 01/04/2024 (alíquota modal 19%)
 *   E19 — saída interestadual abaixo da alíquota interestadual
 *   E22 — crédito de ICMS em entrada de mercadoria com imposto retido
 */

const ZERO = new Prisma.Decimal(0);
const CENTAVO = new Prisma.Decimal("0.01");
const DEZESSETE = new Prisma.Decimal(17);
const DEZENOVE = new Prisma.Decimal(19);
/** Decreto nº 10.485/2024: 19% a partir desta data. */
const INICIO_19 = new Date(Date.UTC(2024, 3, 1));

/** CST de ICMS sem a origem: "000" (EFD) e "00" (XML) viram "00". */
function cst(v: string | null | undefined): string {
  return (v ?? "").slice(-2);
}

function dataBr(d: Date): string {
  return d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

function pct(v: Prisma.Decimal): string {
  return `${v.toFixed(2).replace(".", ",").replace(/,00$/, "")}%`;
}

function porCompetencia<T extends { competencia: string }>(lista: T[]): Map<string, T[]> {
  const mapa = new Map<string, T[]>();
  for (const x of lista) mapa.set(x.competencia, [...(mapa.get(x.competencia) ?? []), x]);
  return mapa;
}

export const familiaEAliquota: Regra = {
  codigos: ["E18", "E19", "E22"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    const achados: AchadoProduzido[] = [];
    if (ctx.fontesDisponiveis.has("NFE_XML") && ctx.empresaUf) {
      const saidas = await saidasProprias(ctx);
      if (ctx.empresaUf === "GO") achados.push(...e18DezessetePorCento(saidas));
      achados.push(...e19AbaixoDaInterestadual(ctx, saidas));
    }
    if (ctx.fontesDisponiveis.has("SPED_FISCAL")) {
      achados.push(...(await e22CreditoIcmsRetido(ctx)));
    }
    return achados;
  },
};

async function saidasProprias(ctx: ContextoRegra) {
  return prisma.notaFiscal.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      origem: "XML_AUTORIZADO",
      situacao: "AUTORIZADA",
      direcao: "SAIDA",
      cnpjEmitente: ctx.empresaCnpj,
    },
    include: {
      itens: { orderBy: { numeroItem: "asc" } },
      documento: { select: { nomeArquivo: true } },
    },
    orderBy: { dataEmissao: "asc" },
  });
}
type Saida = Awaited<ReturnType<typeof saidasProprias>>[number];

/**
 * E18 — 17% em saída interna de Goiás depois de 01/04/2024.
 *
 * A alíquota modal passou a 19% (RCTE, art. 20, I). Item com CST 00 —
 * tributação integral, sem redução de base — a 17% é imposto destacado a
 * menor. Benefício que leva a carga a 17% se destaca com redução de base (CST
 * 20), não com a alíquota; combustível tem alíquota própria e fica de fora.
 */
function e18DezessetePorCento(saidas: Saida[]): AchadoProduzido[] {
  const casos = saidas.flatMap((nota) => {
    if (nota.dataEmissao < INICIO_19) return [];
    if (nota.ufDestino && nota.ufDestino !== "GO") return [];
    return nota.itens
      .filter(
        (i) =>
          (i.cfop ?? "").startsWith("5") &&
          cst(i.cstIcms) === "00" &&
          i.aliqIcms?.equals(DEZESSETE) &&
          i.baseIcms?.greaterThan(0) &&
          !(i.ncm ?? "").startsWith("27"),
      )
      .map((item) => ({
        nota,
        item,
        diferenca: item.baseIcms!.times(DEZENOVE.minus(DEZESSETE)).dividedBy(100).toDecimalPlaces(2),
        competencia: nota.competencia,
      }));
  });

  return [...porCompetencia(casos)].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.diferenca), ZERO);
    const notas = [...new Set(lista.map((c) => c.nota.numero))];
    return {
      codigo: "E18",
      competencia,
      confianca: "ALTA" as const,
      descricao:
        `${lista.length} item(ns) de ${notas.length} NF-e interna(s) com CST 00 a 17%, quando a ` +
        `alíquota modal de Goiás é 19% desde 01/04/2024: ${moeda(total)} de ICMS a menor.`,
      textoCliente:
        `Em ${mesAno(competencia)} as notas ${notas.join(", ")} saíram a 17%, alíquota revogada ` +
        `em 01/04/2024. O ICMS ficou ${moeda(total)} abaixo do devido.`,
      recomendacao:
        "Atualizar a alíquota interna no emissor para 19% e recolher a diferença com NF-e " +
        "complementar de ICMS ou denúncia espontânea.",
      ressalva:
        "Se o produto tiver carga de 17% por benefício (Anexo IX, art. 8º), o erro passa a ser de " +
        "forma — destacar como redução de base, CST 20 —, não de valor.",
      valorExposicao: total,
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.nota.documento.nomeArquivo,
        documentoNumero: c.nota.numero,
        chave: c.nota.chave ?? undefined,
        dataDocumento: dataBr(c.nota.dataEmissao),
        valor: moeda(c.diferenca),
        observacao:
          `item ${c.item.numeroItem} · CFOP ${c.item.cfop} · CST 00 a 17% · base ` +
          `${moeda(c.item.baseIcms!)} · NCM ${c.item.ncm ?? "—"}`,
      })),
    };
  });
}

/**
 * E19 — saída interestadual abaixo da alíquota interestadual.
 *
 * O espelho da E08: 7% saindo de Goiás (onde a interestadual é 12%) ou
 * qualquer alíquota abaixo dos 4% do importado. Só CST 00 — redução de base
 * (CST 20) ou isenção explicam carga menor.
 */
function e19AbaixoDaInterestadual(ctx: ContextoRegra, saidas: Saida[]): AchadoProduzido[] {
  const casos = saidas.flatMap((nota) => {
    if (!nota.ufDestino || nota.ufDestino === ctx.empresaUf) return [];
    return nota.itens.flatMap((item) => {
      if (!(item.cfop ?? "").startsWith("6") || cst(item.cstIcms) !== "00") return [];
      if (!item.aliqIcms || item.aliqIcms.isZero() || !item.baseIcms) return [];
      const correta = aliquotaInterestadual(ctx.empresaUf!, nota.ufDestino!, item.origemMercadoria);
      if (item.aliqIcms.greaterThanOrEqualTo(correta.minus(CENTAVO))) return [];
      const diferenca = item.baseIcms.times(correta.minus(item.aliqIcms)).dividedBy(100).toDecimalPlaces(2);
      return [{ nota, item, correta, diferenca, competencia: nota.competencia }];
    });
  });

  return [...porCompetencia(casos)].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.diferenca), ZERO);
    const notas = [...new Set(lista.map((c) => c.nota.numero))];
    return {
      codigo: "E19",
      competencia,
      confianca: "ALTA" as const,
      descricao:
        `${lista.length} item(ns) de ${notas.length} NF-e interestadual(is) com CST 00 abaixo da ` +
        `alíquota interestadual: ${moeda(total)} de ICMS a menor.`,
      textoCliente:
        `Em ${mesAno(competencia)} as notas ${notas.join(", ")} saíram para outros estados com ` +
        `alíquota menor que a interestadual. O ICMS ficou ${moeda(total)} abaixo do devido.`,
      recomendacao: "Corrigir a alíquota interestadual no emissor e recolher a diferença.",
      valorExposicao: total,
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.nota.documento.nomeArquivo,
        documentoNumero: c.nota.numero,
        chave: c.nota.chave ?? undefined,
        dataDocumento: dataBr(c.nota.dataEmissao),
        valor: moeda(c.diferenca),
        observacao:
          `item ${c.item.numeroItem} para ${c.nota.ufDestino}: ${pct(c.item.aliqIcms!)} aplicada, ` +
          `${pct(c.correta)} devida, base ${moeda(c.item.baseIcms!)}, origem ${c.item.origemMercadoria ?? "—"}`,
      })),
    };
  });
}

/**
 * E22 — crédito de ICMS em entrada com imposto retido.
 *
 * Mercadoria recebida com ICMS retido sai sem destaque (Anexo VIII, art. 56),
 * e o retido só vira crédito nas hipóteses do art. 45: saída para outra UF,
 * uso na industrialização, ativo imobilizado, entre outras. A entrada com CFOP
 * 1403/2403 — compra para comercialização com ST — e ICMS creditado no C170 é
 * crédito sem saída tributada que o suporte.
 *
 * Confiança alta só quando nenhuma hipótese do art. 45 é visível nos arquivos:
 * empresa não industrial e sem venda interestadual. Do contrário, média.
 */
async function e22CreditoIcmsRetido(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const entradas = await prisma.notaFiscalItem.findMany({
    where: {
      cfop: { in: ["1403", "2403"] },
      valorIcms: { gt: 0 },
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "ESCRITURACAO",
        direcao: "ENTRADA",
        NOT: { cnpjEmitente: ctx.empresaCnpj },
      },
    },
    include: { nota: { include: { documento: { select: { nomeArquivo: true } } } } },
    orderBy: { nota: { dataEmissao: "asc" } },
  });
  if (entradas.length === 0) return [];

  const industrial = await prisma.escrituracaoArquivo.count({
    where: { documento: { auditoriaId: ctx.auditoriaId }, indAtividade: "0" },
  });
  const interestaduais = await prisma.notaFiscalItem.count({
    where: {
      cfop: { startsWith: "6" },
      nota: { documento: { auditoriaId: ctx.auditoriaId }, cnpjEmitente: ctx.empresaCnpj, direcao: "SAIDA" },
    },
  });
  const confianca = industrial === 0 && interestaduais === 0 ? ("ALTA" as const) : ("MEDIA" as const);

  const casos = entradas.map((item) => ({ item, competencia: item.nota.competencia }));
  return [...porCompetencia(casos)].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.item.valorIcms ?? ZERO), ZERO);
    const notas = [...new Set(lista.map((c) => c.item.nota.numero))];
    return {
      codigo: "E22",
      competencia,
      confianca,
      descricao:
        `${moeda(total)} de ICMS creditado em ${lista.length} item(ns) de ${notas.length} entrada(s) ` +
        `com CFOP 1403/2403 (mercadoria com imposto retido).`,
      textoCliente:
        `Em ${mesAno(competencia)} a empresa se creditou de ${moeda(total)} de ICMS em compras com ` +
        `substituição tributária, que saem sem destaque e não geram crédito na revenda interna.`,
      recomendacao:
        "Estornar o crédito (E111), salvo se a mercadoria foi industrializada, vendida para outra " +
        "UF ou imobilizada (Anexo VIII, art. 45).",
      ressalva:
        confianca === "ALTA"
          ? undefined
          : "A empresa é industrial ou vende para outros estados: parte do crédito pode estar nas hipóteses do art. 45 do Anexo VIII.",
      valorExposicao: total,
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.item.nota.documento.nomeArquivo,
        registro: "C170",
        documentoNumero: c.item.nota.numero,
        chave: c.item.nota.chave ?? undefined,
        dataDocumento: dataBr(c.item.nota.dataEmissao),
        participante: c.item.nota.cnpjEmitente,
        valor: moeda(c.item.valorIcms ?? ZERO),
        observacao: `CFOP ${c.item.cfop} · ${c.item.descricao ?? "item"} · NCM ${c.item.ncm ?? "—"}`,
      })),
    };
  });
}

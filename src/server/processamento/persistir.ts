import { Prisma, type OrigemNota, type SituacaoNota } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  ExtractionResult,
  ParsedInvoice,
  ParsedApuracao,
} from "@/server/extraction/types";
import type { ExtractionResultSpedContribuicoes } from "@/server/extraction/sped-contribuicoes";
import type { ExtratoPgdas } from "@/server/extraction/pgdas-extrato";
import { paraCompetencia } from "@/server/extraction/identificar-empresa";

/**
 * Gravação do conteúdo extraído nas tabelas normalizadas.
 *
 * Duas regras atravessam tudo aqui:
 *
 * 1. Valor monetário chega como `Prisma.Decimal` e é gravado como Decimal. Em
 *    nenhum ponto vira `number` — nem "só para somar", nem "só para comparar".
 * 2. Ausência não é zero. Campo que o arquivo não trouxe é gravado como NULL;
 *    escrever zero mentiria no totalizador e no cruzamento.
 */

/** Total de linhas gravadas — vira `registrosExtraidos` no documento. */
export interface ContagemPersistida {
  notas: number;
  itens: number;
  apuracoesIcms: number;
  apuracoesContribuicoes: number;
  apuracoesSimples: number;
  eventos: number;
}

export function contagemVazia(): ContagemPersistida {
  return {
    notas: 0,
    itens: 0,
    apuracoesIcms: 0,
    apuracoesContribuicoes: 0,
    apuracoesSimples: 0,
    eventos: 0,
  };
}

export function somarContagens(
  a: ContagemPersistida,
  b: ContagemPersistida,
): ContagemPersistida {
  return {
    notas: a.notas + b.notas,
    itens: a.itens + b.itens,
    apuracoesIcms: a.apuracoesIcms + b.apuracoesIcms,
    apuracoesContribuicoes: a.apuracoesContribuicoes + b.apuracoesContribuicoes,
    apuracoesSimples: a.apuracoesSimples + b.apuracoesSimples,
    eventos: a.eventos + b.eventos,
  };
}

export function totalDe(c: ContagemPersistida): number {
  return (
    c.notas +
    c.apuracoesIcms +
    c.apuracoesContribuicoes +
    c.apuracoesSimples +
    c.eventos
  );
}

/**
 * Situação do documento fiscal a partir do COD_SIT do SPED (tabela 4.1.2).
 *
 * 02 e 03 são cancelamento; 04, denegação; 05, numeração inutilizada. O registro
 * é gravado assim mesmo — quem apura é que decide excluir. Descartar aqui
 * esconderia do relatório justamente a nota cancelada que continua escriturada.
 */
function situacaoDoCodigo(codigo?: string): SituacaoNota {
  switch (codigo) {
    case "02":
    case "03":
      return "CANCELADA";
    case "04":
      return "DENEGADA";
    case "05":
      return "INUTILIZADA";
    default:
      return "AUTORIZADA";
  }
}

/** Modelo do parser → código do documento fiscal gravado na coluna. */
function codigoModelo(modelo: string | undefined): string {
  switch (modelo) {
    case "NFE":
      return "55";
    case "NFCE":
      return "65";
    case "CTE":
      return "57";
    case "NFSE":
      return "SE";
    default:
      return "00";
  }
}

/**
 * Direção da nota do ponto de vista da empresa auditada.
 *
 * O XML não diz se é entrada ou saída: isso depende de a empresa ser a emitente
 * ou a destinatária. O parser chuta "SAIDA" quando não sabe; aqui, com o CNPJ da
 * empresa em mãos, o chute é corrigido. Sem isso, toda compra entraria como
 * receita.
 */
function direcaoReal(
  inv: ParsedInvoice,
  cnpjEmpresa: string | undefined,
): "ENTRADA" | "SAIDA" {
  if (!cnpjEmpresa) return inv.direction;
  const emit = inv.emitCnpj?.replace(/\D/g, "");
  const dest = inv.destDoc?.replace(/\D/g, "");
  if (emit === cnpjEmpresa) return "SAIDA";
  if (dest === cnpjEmpresa) return "ENTRADA";
  return inv.direction;
}

export async function persistirNotas(
  tx: Prisma.TransactionClient,
  documentoId: string,
  resultado: ExtractionResult,
  origem: OrigemNota,
  cnpjEmpresa: string | undefined,
): Promise<{ notas: number; itens: number }> {
  let notas = 0;
  let itens = 0;

  for (const inv of resultado.invoices) {
    const emissao = inv.issueDate ?? undefined;
    const competencia = paraCompetencia(emissao);
    // Sem data não há competência, e sem competência a nota não entra em
    // nenhum cruzamento por período. Registrar assim seria dado morto.
    if (!competencia || !emissao) continue;

    const nota = await tx.notaFiscal.create({
      data: {
        documentoId,
        chave: inv.accessKey,
        modelo: codigoModelo(inv.model),
        serie: inv.series,
        numero: inv.number ?? "",
        direcao: direcaoReal(inv, cnpjEmpresa),
        origem,
        situacao: situacaoDoCodigo(inv.situationCode),
        dataEmissao: emissao,
        competencia,
        cnpjEmitente: inv.emitCnpj ?? "",
        cnpjDestinatario: inv.destDoc,
        ufDestino: inv.destUf,
        valorTotal: inv.totalInvoice ?? new Prisma.Decimal(0),
        valorProdutos: inv.totalProducts,
        valorIcms: inv.totalIcms,
        valorIcmsSt: inv.totalIcmsSt,
        valorIpi: inv.totalIpi,
        valorPis: inv.totalPis,
        valorCofins: inv.totalCofins,
      },
    });
    notas += 1;

    if (inv.items.length > 0) {
      await tx.notaFiscalItem.createMany({
        data: inv.items.map((item) => ({
          notaId: nota.id,
          numeroItem: item.lineNumber,
          descricao: item.description,
          ncm: item.ncm,
          cfop: item.cfop,
          cstIcms: item.cstCsosn,
          cstPis: item.cstPis,
          cstCofins: item.cstCofins,
          quantidade: item.quantity,
          valorItem: item.totalValue ?? new Prisma.Decimal(0),
        })),
      });
      itens += inv.items.length;
    }
  }

  return { notas, itens };
}

export async function persistirEventos(
  tx: Prisma.TransactionClient,
  documentoId: string,
  resultado: ExtractionResult,
): Promise<number> {
  const eventos = resultado.eventos ?? [];
  if (eventos.length === 0) return 0;

  await tx.eventoNfe.createMany({
    data: eventos.map((e) => ({
      documentoId,
      chave: e.accessKey,
      tipoEvento: e.tipoEvento,
      descricao: e.descricaoEvento,
      dataEvento: e.dataEvento,
      sequencia: e.sequencia,
      autorDoc: e.autorDoc,
      protocolo: e.protocolo,
      cancelaNota: e.cancelaNota,
    })),
  });

  return eventos.length;
}

/**
 * Apuração do ICMS (Bloco E). O campo 13 do E110 — VL_ICMS_RECOLHER — é o número
 * que a família A do catálogo confronta com a arrecadação.
 */
export async function persistirApuracaoIcms(
  tx: Prisma.TransactionClient,
  documentoId: string,
  apuracoes: ParsedApuracao[],
  uf: string | undefined,
): Promise<number> {
  let gravadas = 0;

  for (const ap of apuracoes) {
    const competencia = paraCompetencia(ap.periodStart ?? ap.periodEnd);
    if (!competencia) continue;

    await tx.apuracaoFiscal.upsert({
      where: { documentoId_competencia: { documentoId, competencia } },
      create: {
        documentoId,
        competencia,
        uf,
        debitos: ap.totalDebits ?? new Prisma.Decimal(0),
        creditos: ap.totalCredits ?? new Prisma.Decimal(0),
        saldoCredorAnterior: ap.previousCreditBalance,
        deducoes: ap.totalDeductions,
        icmsARecolher: ap.icmsToPay ?? new Prisma.Decimal(0),
        saldoCredorTransportar: ap.creditBalanceToCarry,
        registroOrigem: "E110",
      },
      update: {},
    });
    gravadas += 1;
  }

  return gravadas;
}

/**
 * Apuração de PIS e COFINS (M200 e M600).
 *
 * `totalContributionToPay` (campo 13) é o valor a recolher do período — a soma
 * do não cumulativo com o cumulativo, já deduzidas retenções. É ele que entra
 * no cruzamento com o DARF, não o valor apurado bruto.
 */
export async function persistirApuracaoContribuicoes(
  tx: Prisma.TransactionClient,
  documentoId: string,
  resultado: ExtractionResultSpedContribuicoes,
): Promise<number> {
  const competencia = paraCompetencia(
    resultado.contribIdentification?.periodStart ??
      resultado.contribIdentification?.periodEnd,
  );
  if (!competencia) return 0;

  const lados = [
    { tipo: "PIS" as const, dados: resultado.pis, registro: "M200" },
    { tipo: "COFINS" as const, dados: resultado.cofins, registro: "M600" },
  ];

  let gravadas = 0;

  for (const lado of lados) {
    const c = lado.dados.consolidation;
    if (!c) continue;

    const apurado =
      c.nonCumulativeContribution ?? c.cumulativeContribution ?? undefined;

    await tx.apuracaoContribuicoes.upsert({
      where: {
        documentoId_competencia_contribuicao: {
          documentoId,
          competencia,
          contribuicao: lado.tipo,
        },
      },
      create: {
        documentoId,
        competencia,
        contribuicao: lado.tipo,
        // A base vem dos detalhes M210/M610; o consolidado não a traz.
        baseCalculo: somarBases(lado.dados.consolidation?.details),
        valorApurado: apurado ?? new Prisma.Decimal(0),
        creditos: c.creditDiscountedCurrentPeriod,
        retencoes: somarRetencoes(c.withheldNonCumulative, c.withheldCumulative),
        aRecolher: c.totalContributionToPay ?? new Prisma.Decimal(0),
        registroOrigem: lado.registro,
      },
      update: {},
    });
    gravadas += 1;
  }

  return gravadas;
}

function somarBases(
  detalhes: { baseValueAdjusted?: Prisma.Decimal; baseValue?: Prisma.Decimal }[] | undefined,
): Prisma.Decimal | undefined {
  if (!detalhes || detalhes.length === 0) return undefined;
  let total: Prisma.Decimal | undefined;
  for (const d of detalhes) {
    const v = d.baseValueAdjusted ?? d.baseValue;
    if (!v) continue;
    total = total ? total.plus(v) : v;
  }
  return total;
}

function somarRetencoes(
  a: Prisma.Decimal | undefined,
  b: Prisma.Decimal | undefined,
): Prisma.Decimal | undefined {
  if (!a && !b) return undefined;
  return (a ?? new Prisma.Decimal(0)).plus(b ?? new Prisma.Decimal(0));
}

export async function persistirPgdas(
  tx: Prisma.TransactionClient,
  documentoId: string,
  extrato: ExtratoPgdas,
): Promise<number> {
  await tx.apuracaoSimples.upsert({
    where: {
      documentoId_competencia: { documentoId, competencia: extrato.competencia },
    },
    create: {
      documentoId,
      competencia: extrato.competencia,
      rbt12: extrato.rbt12,
      receitaBruta: extrato.receitaPa,
      fatorR: extrato.fatorR,
      valorDas: extrato.dasTotal ?? new Prisma.Decimal(0),
    },
    update: {},
  });
  return 1;
}

/**
 * Reconciliação pós-processamento — o que só é possível saber com TODOS os
 * arquivos da auditoria já lidos.
 *
 * Roda fora da transação de cada documento, porque cruza documentos diferentes:
 * o evento está num arquivo, a nota em outro; o XML num pacote, o SPED em outro.
 */
export async function reconciliar(auditoriaId: string): Promise<{
  canceladas: number;
  escrituradas: number;
}> {
  const canceladas = await marcarCanceladasPorEvento(auditoriaId);
  const escrituradas = await marcarEscrituradas(auditoriaId);
  return { canceladas, escrituradas };
}

/**
 * Evento de cancelamento (110111) marca a nota como CANCELADA.
 *
 * Isso não é detalhe: nota cancelada que segue contando como receita infla o
 * faturamento — e nota cancelada que a contabilidade escriturou como válida é o
 * achado B03.
 */
async function marcarCanceladasPorEvento(auditoriaId: string): Promise<number> {
  const eventos = await prisma.eventoNfe.findMany({
    where: { documento: { auditoriaId }, cancelaNota: true },
    select: { chave: true },
  });
  if (eventos.length === 0) return 0;

  const chaves = [...new Set(eventos.map((e) => e.chave))];

  const r = await prisma.notaFiscal.updateMany({
    where: {
      documento: { auditoriaId },
      chave: { in: chaves },
      origem: "XML_AUTORIZADO",
      situacao: "AUTORIZADA",
    },
    data: { situacao: "CANCELADA" },
  });

  return r.count;
}

/**
 * Marca o XML autorizado cuja chave aparece no SPED Fiscal.
 *
 * O que sobrar por marcar é o achado B01 — nota emitida e não escriturada, que
 * para o fisco é omissão de receita.
 */
async function marcarEscrituradas(auditoriaId: string): Promise<number> {
  const escrituradas = await prisma.notaFiscal.findMany({
    where: {
      documento: { auditoriaId },
      origem: "ESCRITURACAO",
      chave: { not: null },
    },
    select: { chave: true },
  });
  if (escrituradas.length === 0) return 0;

  const chaves = [...new Set(escrituradas.map((n) => n.chave!))];

  // Lotes: uma auditoria de 5 anos pode ter dezenas de milhares de chaves, e
  // um IN desse tamanho estoura o limite de parâmetros do Postgres.
  const TAMANHO_LOTE = 5000;
  let total = 0;

  for (let i = 0; i < chaves.length; i += TAMANHO_LOTE) {
    const r = await prisma.notaFiscal.updateMany({
      where: {
        documento: { auditoriaId },
        origem: "XML_AUTORIZADO",
        chave: { in: chaves.slice(i, i + TAMANHO_LOTE) },
      },
      data: { escriturada: true },
    });
    total += r.count;
  }

  return total;
}

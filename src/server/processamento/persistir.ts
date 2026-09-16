import { Prisma, type OrigemNota, type SituacaoNota } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type {
  ExtractionResult,
  ParsedInvoice,
  ParsedApuracao,
} from "@/server/extraction/types";
import type { ExtractionResultSpedContribuicoes } from "@/server/extraction/sped-contribuicoes";
import type { ApuracaoDctf } from "@/server/extraction/dctf-mit";
import type { EcfExtraida } from "@/server/extraction/ecf";
import type { EcdExtraida } from "@/server/extraction/ecd";
import type { ExtratoPgdas } from "@/server/extraction/pgdas-extrato";
import type { SituacaoFiscalExtraida } from "@/server/extraction/situacao-fiscal";
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
  pendenciasFiscais: number;
  /** Débitos confessados em DCTF. */
  confissoes: number;
  /** ECF: IRPJ e CSLL por período. */
  apuracoesEcf: number;
  /** ECD: saldos mensais, partidas de lançamento e linhas da DRE. */
  saldosContabeis: number;
  lancamentosContabeis: number;
  linhasDre: number;
}

export function contagemVazia(): ContagemPersistida {
  return {
    notas: 0,
    itens: 0,
    apuracoesIcms: 0,
    apuracoesContribuicoes: 0,
    apuracoesSimples: 0,
    eventos: 0,
    pendenciasFiscais: 0,
    confissoes: 0,
    apuracoesEcf: 0,
    saldosContabeis: 0,
    lancamentosContabeis: 0,
    linhasDre: 0,
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
    pendenciasFiscais: a.pendenciasFiscais + b.pendenciasFiscais,
    confissoes: a.confissoes + b.confissoes,
    apuracoesEcf: a.apuracoesEcf + b.apuracoesEcf,
    saldosContabeis: a.saldosContabeis + b.saldosContabeis,
    lancamentosContabeis: a.lancamentosContabeis + b.lancamentosContabeis,
    linhasDre: a.linhasDre + b.linhasDre,
  };
}

export function totalDe(c: ContagemPersistida): number {
  return (
    c.notas +
    c.apuracoesIcms +
    c.apuracoesContribuicoes +
    c.apuracoesSimples +
    c.eventos +
    c.pendenciasFiscais +
    c.confissoes +
    c.apuracoesEcf +
    c.saldosContabeis +
    c.lancamentosContabeis +
    c.linhasDre
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
 *
 * Mas ser a emitente NÃO basta para ser saída, e isso apareceu em arquivo real:
 * na devolução de venda por cliente não contribuinte, é a própria empresa quem
 * emite a nota — de ENTRADA, com CFOP 1201/2201. Contada como saída, a devolução
 * viraria receita e inflaria o faturamento duas vezes (a venda original e a
 * volta dela). Por isso o CFOP entra na decisão.
 *
 * A ordem entre os dois critérios depende da ORIGEM, e errá-la produz falso
 * positivo:
 *
 * - Na ESCRITURAÇÃO, o campo IND_OPER do C100 é o próprio declarante dizendo se
 *   aquilo é entrada ou saída dele. É autoritativo e vem primeiro. Num caso
 *   real, duas notas de compra de GLP foram escrituradas com o CFOP do
 *   FORNECEDOR (5660, venda de combustível); decidindo pelo CFOP, viravam saída
 *   da empresa e apareciam como receita — e ainda geravam um achado de "nota
 *   sem XML" que não existia.
 *
 * - No XML não há IND_OPER: o documento é o mesmo para emitente e destinatário.
 *   Aí o CFOP decide (1/2/3 entrada, 5/6/7 saída) e, na falta dele, o CNPJ.
 */
function direcaoReal(
  inv: ParsedInvoice,
  cnpjEmpresa: string | undefined,
  origem: OrigemNota,
): "ENTRADA" | "SAIDA" {
  // O SPED já diz qual é: respeitar o que o declarante escriturou.
  if (origem === "ESCRITURACAO") return inv.direction;

  const porCfop = direcaoPeloCfop(inv);
  if (porCfop) return porCfop;

  if (!cnpjEmpresa) return inv.direction;
  const emit = inv.emitCnpj?.replace(/\D/g, "");
  const dest = inv.destDoc?.replace(/\D/g, "");
  if (emit === cnpjEmpresa) return "SAIDA";
  if (dest === cnpjEmpresa) return "ENTRADA";
  return inv.direction;
}

/**
 * Direção pelo CFOP predominante dos itens.
 *
 * Usa o CFOP da maioria dos itens em vez do primeiro: nota com itens de CFOP
 * misturado existe, e decidir pelo item 1 seria arbitrário. Devolve `undefined`
 * quando não há CFOP ou quando há empate — aí a decisão volta para o CNPJ.
 */
function direcaoPeloCfop(inv: ParsedInvoice): "ENTRADA" | "SAIDA" | undefined {
  let entradas = 0;
  let saidas = 0;

  for (const item of inv.items) {
    const d = item.cfop?.trim()[0];
    if (d === "1" || d === "2" || d === "3") entradas += 1;
    else if (d === "5" || d === "6" || d === "7") saidas += 1;
  }

  if (entradas === 0 && saidas === 0) return undefined;
  if (entradas === saidas) return undefined;
  return entradas > saidas ? "ENTRADA" : "SAIDA";
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
        direcao: direcaoReal(inv, cnpjEmpresa, origem),
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
        indicadorIeDestinatario: inv.destIeIndicator,
        destinatarioContribuinte:
          inv.destIeIndicator === undefined ? undefined : inv.destIeIndicator === "1",
        consumidorFinal: inv.finalConsumer,
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
          codigo: item.code,
          aliqIcms: item.icmsRate,
          baseIcms: item.icmsBase,
          valorIcms: item.icmsValue,
          valorIcmsSt: item.icmsStValue,
          valorIpi: item.ipiValue,
          valorDifal: item.difalValue,
          aliqPis: item.pisRate,
          aliqCofins: item.cofinsRate,
          origemMercadoria: item.origem,
          temIbsCbs: item.hasIbsCbs,
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

/**
 * Débitos confessados na DCTF.
 *
 * Grava um registro por débito, com o código de receita preservado: é ele que
 * permite conferir o tributo na tabela da Receita e é ele que amarra a
 * confissão ao DARF correspondente, quando o comprovante de arrecadação
 * também for importado.
 *
 * A chave de unicidade é documento + competência + código, e não apenas
 * documento + competência: uma mesma DCTF confessa IPI, PIS e COFINS do mesmo
 * mês, e colapsá-los perderia dois dos três.
 */
export async function persistirDctf(
  tx: Prisma.TransactionClient,
  documentoId: string,
  apuracao: ApuracaoDctf,
): Promise<number> {
  // Reimportação do mesmo arquivo reescreve o conjunto inteiro: débito que
  // saiu da retificadora não pode continuar no confronto.
  await tx.confissao.deleteMany({ where: { documentoId } });

  for (const d of apuracao.debitos) {
    await tx.confissao.create({
      data: {
        documentoId,
        competencia: d.competencia,
        tributo: d.tributo,
        codigoReceita: d.codigoReceita,
        valorDebito: d.valor,
        dataDeclaracao: apuracao.dataApuracao,
      },
    });
  }

  return apuracao.debitos.length;
}

/**
 * Controle do arquivo de escrituração, DIFAL (E300/E310) e inventário (H005).
 * Tudo por documento: reprocessar apaga e regrava.
 */
export async function persistirControleEscrituracao(
  tx: Prisma.TransactionClient,
  documentoId: string,
  resultado: ExtractionResult,
  competencia: string | undefined,
  indAtividade: string | undefined,
  finalidade: string | undefined,
): Promise<number> {
  await tx.escrituracaoArquivo.deleteMany({ where: { documentoId } });
  await tx.apuracaoDifal.deleteMany({ where: { documentoId } });
  await tx.apuracaoIpi.deleteMany({ where: { documentoId } });
  await tx.inventario.deleteMany({ where: { documentoId } });
  if (!competencia) return 0;

  await tx.escrituracaoArquivo.create({
    data: {
      documentoId,
      competencia,
      indAtividade,
      blocoK: resultado.blocoK,
      dataAssinatura: resultado.dataAssinatura,
      finalidade,
    },
  });

  let n = 1;
  for (const d of resultado.difal ?? []) {
    if (!d.uf) continue;
    await tx.apuracaoDifal.create({
      data: {
        documentoId,
        competencia,
        uf: d.uf,
        totalDebitos: d.totalDebitos ?? new Prisma.Decimal(0),
        totalCreditos: d.totalCreditos,
        aRecolher: d.aRecolher,
      },
    });
    n += 1;
  }
  for (const a of resultado.apuracoesIpi ?? []) {
    // IPI pode ser apurado em mais de um período no mês; a competência é a do início.
    const comp = a.periodStart ? paraCompetenciaIpi(a.periodStart) : competencia;
    await tx.apuracaoIpi.create({
      data: {
        documentoId,
        competencia: comp,
        debitos: a.debitos,
        creditos: a.creditos,
        saldoCredor: a.saldoCredor,
        aRecolher: a.aRecolher ?? new Prisma.Decimal(0),
      },
    });
    n += 1;
  }
  for (const i of resultado.inventarios ?? []) {
    await tx.inventario.create({
      data: {
        documentoId,
        competencia,
        dataInventario: i.data,
        valor: i.valor,
        motivo: i.motivo,
        somaItens: i.somaItens,
        itens: i.itens,
      },
    });
    n += 1;
  }
  return n;
}

/** ECF: uma linha por tributo e período. Reprocessar reescreve o conjunto. */
export async function persistirEcf(
  tx: Prisma.TransactionClient,
  documentoId: string,
  ecf: EcfExtraida,
): Promise<number> {
  await tx.apuracaoEcf.deleteMany({ where: { documentoId } });
  await tx.linhaEcf.deleteMany({ where: { documentoId } });
  await tx.socioEcf.deleteMany({ where: { documentoId } });
  if (!ecf.exercicio) return 0;
  const exercicio = ecf.exercicio;
  for (let i = 0; i < ecf.linhas.length; i += 2000) {
    await tx.linhaEcf.createMany({
      data: ecf.linhas.slice(i, i + 2000).map((l) => ({ documentoId, exercicio, ...l })),
    });
  }
  if (ecf.socios.length > 0) {
    await tx.socioEcf.createMany({ data: ecf.socios.map((s) => ({ documentoId, exercicio, ...s })) });
  }
  if (ecf.apuracoes.length === 0) return 0;
  await tx.apuracaoEcf.createMany({
    data: ecf.apuracoes.map((a) => ({
      documentoId,
      exercicio: ecf.exercicio!,
      periodo: a.periodo,
      tributo: a.tributo,
      receitaDeclarada: a.receitaBruta,
      baseCalculo: a.baseCalculo,
      valorApurado: a.valorApurado,
      adicional: a.adicional,
      aPagar: a.aPagar,
      registroOrigem: `${a.registroOrigem} ${a.periodoApuracao}`,
    })),
  });
  return ecf.apuracoes.length;
}

/**
 * ECD: saldos, partidas e DRE. Em lotes, porque cinco anos de escrituração
 * passam de centenas de milhares de partidas.
 */
export async function persistirEcd(
  documentoId: string,
  ecd: EcdExtraida,
): Promise<Pick<ContagemPersistida, "saldosContabeis" | "lancamentosContabeis" | "linhasDre">> {
  await prisma.$transaction([
    prisma.saldoConta.deleteMany({ where: { documentoId } }),
    prisma.lancamentoContabil.deleteMany({ where: { documentoId } }),
    prisma.linhaDre.deleteMany({ where: { documentoId } }),
    prisma.contaContabil.deleteMany({ where: { documentoId } }),
  ]);

  for (let i = 0; i < ecd.contas.length; i += 2000) {
    await prisma.contaContabil.createMany({
      data: ecd.contas.slice(i, i + 2000).map((c) => ({ documentoId, ...c })),
      skipDuplicates: true,
    });
  }

  const LOTE = 2000;
  for (let i = 0; i < ecd.saldos.length; i += LOTE) {
    await prisma.saldoConta.createMany({
      data: ecd.saldos.slice(i, i + LOTE).map((s) => ({ documentoId, ...s })),
      skipDuplicates: true,
    });
  }
  for (let i = 0; i < ecd.lancamentos.length; i += LOTE) {
    await prisma.lancamentoContabil.createMany({
      data: ecd.lancamentos.slice(i, i + LOTE).map((l) => ({
        documentoId,
        data: l.data,
        competencia: l.competencia,
        numeroLancamento: l.numeroLancamento,
        contaCodigo: l.contaCodigo,
        contaNome: l.contaNome,
        natureza: l.natureza,
        valor: l.valor,
        historico: l.historico,
        tipoLancamento: l.tipoLancamento,
        linhaOrigem: l.linhaOrigem,
      })),
    });
  }
  for (let i = 0; i < ecd.dre.length; i += LOTE) {
    await prisma.linhaDre.createMany({
      data: ecd.dre.slice(i, i + LOTE).map((d) => ({ documentoId, ...d })),
    });
  }

  return {
    saldosContabeis: ecd.saldos.length,
    lancamentosContabeis: ecd.lancamentos.length,
    linhasDre: ecd.dre.length,
  };
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
      // O próprio extrato diz quando a empresa está impedida de recolher ICMS e
      // ISS no DAS. É o sublimite afirmado pelo Fisco — melhor que deduzi-lo do
      // RBT12, porque considera o sublimite vigente em cada estado e ano.
      impedidoIcmsIssNoDas: extrato.impedidoIcmsIssNoDas,
      irpj: extrato.tributos?.irpj,
      csll: extrato.tributos?.csll,
      pis: extrato.tributos?.pis,
      cofins: extrato.tributos?.cofins,
      cpp: extrato.tributos?.cpp,
      icms: extrato.tributos?.icms,
      iss: extrato.tributos?.iss,
    },
    update: {},
  });
  return 1;
}

/**
 * Valor monetário do relatório de situação fiscal ("1.234,56") → Decimal.
 *
 * Ausente devolve `undefined`, nunca zero: nem toda pendência tem valor (omissão
 * de declaração não tem), e escrever zero somaria nada ao total como se fosse
 * uma dívida quitada.
 */
function valorBr(v: string | undefined): Prisma.Decimal | undefined {
  if (!v) return undefined;
  const limpo = v.replace(/\./g, "").replace(",", ".").trim();
  if (!/^-?\d+(\.\d+)?$/.test(limpo)) return undefined;
  return new Prisma.Decimal(limpo);
}

export async function persistirSituacaoFiscal(
  tx: Prisma.TransactionClient,
  documentoId: string,
  extraida: SituacaoFiscalExtraida,
): Promise<number> {
  await tx.retratoSituacaoFiscal.upsert({
    where: { documentoId },
    create: {
      documentoId,
      cnpj: extraida.cnpj,
      razaoSocial: extraida.razaoSocial,
      situacaoCadastral: extraida.situacaoCadastral,
      motivoSituacao: extraida.motivoSituacao,
      naturezaJuridica: extraida.naturezaJuridica,
      cnae: extraida.cnae,
      porte: extraida.porte,
      dataAbertura: extraida.dataAbertura,
      municipio: extraida.municipio,
      uf: extraida.uf,
      unidadeAdministrativa: extraida.unidadeAdministrativa,
      responsavel: extraida.responsavel,
      emitidoEm: extraida.emitidoEm,
      certidaoNumero: extraida.certidao?.numero,
      certidaoEmissao: extraida.certidao?.emissao,
      certidaoValidade: extraida.certidao?.validade,
      semPendencias: extraida.semPendencias,
      socios: extraida.socios as unknown as Prisma.InputJsonValue,
      avisos: extraida.avisos as unknown as Prisma.InputJsonValue,
    },
    update: {},
  });

  if (extraida.pendencias.length > 0) {
    await tx.pendenciaFiscal.createMany({
      data: extraida.pendencias.map((p) => ({
        documentoId,
        natureza: p.natureza,
        orgao: p.orgao,
        descricao: p.descricao,
        receita: p.receita,
        periodo: p.periodo,
        vencimento: p.vencimento,
        valorOriginal: valorBr(p.valorOriginal),
        saldoDevedor: valorBr(p.saldoDevedor),
        multa: valorBr(p.multa),
        juros: valorBr(p.juros),
        saldoConsolidado: valorBr(p.saldoConsolidado),
        situacao: p.situacao,
        identificacao: p.identificacao,
      })),
    });
  }

  return extraida.pendencias.length;
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

function paraCompetenciaIpi(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

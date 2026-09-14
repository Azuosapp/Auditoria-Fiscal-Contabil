import { dec, sum, type Money } from "@/server/tax/decimal";
import { decodeTextBuffer, type DetectedEncoding } from "./encoding";
import type { ExtractionResult } from "./types";

/**
 * Parser de SPED EFD Contribuições (PIS/Pasep e Cofins).
 *
 * ORIGEM DO LEIAUTE — Guia Prático da EFD-Contribuições, Versão 1.35,
 * atualização em 18/06/2021, publicado em:
 * https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-contribuicoes/manuais/guia_pratico_efd_contribuicoes_versao_1_35-18_06_2021.pdf
 * (baixado nesta sessão via `Invoke-WebRequest ... /@@download/file`, convertido com
 * `pdftotext -layout` e conferido campo a campo — ver registros abaixo).
 *
 * Confirmado também, na mesma sessão, que essa é a versão vigente para 2026: a Nota
 * Técnica nº 011/2026 (RFB, publicada em 27/05/2026, disponível em
 * https://www.gov.br/sped/pt-br/assuntos/escrituracoes-digitais/efd-contribuicoes/documentos-tecnicos/nota-tecnica-11-2026-descontinuidade-da-efd-contribuicoes-orientacoes-para-os-contribuintes)
 * confirma que NÃO há alteração de leiaute da EFD-Contribuições para 2026 (a
 * EFD-Contribuições convive com a Reforma Tributária até ser descontinuada, a partir
 * dos fatos geradores de 2027) e que os valores de IBS/CBS/IS não devem ser somados
 * aos registros desta escrituração em 2026.
 *
 * Registros M210 e M610 têm DOIS leiautes no Guia Prático: um válido até os fatos
 * geradores de 31/12/2018 (13 campos) e outro válido a partir de 01/01/2019 (16
 * campos, com o detalhamento de ajuste de base em campos próprios). Este parser
 * implementa **somente o leiaute vigente a partir de 2019** — é o único aplicável a
 * arquivo de cliente corrente. Arquivo antigo (fato gerador até 2018) com M210/M610
 * de 13 campos será lido campo a campo pela posição errada e os valores ficarão
 * incoerentes; not implementado neste parser (ver warnings de inconsistência, que
 * apontam a divergência, mas não identificam a causa como "leiaute antigo").
 *
 * Registros cobertos:
 *  0000 — Abertura do arquivo e identificação da pessoa jurídica.
 *  0110 — Regimes de apuração da contribuição social e método de apropriação de
 *         crédito (é o registro que diz se a empresa é cumulativa, não-cumulativa
 *         ou ambas).
 *  M100/M105 — Crédito de PIS/Pasep do período e detalhamento da base de cálculo.
 *  M200/M210 — Consolidação da contribuição de PIS/Pasep do período e detalhamento
 *              por código de contribuição (leiaute pós-2019).
 *  M500/M505 — Crédito de Cofins do período e detalhamento da base de cálculo.
 *  M600/M610 — Consolidação da contribuição de Cofins do período e detalhamento
 *              por código de contribuição (leiaute pós-2019).
 *
 * Fora de escopo nesta rodada (ver relatório de importação da tarefa que originou
 * este parser — não implementado por prazo, não por dificuldade técnica):
 *  - C100/C170 (documentos fiscais — mercadorias), A100/A170 (serviços) e F100
 *    (demais documentos/operações) — ficariam disponíveis como `invoices`, no
 *    padrão `ParsedInvoice`, mas exigiriam confirmar contra o Guia Prático o
 *    leiaute específico de Bloco A/C/F da EFD-Contribuições (diferente do Bloco C
 *    da EFD ICMS/IPI implementado em sped.ts).
 *  - Registros 0111 (receita bruta discriminada, usada no rateio proporcional),
 *    M110/M220/M230/M620/M630 (ajustes e diferimento detalhados), M350/M400/M410 e
 *    demais registros do Bloco M não listados acima, Bloco P (contribuição
 *    previdenciária sobre receita bruta) e Blocos 1/9 (controle/totais).
 *  - Registro M610 e M210 no leiaute pré-2019 (ver nota acima).
 * Linhas desses tipos são contadas e resumidas em `warnings`, nunca derrubam o
 * arquivo (mesmo padrão de sped.ts).
 */

export interface ParseSpedContribuicoesOptions {
  /** Força o encoding em vez de detectar (BOM UTF-8 → utf-8; senão heurística). */
  encoding?: DetectedEncoding;
}

/** SPED EFD-Contribuições registro 0110 campo 02 — COD_INC_TRIB (tabela do próprio registro). */
const INCIDENCE_LABELS: Record<string, string> = {
  "1": "Exclusivamente regime não-cumulativo",
  "2": "Exclusivamente regime cumulativo",
  "3": "Regimes não-cumulativo e cumulativo",
};

/** SPED EFD-Contribuições registro 0110 campo 03 — IND_APRO_CRED. */
const CREDIT_METHOD_LABELS: Record<string, string> = {
  "1": "Método de Apropriação Direta",
  "2": "Método de Rateio Proporcional (Receita Bruta)",
};

/** SPED EFD-Contribuições registro 0110 campo 04 — COD_TIPO_CONT. */
const CONTRIBUTION_TYPE_LABELS: Record<string, string> = {
  "1": "Apuração da contribuição exclusivamente à alíquota básica",
  "2": "Apuração da contribuição a alíquotas específicas (diferenciadas e/ou por unidade de medida de produto)",
};

/** SPED EFD-Contribuições registros M100/M500 campo 03 — IND_CRED_ORI. */
const CREDIT_ORIGIN_LABELS: Record<string, string> = {
  "0": "Operações próprias",
  "1": "Evento de incorporação, cisão ou fusão",
};

/** SPED EFD-Contribuições registros M100/M500 campo 13 — IND_DESC_CRED. */
const CREDIT_USAGE_LABELS: Record<string, string> = {
  "0": "Utilização do valor total para desconto da contribuição apurada no período",
  "1": "Utilização de valor parcial para desconto da contribuição apurada no período",
};

/**
 * SPED EFD-Contribuições — Tabela 4.3.5 (Código de Contribuição Social Apurada),
 * usada nos registros M210/M610 campo 02 — COD_CONT.
 */
const CONTRIBUTION_CODE_LABELS: Record<string, string> = {
  "01": "Contribuição não-cumulativa apurada a alíquota básica",
  "02": "Contribuição não-cumulativa apurada a alíquotas diferenciadas",
  "03": "Contribuição não-cumulativa apurada a alíquota por unidade de medida de produto",
  "04": "Contribuição não-cumulativa apurada a alíquota básica - Atividade Imobiliária",
  "31": "Contribuição apurada por substituição tributária",
  "32": "Contribuição apurada por substituição tributária - Vendas à Zona Franca de Manaus",
  "51": "Contribuição cumulativa apurada a alíquota básica",
  "52": "Contribuição cumulativa apurada a alíquotas diferenciadas",
  "53": "Contribuição cumulativa apurada a alíquota por unidade de medida de produto",
  "54": "Contribuição cumulativa apurada a alíquota básica - Atividade Imobiliária",
  "71": "Contribuição apurada de SCP - Incidência Não Cumulativa",
  "72": "Contribuição apurada de SCP - Incidência Cumulativa",
  "99": "Contribuição para o PIS/Pasep - Folha de Salários",
};

/** SPED EFD-Contribuições registro 0000 campo 13 — IND_NAT_PJ (a partir do ano-calendário 2014). */
const LEGAL_NATURE_LABELS: Record<string, string> = {
  "00": "Pessoa jurídica em geral (não participante de SCP como sócia ostensiva)",
  "01": "Sociedade cooperativa (não participante de SCP como sócia ostensiva)",
  "02": "Entidade sujeita ao PIS/Pasep exclusivamente com base na Folha de Salários",
  "03": "Pessoa jurídica em geral participante de SCP como sócia ostensiva",
  "04": "Sociedade cooperativa participante de SCP como sócia ostensiva",
  "05": "Sociedade em Conta de Participação - SCP",
};

/** SPED EFD-Contribuições registro 0000 campo 14 — IND_ATIV. */
const ACTIVITY_LABELS: Record<string, string> = {
  "0": "Industrial ou equiparado a industrial",
  "1": "Prestador de serviços",
  "2": "Atividade de comércio",
  "3": "Pessoas jurídicas referidas nos §§ 6º, 8º e 9º do art. 3º da Lei nº 9.718, de 1998",
  "4": "Atividade imobiliária",
  "9": "Outros",
};

/** Tolerância (em reais) para o alerta de fechamento entre M200/M600 e a soma de M210/M610. */
const CONSISTENCY_TOLERANCE = dec("0.01")!;

function onlyDigits(v: string | undefined): string | undefined {
  if (!v) return undefined;
  const d = v.replace(/\D/g, "");
  return d === "" ? undefined : d;
}

/** Data no formato SPED DDMMAAAA. Sem informação de fuso na origem — tratada como data UTC. */
function parseSpedDate(v: string | undefined): Date | undefined {
  if (!v) return undefined;
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(v.trim());
  if (!m) return undefined;
  const [, dd, mm, yyyy] = m;
  const d = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd)));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** Identificação da entidade e do período do arquivo (SPED EFD-Contribuições registro 0000). */
export interface ParsedSpedContribIdentification {
  /** Campo 02 — COD_VER. */
  layoutVersion?: string;
  /** Campo 03 — TIPO_ESCRIT (0 Original; 1 Retificadora). */
  recordTypeCode?: string;
  /** Campo 04 — IND_SIT_ESP (0 Abertura; 1 Cisão; 2 Fusão; 3 Incorporação; 4 Encerramento). */
  specialSituationCode?: string;
  /** Campo 05 — NUM_REC_ANTERIOR (recibo da escrituração anterior, quando retificadora). */
  previousReceiptNumber?: string;
  /** Campo 06 — DT_INI. */
  periodStart?: Date;
  /** Campo 07 — DT_FIN. */
  periodEnd?: Date;
  /** Campo 08 — NOME. */
  name?: string;
  /** Campo 09 — CNPJ (matriz). */
  cnpj?: string;
  /** Campo 10 — UF. */
  uf?: string;
  /** Campo 11 — COD_MUN (tabela IBGE). */
  municipalityCode?: string;
  /** Campo 12 — SUFRAMA. */
  suframa?: string;
  /** Campo 13 — IND_NAT_PJ. */
  legalNatureCode?: string;
  legalNatureLabel?: string;
  /** Campo 14 — IND_ATIV. */
  activityCode?: string;
  activityLabel?: string;
}

/**
 * Regime de apuração da contribuição e método de apropriação de crédito
 * (SPED EFD-Contribuições registro 0110) — define se a empresa é cumulativa,
 * não-cumulativa ou ambas no período.
 */
export interface ParsedRegimeApuracao {
  /** Campo 02 — COD_INC_TRIB. */
  incidenceCode?: string;
  incidenceLabel?: string;
  /** Campo 03 — IND_APRO_CRED (só se aplica quando COD_INC_TRIB = 1 ou 3). */
  creditMethodCode?: string;
  creditMethodLabel?: string;
  /** Campo 04 — COD_TIPO_CONT. */
  contributionTypeCode?: string;
  contributionTypeLabel?: string;
  /** Campo 05 — IND_REG_CUM (só se aplica quando COD_INC_TRIB = 2, lucro presumido). */
  cumulativeRegimeCriterionCode?: string;
}

/**
 * Detalhamento da base de cálculo de um crédito (SPED registros M105 — PIS —
 * e M505 — Cofins, mesma estrutura de campos).
 */
export interface ParsedCreditoContribuicaoDetalhe {
  /** Campo 02 — NAT_BC_CRED (Tabela 4.3.7). */
  baseNatureCode?: string;
  /** Campo 03 — CST_PIS (M105) / CST_COFINS (M505). */
  cst?: string;
  /** Campo 04 — VL_BC_PIS_TOT (M105) / VL_BC_COFINS_TOT (M505). */
  totalBaseValue?: Money;
  /** Campo 05 — VL_BC_PIS_CUM (M105) / VL_BC_COFINS_CUM (M505). */
  cumulativeBaseValue?: Money;
  /** Campo 06 — VL_BC_PIS_NC (M105) / VL_BC_COFINS_NC (M505). */
  nonCumulativeBaseValue?: Money;
  /** Campo 07 — VL_BC_PIS (M105) / VL_BC_COFINS (M505). */
  baseValue?: Money;
  /** Campo 08 — QUANT_BC_PIS_TOT (M105) / QUANT_BC_COFINS_TOT (M505). */
  totalBaseQuantity?: Money;
  /** Campo 09 — QUANT_BC_PIS (M105) / QUANT_BC_COFINS (M505). */
  baseQuantity?: Money;
  /** Campo 10 — DESC_CRED. */
  description?: string;
}

/**
 * Crédito de PIS/Pasep (SPED registro M100) ou de Cofins (SPED registro M500) do
 * período — mesma estrutura de campos nos dois registros.
 */
export interface ParsedCreditoContribuicao {
  /** Campo 02 — COD_CRED (Tabela 4.3.6 — Código de Tipo de Crédito). */
  creditCode?: string;
  /** Campo 03 — IND_CRED_ORI. */
  originCode?: string;
  originLabel?: string;
  /** Campo 04 — VL_BC_PIS (M100) / VL_BC_COFINS (M500). */
  baseValue?: Money;
  /** Campo 05 — ALIQ_PIS (M100) / ALIQ_COFINS (M500), em percentual. */
  rate?: Money;
  /** Campo 06 — QUANT_BC_PIS (M100) / QUANT_BC_COFINS (M500). */
  baseQuantity?: Money;
  /** Campo 07 — ALIQ_PIS_QUANT (M100) / ALIQ_COFINS_QUANT (M500), em reais. */
  rateInReais?: Money;
  /** Campo 08 — VL_CRED. */
  creditValue?: Money;
  /** Campo 09 — VL_AJUS_ACRES. */
  increaseAdjustments?: Money;
  /** Campo 10 — VL_AJUS_REDUC. */
  decreaseAdjustments?: Money;
  /** Campo 11 — VL_CRED_DIFER. */
  deferredCredit?: Money;
  /** Campo 12 — VL_CRED_DISP (08 + 09 - 10 - 11). */
  availableCredit?: Money;
  /** Campo 13 — IND_DESC_CRED. */
  usageCode?: string;
  usageLabel?: string;
  /** Campo 14 — VL_CRED_DESC. */
  discountedCredit?: Money;
  /** Campo 15 — SLD_CRED (12 - 14). */
  balanceToCarry?: Money;
  /** Registros Filho M105 (PIS) / M505 (Cofins). */
  details: ParsedCreditoContribuicaoDetalhe[];
}

/**
 * Detalhamento da contribuição por código (SPED registro M210 — PIS — ou M610 —
 * Cofins, leiaute vigente a partir dos fatos geradores de 01/01/2019, 16 campos).
 */
export interface ParsedContribuicaoDetalhe {
  /** Campo 02 — COD_CONT (Tabela 4.3.5). */
  contributionCode?: string;
  contributionLabel?: string;
  /** Campo 03 — VL_REC_BRT. */
  grossRevenue?: Money;
  /** Campo 04 — VL_BC_CONT (antes de ajustes). */
  baseValue?: Money;
  /** Campo 05 — VL_AJUS_ACRES_BC_PIS (M210) / VL_AJUS_ACRES_BC_COFINS (M610). */
  baseIncreaseAdjustments?: Money;
  /** Campo 06 — VL_AJUS_REDUC_BC_PIS (M210) / VL_AJUS_REDUC_BC_COFINS (M610). */
  baseDecreaseAdjustments?: Money;
  /** Campo 07 — VL_BC_CONT_AJUS (04 + 05 - 06). */
  baseValueAdjusted?: Money;
  /** Campo 08 — ALIQ_PIS (M210) / ALIQ_COFINS (M610), em percentual. */
  rate?: Money;
  /** Campo 09 — QUANT_BC_PIS (M210) / QUANT_BC_COFINS (M610). */
  baseQuantity?: Money;
  /** Campo 10 — ALIQ_PIS_QUANT (M210) / ALIQ_COFINS_QUANT (M610), em reais. */
  rateInReais?: Money;
  /** Campo 11 — VL_CONT_APUR. */
  contributionAssessed?: Money;
  /** Campo 12 — VL_AJUS_ACRES. */
  increaseAdjustments?: Money;
  /** Campo 13 — VL_AJUS_REDUC. */
  decreaseAdjustments?: Money;
  /** Campo 14 — VL_CONT_DIFER. */
  deferredContribution?: Money;
  /** Campo 15 — VL_CONT_DIFER_ANT. */
  deferredContributionPrior?: Money;
  /** Campo 16 — VL_CONT_PER (11 + 12 - 13 - 14 + 15). */
  periodContribution?: Money;
}

/**
 * Consolidação da contribuição do período (SPED registro M200 — PIS — ou M600 —
 * Cofins, mesma estrutura de campos nos dois registros).
 */
export interface ParsedConsolidacaoContribuicao {
  /** Campo 02 — VL_TOT_CONT_NC_PER. */
  nonCumulativeContribution?: Money;
  /** Campo 03 — VL_TOT_CRED_DESC. */
  creditDiscountedCurrentPeriod?: Money;
  /** Campo 04 — VL_TOT_CRED_DESC_ANT. */
  creditDiscountedPriorPeriod?: Money;
  /** Campo 05 — VL_TOT_CONT_NC_DEV (02 - 03 - 04). */
  nonCumulativeContributionDue?: Money;
  /** Campo 06 — VL_RET_NC. */
  withheldNonCumulative?: Money;
  /** Campo 07 — VL_OUT_DED_NC. */
  otherDeductionsNonCumulative?: Money;
  /** Campo 08 — VL_CONT_NC_REC (05 - 06 - 07). */
  nonCumulativeContributionToPay?: Money;
  /** Campo 09 — VL_TOT_CONT_CUM_PER. */
  cumulativeContribution?: Money;
  /** Campo 10 — VL_RET_CUM. */
  withheldCumulative?: Money;
  /** Campo 11 — VL_OUT_DED_CUM. */
  otherDeductionsCumulative?: Money;
  /** Campo 12 — VL_CONT_CUM_REC (09 - 10 - 11). */
  cumulativeContributionToPay?: Money;
  /** Campo 13 — VL_TOT_CONT_REC (08 + 12). */
  totalContributionToPay?: Money;
  /** Registros Filho M210 (PIS) / M610 (Cofins). */
  details: ParsedContribuicaoDetalhe[];
}

/** Apuração completa de uma contribuição (PIS ou Cofins) no período do arquivo. */
export interface ParsedApuracaoContribuicao {
  credits: ParsedCreditoContribuicao[];
  consolidation?: ParsedConsolidacaoContribuicao;
}

/**
 * Resultado da extração de um arquivo SPED EFD Contribuições. Estende
 * `ExtractionResult` (com `invoices: []` e `apuracoes: []`, que não se aplicam a
 * este layout) e acrescenta os campos próprios de PIS/Cofins.
 */
export interface ExtractionResultSpedContribuicoes extends ExtractionResult {
  /** Identificação do arquivo (registro 0000) — formato próprio da EFD-Contribuições, não o de sped.ts. */
  contribIdentification?: ParsedSpedContribIdentification;
  /** Regime de apuração e método de apropriação de crédito (registro 0110). */
  regimeApuracao?: ParsedRegimeApuracao;
  pis: ParsedApuracaoContribuicao;
  cofins: ParsedApuracaoContribuicao;
}

export function parseSpedContribuicoes(
  buffer: Buffer,
  options: ParseSpedContribuicoesOptions = {},
): ExtractionResultSpedContribuicoes {
  const warnings: string[] = [];
  const errors: string[] = [];

  const { text, encoding, forced } = decodeTextBuffer(buffer, options.encoding);
  warnings.push(`Codificação ${forced ? "informada" : "detectada"}: ${encoding}.`);

  const baseResult = (): ExtractionResultSpedContribuicoes => ({
    parser: "sped-efd-contribuicoes",
    invoices: [],
    warnings,
    errors,
    apuracoes: [],
    pis: { credits: [] },
    cofins: { credits: [] },
  });

  if (text.trim() === "") {
    errors.push("Arquivo vazio ou sem conteúdo legível.");
    return baseResult();
  }

  const lines = text.split(/\r\n|\r|\n/);

  let identification: ParsedSpedContribIdentification | undefined;
  let regime: ParsedRegimeApuracao | undefined;

  let currentCreditoPis: ParsedCreditoContribuicao | undefined;
  const creditosPis: ParsedCreditoContribuicao[] = [];
  let currentCreditoCofins: ParsedCreditoContribuicao | undefined;
  const creditosCofins: ParsedCreditoContribuicao[] = [];

  let consolidacaoPis: ParsedConsolidacaoContribuicao | undefined;
  let consolidacaoCofins: ParsedConsolidacaoContribuicao | undefined;

  const skippedByType = new Map<string, number>();

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    const rawLine = lines[idx].trim();
    if (rawLine === "") continue; // linha em branco (comum ao final do arquivo)

    if (!rawLine.startsWith("|") || !rawLine.endsWith("|")) {
      warnings.push(
        `Linha ${lineNo}: registro fora do padrão "|campo|campo|...|" — ignorada.`,
      );
      continue;
    }

    const parts = rawLine.slice(1, -1).split("|");
    const reg = parts[0]?.trim();
    if (!reg) {
      warnings.push(`Linha ${lineNo}: registro sem código REG — ignorada.`);
      continue;
    }

    /** Campo pela posição do Guia Prático (1-based, incluindo REG = 1). */
    const f = (specPos: number): string | undefined => {
      const raw = parts[specPos - 1];
      if (raw === undefined) return undefined;
      const t = raw.trim();
      return t === "" ? undefined : t;
    };

    try {
      switch (reg) {
        case "0000": {
          const legalNatureCode = f(13);
          const activityCode = f(14);
          identification = {
            layoutVersion: f(2),
            recordTypeCode: f(3),
            specialSituationCode: f(4),
            previousReceiptNumber: f(5),
            periodStart: parseSpedDate(f(6)),
            periodEnd: parseSpedDate(f(7)),
            name: f(8),
            cnpj: onlyDigits(f(9)),
            uf: f(10),
            municipalityCode: f(11),
            suframa: f(12),
            legalNatureCode,
            legalNatureLabel: legalNatureCode
              ? LEGAL_NATURE_LABELS[legalNatureCode]
              : undefined,
            activityCode,
            activityLabel: activityCode ? ACTIVITY_LABELS[activityCode] : undefined,
          };
          if (identification.cnpj && identification.cnpj.length !== 14) {
            warnings.push(
              `Linha ${lineNo}: CNPJ do registro 0000 com ${identification.cnpj.length} dígitos (esperado 14) — mantido como veio.`,
            );
          }
          break;
        }

        case "0110": {
          const incidenceCode = f(2);
          const creditMethodCode = f(3);
          const contributionTypeCode = f(4);
          regime = {
            incidenceCode,
            incidenceLabel: incidenceCode ? INCIDENCE_LABELS[incidenceCode] : undefined,
            creditMethodCode,
            creditMethodLabel: creditMethodCode
              ? CREDIT_METHOD_LABELS[creditMethodCode]
              : undefined,
            contributionTypeCode,
            contributionTypeLabel: contributionTypeCode
              ? CONTRIBUTION_TYPE_LABELS[contributionTypeCode]
              : undefined,
            cumulativeRegimeCriterionCode: f(5),
          };
          break;
        }

        case "M100": {
          if (currentCreditoPis) creditosPis.push(currentCreditoPis);
          const originCode = f(3);
          const usageCode = f(13);
          currentCreditoPis = {
            creditCode: f(2),
            originCode,
            originLabel: originCode ? CREDIT_ORIGIN_LABELS[originCode] : undefined,
            baseValue: dec(f(4)),
            rate: dec(f(5)),
            baseQuantity: dec(f(6)),
            rateInReais: dec(f(7)),
            creditValue: dec(f(8)),
            increaseAdjustments: dec(f(9)),
            decreaseAdjustments: dec(f(10)),
            deferredCredit: dec(f(11)),
            availableCredit: dec(f(12)),
            usageCode,
            usageLabel: usageCode ? CREDIT_USAGE_LABELS[usageCode] : undefined,
            discountedCredit: dec(f(14)),
            balanceToCarry: dec(f(15)),
            details: [],
          };
          break;
        }

        case "M105": {
          if (!currentCreditoPis) {
            throw new Error("M105 sem M100 aberto antes — detalhamento ignorado");
          }
          currentCreditoPis.details.push({
            baseNatureCode: f(2),
            cst: f(3),
            totalBaseValue: dec(f(4)),
            cumulativeBaseValue: dec(f(5)),
            nonCumulativeBaseValue: dec(f(6)),
            baseValue: dec(f(7)),
            totalBaseQuantity: dec(f(8)),
            baseQuantity: dec(f(9)),
            description: f(10),
          });
          break;
        }

        case "M200": {
          if (currentCreditoPis) {
            creditosPis.push(currentCreditoPis);
            currentCreditoPis = undefined;
          }
          if (consolidacaoPis) {
            warnings.push(
              `Linha ${lineNo}: registro M200 repetido (ocorrência esperada é única por arquivo) — mantendo o primeiro, este foi ignorado.`,
            );
            break;
          }
          consolidacaoPis = {
            nonCumulativeContribution: dec(f(2)),
            creditDiscountedCurrentPeriod: dec(f(3)),
            creditDiscountedPriorPeriod: dec(f(4)),
            nonCumulativeContributionDue: dec(f(5)),
            withheldNonCumulative: dec(f(6)),
            otherDeductionsNonCumulative: dec(f(7)),
            nonCumulativeContributionToPay: dec(f(8)),
            cumulativeContribution: dec(f(9)),
            withheldCumulative: dec(f(10)),
            otherDeductionsCumulative: dec(f(11)),
            cumulativeContributionToPay: dec(f(12)),
            totalContributionToPay: dec(f(13)),
            details: [],
          };
          break;
        }

        case "M210": {
          if (!consolidacaoPis) {
            throw new Error("M210 sem M200 aberto antes — detalhamento ignorado");
          }
          const contributionCode = f(2);
          consolidacaoPis.details.push({
            contributionCode,
            contributionLabel: contributionCode
              ? CONTRIBUTION_CODE_LABELS[contributionCode]
              : undefined,
            grossRevenue: dec(f(3)),
            baseValue: dec(f(4)),
            baseIncreaseAdjustments: dec(f(5)),
            baseDecreaseAdjustments: dec(f(6)),
            baseValueAdjusted: dec(f(7)),
            rate: dec(f(8)),
            baseQuantity: dec(f(9)),
            rateInReais: dec(f(10)),
            contributionAssessed: dec(f(11)),
            increaseAdjustments: dec(f(12)),
            decreaseAdjustments: dec(f(13)),
            deferredContribution: dec(f(14)),
            deferredContributionPrior: dec(f(15)),
            periodContribution: dec(f(16)),
          });
          break;
        }

        case "M500": {
          if (currentCreditoCofins) creditosCofins.push(currentCreditoCofins);
          const originCode = f(3);
          const usageCode = f(13);
          currentCreditoCofins = {
            creditCode: f(2),
            originCode,
            originLabel: originCode ? CREDIT_ORIGIN_LABELS[originCode] : undefined,
            baseValue: dec(f(4)),
            rate: dec(f(5)),
            baseQuantity: dec(f(6)),
            rateInReais: dec(f(7)),
            creditValue: dec(f(8)),
            increaseAdjustments: dec(f(9)),
            decreaseAdjustments: dec(f(10)),
            deferredCredit: dec(f(11)),
            availableCredit: dec(f(12)),
            usageCode,
            usageLabel: usageCode ? CREDIT_USAGE_LABELS[usageCode] : undefined,
            discountedCredit: dec(f(14)),
            balanceToCarry: dec(f(15)),
            details: [],
          };
          break;
        }

        case "M505": {
          if (!currentCreditoCofins) {
            throw new Error("M505 sem M500 aberto antes — detalhamento ignorado");
          }
          currentCreditoCofins.details.push({
            baseNatureCode: f(2),
            cst: f(3),
            totalBaseValue: dec(f(4)),
            cumulativeBaseValue: dec(f(5)),
            nonCumulativeBaseValue: dec(f(6)),
            baseValue: dec(f(7)),
            totalBaseQuantity: dec(f(8)),
            baseQuantity: dec(f(9)),
            description: f(10),
          });
          break;
        }

        case "M600": {
          if (currentCreditoCofins) {
            creditosCofins.push(currentCreditoCofins);
            currentCreditoCofins = undefined;
          }
          if (consolidacaoCofins) {
            warnings.push(
              `Linha ${lineNo}: registro M600 repetido (ocorrência esperada é única por arquivo) — mantendo o primeiro, este foi ignorado.`,
            );
            break;
          }
          consolidacaoCofins = {
            nonCumulativeContribution: dec(f(2)),
            creditDiscountedCurrentPeriod: dec(f(3)),
            creditDiscountedPriorPeriod: dec(f(4)),
            nonCumulativeContributionDue: dec(f(5)),
            withheldNonCumulative: dec(f(6)),
            otherDeductionsNonCumulative: dec(f(7)),
            nonCumulativeContributionToPay: dec(f(8)),
            cumulativeContribution: dec(f(9)),
            withheldCumulative: dec(f(10)),
            otherDeductionsCumulative: dec(f(11)),
            cumulativeContributionToPay: dec(f(12)),
            totalContributionToPay: dec(f(13)),
            details: [],
          };
          break;
        }

        case "M610": {
          if (!consolidacaoCofins) {
            throw new Error("M610 sem M600 aberto antes — detalhamento ignorado");
          }
          const contributionCode = f(2);
          consolidacaoCofins.details.push({
            contributionCode,
            contributionLabel: contributionCode
              ? CONTRIBUTION_CODE_LABELS[contributionCode]
              : undefined,
            grossRevenue: dec(f(3)),
            baseValue: dec(f(4)),
            baseIncreaseAdjustments: dec(f(5)),
            baseDecreaseAdjustments: dec(f(6)),
            baseValueAdjusted: dec(f(7)),
            rate: dec(f(8)),
            baseQuantity: dec(f(9)),
            rateInReais: dec(f(10)),
            contributionAssessed: dec(f(11)),
            increaseAdjustments: dec(f(12)),
            decreaseAdjustments: dec(f(13)),
            deferredContribution: dec(f(14)),
            deferredContributionPrior: dec(f(15)),
            periodContribution: dec(f(16)),
          });
          break;
        }

        default: {
          skippedByType.set(reg, (skippedByType.get(reg) ?? 0) + 1);
          break;
        }
      }
    } catch (e) {
      warnings.push(`Linha ${lineNo} (registro ${reg}): ${(e as Error).message}`);
    }
  }

  // Fecha contexto aberto ao final do arquivo.
  if (currentCreditoPis) creditosPis.push(currentCreditoPis);
  if (currentCreditoCofins) creditosCofins.push(currentCreditoCofins);

  if (!identification) {
    warnings.push(
      "Registro 0000 não encontrado — identificação do arquivo (CNPJ, período, UF) indisponível.",
    );
  }
  if (!regime) {
    warnings.push(
      "Registro 0110 não encontrado — regime de apuração (cumulativo/não-cumulativo) indisponível.",
    );
  }

  // Consistência: M200 (campos 02 + 09) deve fechar com a soma de VL_CONT_PER de
  // todos os M210, exceto o código 99 (Folha de Salários), que o próprio Guia
  // Prático diz não ser gerado em M210 pela apuração automática do PVA e cuja
  // origem é o registro M350 (fora de escopo deste parser).
  if (consolidacaoPis) {
    const somaM210 = sum(
      ...consolidacaoPis.details
        .filter((d) => d.contributionCode !== "99")
        .map((d) => d.periodContribution),
    );
    const totalM200 = sum(
      consolidacaoPis.nonCumulativeContribution,
      consolidacaoPis.cumulativeContribution,
    );
    if (somaM210.minus(totalM200).abs().greaterThan(CONSISTENCY_TOLERANCE)) {
      warnings.push(
        `Registro M200: a soma de VL_CONT_PER dos registros M210 (${somaM210.toFixed(2)}) não fecha com VL_TOT_CONT_NC_PER + VL_TOT_CONT_CUM_PER (${totalM200.toFixed(2)}) — divergência de ${somaM210.minus(totalM200).abs().toFixed(2)}.`,
      );
    }
  }
  if (consolidacaoCofins) {
    const somaM610 = sum(
      ...consolidacaoCofins.details
        .filter((d) => d.contributionCode !== "99")
        .map((d) => d.periodContribution),
    );
    const totalM600 = sum(
      consolidacaoCofins.nonCumulativeContribution,
      consolidacaoCofins.cumulativeContribution,
    );
    if (somaM610.minus(totalM600).abs().greaterThan(CONSISTENCY_TOLERANCE)) {
      warnings.push(
        `Registro M600: a soma de VL_CONT_PER dos registros M610 (${somaM610.toFixed(2)}) não fecha com VL_TOT_CONT_NC_PER + VL_TOT_CONT_CUM_PER (${totalM600.toFixed(2)}) — divergência de ${somaM610.minus(totalM600).abs().toFixed(2)}.`,
      );
    }
  }

  if (skippedByType.size > 0) {
    const total = [...skippedByType.values()].reduce((a, b) => a + b, 0);
    const top = [...skippedByType.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([code, count]) => `${code} (${count})`)
      .join(", ");
    warnings.push(
      `${total} linha(s) de registro(s) fora do escopo deste parser foram ignoradas (não são erro, apenas não implementadas): ${top}${
        skippedByType.size > 12 ? ", ..." : ""
      }.`,
    );
  }

  return {
    parser: "sped-efd-contribuicoes",
    invoices: [],
    warnings,
    errors,
    apuracoes: [],
    contribIdentification: identification,
    regimeApuracao: regime,
    pis: { credits: creditosPis, consolidation: consolidacaoPis },
    cofins: { credits: creditosCofins, consolidation: consolidacaoCofins },
  };
}

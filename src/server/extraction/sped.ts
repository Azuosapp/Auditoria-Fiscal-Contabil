import type { InvoiceDirection, InvoiceModel } from "./tipos-prisma";
import { dec } from "@/server/tax/decimal";
import { decodeTextBuffer, type DetectedEncoding } from "./encoding";
import { isValidAccessKey } from "./access-key";
import type {
  ExtractionResult,
  ParsedApuracao,
  ParsedApuracaoAjuste,
  ParsedApuracaoInfoAdicional,
  ParsedInvoice,
  ParsedInvoiceAnalytic,
  ParsedInvoiceItem,
  ParsedSpedIdentification,
} from "./types";

/**
 * Parser de SPED EFD ICMS/IPI (Guia Prático da Escrituração Fiscal Digital).
 *
 * IMPORTANTE — origem do leiaute: o ambiente desta sessão não teve acesso à
 * internet para confirmar o leiaute contra o PDF oficial em sped.rfb.gov.br
 * (falha de conexão em todas as tentativas — ver relatório de importação).
 * Os campos abaixo vêm de conhecimento consolidado do Guia Prático (registros
 * estáveis desde a criação do SPED Fiscal em 2009, amplamente documentados).
 * Uma validação cruzada: o campo 11 do E110 aqui mapeado como VL_SLD_APURADO
 * bate com a posição informada pela própria tarefa que originou este parser —
 * é o único ponto de checagem independente disponível nesta sessão. Confirme
 * contra o Guia Prático oficial antes de usar em apuração real de cliente.
 *
 * Registros cobertos (ver justificativa de cada um abaixo):
 *  Bloco 0 — 0000 (identificação), 0150 (participantes), 0200 (itens/NCM)
 *  Bloco C — C100 (nota fiscal), C170 (itens da nota), C190 (analítico)
 *  Bloco E — E100 (período), E110 (apuração — campo 11 é a média do PROGOIÁS),
 *            E111 (ajustes), E115 (informações adicionais/GO0200xx)
 *
 * Registros explicitamente FORA de escopo (não implementados; linhas desses
 * tipos são contadas e resumidas em `warnings`, nunca derrubam o arquivo):
 *  - Blocos 0 restantes (0190, 0175, 0300, 0400, 0450, 0460, ...)
 *  - Bloco B (ISS), Bloco D (transporte/comunicação), Bloco G (CIAP),
 *    Bloco H (inventário), Bloco K (produção/estoque, obrigatório para
 *    industriais — fica para uma próxima rodada por ser layout extenso)
 *  - Registros 1xxx (Bloco 1 — outras informações) e 9xxx (controle/totais)
 *  - EFD Contribuições (layout de blocos totalmente diferente — não é este
 *    arquivo; ver DocumentType.EFD_CONTRIBUICOES, que continua stub)
 */

export interface ParseSpedOptions {
  /** Força o encoding em vez de detectar (BOM UTF-8 → utf-8; senão heurística). */
  encoding?: DetectedEncoding;
}

interface ParticipantRecord {
  name?: string;
  cnpj?: string;
  cpf?: string;
  ie?: string;
}

interface ProductRecord {
  description?: string;
  ncm?: string;
}

/** SPED registro C100 campo COD_SIT — tabela 4.1.2. */
const SITUATION_LABELS: Record<string, string> = {
  "00": "Documento regular",
  "01": "Documento regular extemporâneo",
  "02": "Documento cancelado",
  "03": "Documento cancelado extemporâneo",
  "04": "Denegado",
  "05": "Numeração inutilizada",
  "06": "Documento regular emitido com base em Regime Especial",
  "07": "Documento regular ajustado",
  "08": "Documento extemporâneo emitido com base em Regime Especial",
  "09": "Documento extemporâneo ajustado",
};

/** Situações que não devem entrar em apuração (canceladas/denegadas/inutilizadas). */
const EXCLUDED_FROM_ASSESSMENT_CODES = new Set(["02", "03", "04", "05"]);

/** SPED registro C100 campo COD_MOD — tabela 4.1.1 (mapeamento parcial, só o que o enum InvoiceModel cobre). */
function mapCodModToInvoiceModel(codMod: string | undefined): InvoiceModel {
  switch (codMod) {
    case "55":
      return "NFE";
    case "65":
      return "NFCE";
    case "57":
      return "CTE";
    default:
      return "OUTRO";
  }
}

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

export function parseSpedEfd(
  buffer: Buffer,
  options: ParseSpedOptions = {},
): ExtractionResult {
  const warnings: string[] = [];
  const errors: string[] = [];
  const invoices: ParsedInvoice[] = [];
  const apuracoes: ParsedApuracao[] = [];

  const { text, encoding, forced } = decodeTextBuffer(buffer, options.encoding);
  warnings.push(
    `Codificação ${forced ? "informada" : "detectada"}: ${encoding}.`,
  );

  if (text.trim() === "") {
    errors.push("Arquivo vazio ou sem conteúdo legível.");
    return { parser: "sped-efd", invoices, warnings, errors, apuracoes };
  }

  const lines = text.split(/\r\n|\r|\n/);

  let identification: ParsedSpedIdentification | undefined;
  const participants = new Map<string, ParticipantRecord>();
  const products = new Map<string, ProductRecord>();

  let currentInvoice: ParsedInvoice | undefined;
  let pendingPeriod: { start?: Date; end?: Date } | undefined;
  let currentApuracao: ParsedApuracao | undefined;

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
          identification = {
            layoutVersion: f(2),
            purposeCode: f(3),
            periodStart: parseSpedDate(f(4)),
            periodEnd: parseSpedDate(f(5)),
            name: f(6),
            cnpj: onlyDigits(f(7)),
            cpf: onlyDigits(f(8)),
            uf: f(9),
            ie: f(10),
            municipalityCode: f(11),
            profile: f(14),
            activityIndicator: f(15),
          };
          if (identification.cnpj && identification.cnpj.length !== 14) {
            warnings.push(
              `Linha ${lineNo}: CNPJ do registro 0000 com ${identification.cnpj.length} dígitos (esperado 14) — mantido como veio.`,
            );
          }
          break;
        }

        case "0150": {
          const codPart = f(2);
          if (!codPart) throw new Error("0150 sem COD_PART — participante ignorado");
          participants.set(codPart, {
            name: f(3),
            cnpj: onlyDigits(f(5)),
            cpf: onlyDigits(f(6)),
            ie: f(7),
          });
          break;
        }

        case "0200": {
          const codItem = f(2);
          if (!codItem) throw new Error("0200 sem COD_ITEM — item ignorado");
          products.set(codItem, {
            description: f(3),
            ncm: f(8),
          });
          break;
        }

        case "C100": {
          if (currentInvoice) {
            invoices.push(currentInvoice);
            currentInvoice = undefined;
          }
          if (parts.length < 9) {
            throw new Error(
              `C100 com ${parts.length} campos (mínimo esperado 9, até CHV_NFE) — nota ignorada`,
            );
          }

          const indOper = f(2); // 0 entrada, 1 saída
          const indEmit = f(3); // 0 emissão própria, 1 terceiros
          const codPart = f(4);
          const codMod = f(5);
          const codSit = f(6);
          const chvNfe = f(9);

          if (chvNfe && !isValidAccessKey(chvNfe)) {
            warnings.push(
              `Linha ${lineNo}: chave de acesso "${chvNfe}" não passou na validação do dígito verificador — mantida como veio, não corrigida.`,
            );
          }

          const partner = codPart ? participants.get(codPart) : undefined;

          let emitCnpj: string | undefined;
          let emitName: string | undefined;
          let emitUf: string | undefined;
          let destDoc: string | undefined;
          let destName: string | undefined;
          let destUf: string | undefined;

          if (indEmit === "1") {
            // Documento de terceiros: o participante é o emitente; a própria empresa é a destinatária.
            emitCnpj = partner?.cnpj ?? partner?.cpf;
            emitName = partner?.name;
            destDoc = identification?.cnpj ?? identification?.cpf;
            destName = identification?.name;
            destUf = identification?.uf;
          } else {
            // Emissão própria (inclui indEmit ausente/desconhecido — tratado como próprio por padrão).
            emitCnpj = identification?.cnpj ?? identification?.cpf;
            emitName = identification?.name;
            emitUf = identification?.uf;
            destDoc = partner?.cnpj ?? partner?.cpf;
            destName = partner?.name;
          }

          const direction: InvoiceDirection =
            indOper === "1" ? "SAIDA" : "ENTRADA";
          const situationLabel = codSit ? SITUATION_LABELS[codSit] : undefined;

          const invoice: ParsedInvoice = {
            model: mapCodModToInvoiceModel(codMod),
            direction,
            accessKey: chvNfe,
            number: f(8),
            series: f(7),
            issueDate: parseSpedDate(f(10)),
            emitCnpj,
            emitName,
            emitUf,
            destDoc,
            destName,
            destUf,
            totalProducts: dec(f(16)), // VL_MERC
            totalInvoice: dec(f(12)), // VL_DOC
            totalIcms: dec(f(22)), // VL_ICMS
            totalIcmsSt: dec(f(24)), // VL_ICMS_ST
            totalIpi: dec(f(25)), // VL_IPI
            totalPis: dec(f(26)), // VL_PIS
            totalCofins: dec(f(27)), // VL_COFINS
            situationCode: codSit,
            situationLabel,
            items: [],
            analytics: [],
            raw: { codMod, codSit, indEmit, indOper, codPart },
          };

          if (codSit && EXCLUDED_FROM_ASSESSMENT_CODES.has(codSit)) {
            warnings.push(
              `Linha ${lineNo}: nota ${chvNfe ?? invoice.number ?? "(sem chave)"} com situação "${situationLabel}" (COD_SIT=${codSit}) — extraída e armazenada, mas NÃO deve entrar em apuração.`,
            );
          }
          if (!chvNfe && (codMod === "55" || codMod === "65" || codMod === "57")) {
            warnings.push(
              `Linha ${lineNo}: nota modelo ${codMod} sem chave de acesso (CHV_NFE).`,
            );
          }

          currentInvoice = invoice;
          break;
        }

        case "C170": {
          if (!currentInvoice) {
            throw new Error("C170 sem C100 aberto antes — item ignorado");
          }
          const codItem = f(3);
          const product = codItem ? products.get(codItem) : undefined;
          const item: ParsedInvoiceItem = {
            lineNumber: Number.parseInt(f(2) ?? "", 10) || 0,
            description: f(4) ?? product?.description,
            ncm: product?.ncm,
            cfop: f(11),
            cstCsosn: f(10),
            quantity: dec(f(5)),
            totalValue: dec(f(7)), // VL_ITEM
            icmsBase: dec(f(13)),
            icmsValue: dec(f(15)),
            icmsStValue: dec(f(18)),
            ipiValue: dec(f(24)),
            /**
             * CST de PIS (campo 25) e de COFINS (campo 31) do C170.
             *
             * Sem eles não há como saber se a entrada dá direito a crédito: CST
             * 04 (monofásico), 05 (ST), 06 (alíquota zero), 07 (isento), 08 (sem
             * incidência) e 09 (suspensão) não geram crédito algum. Enquanto
             * esses campos ficavam de fora, a regra de crédito indevido nunca
             * disparava sobre dados de SPED — falso negativo silencioso, que só
             * apareceu quando um cliente real perguntou por um exemplo que o
             * sistema deveria ter encontrado.
             *
             * Posições conferidas campo a campo num SPED real (jan/2026).
             */
            cstPis: f(25),
            pisValue: dec(f(30)),
            cstCofins: f(31),
            cofinsValue: dec(f(36)),
            ufOrigin: currentInvoice.emitUf,
            ufDestination: currentInvoice.destUf,
          };
          currentInvoice.items.push(item);
          break;
        }

        case "C190": {
          if (!currentInvoice) {
            throw new Error("C190 sem C100 aberto antes — analítico ignorado");
          }
          const analytic: ParsedInvoiceAnalytic = {
            cstIcms: f(2),
            cfop: f(3),
            icmsRate: dec(f(4)),
            operationValue: dec(f(5)),
            icmsBase: dec(f(6)),
            icmsValue: dec(f(7)),
            icmsStBase: dec(f(8)),
            icmsStValue: dec(f(9)),
            baseReductionValue: dec(f(10)),
            ipiValue: dec(f(11)),
            observationCode: f(12),
          };
          (currentInvoice.analytics ??= []).push(analytic);
          break;
        }

        case "E100": {
          if (currentApuracao) {
            apuracoes.push(currentApuracao);
            currentApuracao = undefined;
          }
          pendingPeriod = { start: parseSpedDate(f(2)), end: parseSpedDate(f(3)) };
          break;
        }

        case "E110": {
          if (currentApuracao) {
            apuracoes.push(currentApuracao);
          }
          currentApuracao = {
            periodStart: pendingPeriod?.start,
            periodEnd: pendingPeriod?.end,
            totalDebits: dec(f(2)),
            debitAdjustments: dec(f(3)),
            totalDebitAdjustments: dec(f(4)),
            creditReversals: dec(f(5)),
            totalCredits: dec(f(6)),
            creditAdjustments: dec(f(7)),
            totalCreditAdjustments: dec(f(8)),
            debitReversals: dec(f(9)),
            previousCreditBalance: dec(f(10)),
            assessedBalance: dec(f(11)), // VL_SLD_APURADO — origem da média do PROGOIÁS
            totalDeductions: dec(f(12)),
            icmsToPay: dec(f(13)),
            creditBalanceToCarry: dec(f(14)),
            specialDebitCode: f(15),
            adjustments: [],
            additionalInfo: [],
          };
          break;
        }

        case "E111": {
          if (!currentApuracao) {
            throw new Error("E111 sem E110 aberto antes — ajuste ignorado");
          }
          const adj: ParsedApuracaoAjuste = {
            code: f(2),
            complementaryDescription: f(3),
            value: dec(f(4)),
          };
          currentApuracao.adjustments.push(adj);
          break;
        }

        case "E115": {
          if (!currentApuracao) {
            throw new Error("E115 sem E110 aberto antes — informação adicional ignorada");
          }
          const info: ParsedApuracaoInfoAdicional = {
            code: f(2),
            value: dec(f(3)),
            complementaryDescription: f(4),
          };
          currentApuracao.additionalInfo.push(info);
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
  if (currentInvoice) invoices.push(currentInvoice);
  if (currentApuracao) apuracoes.push(currentApuracao);

  if (!identification) {
    warnings.push(
      "Registro 0000 não encontrado — identificação do arquivo (CNPJ, período, UF) indisponível.",
    );
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
    parser: "sped-efd",
    invoices,
    warnings,
    errors,
    apuracoes,
    identification,
  };
}

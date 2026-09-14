import { XMLParser } from "fast-xml-parser";
import { dec, type Money } from "@/server/tax/decimal";
import type {
  ExtractionResult,
  ParsedInvoice,
  ParsedInvoiceItem,
  ParsedEventoNfe,
  ContextoExtracao,
} from "./types";

/**
 * Parser de XML de NF-e (modelo 55) e NFC-e (modelo 65).
 *
 * Cobre os layouts mais comuns:
 *  - nfeProc > NFe > infNFe  (nota autorizada)
 *  - NFe > infNFe            (nota sem protocolo)
 *
 * Extrai emitente, destinatário, chave, totais e, por item:
 * NCM, CEST, CFOP, CST/CSOSN, quantidades, valores e tributos
 * (ICMS, ICMS-ST, FCP, DIFAL, IPI, PIS, COFINS).
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false, // mantém como string; convertemos com num()
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

/**
 * Converte valor monetário/quantitativo do XML em Decimal.
 *
 * O XMLParser está com `parseTagValue: false`, então o valor chega como string
 * e vai direto para Decimal — nunca passa por float. É o que preserva o centavo.
 */
const num = dec;

/** Índice de linha (nItem). Não é grandeza monetária — inteiro serve. */
function intOrZero(v: unknown): number {
  const n = Number.parseInt(String(v ?? "0"), 10);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

/** Garante array (fast-xml-parser retorna objeto único quando há 1 elemento). */
function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Extrai o grupo de ICMS (polimórfico: ICMS00, ICMSSN101, etc.). */
function extractIcms(imposto: Record<string, unknown> | undefined) {
  const out = {
    cst: undefined as string | undefined,
    base: undefined as Money | undefined,
    icms: undefined as Money | undefined,
    icmsSt: undefined as Money | undefined,
    fcp: undefined as Money | undefined,
    orig: undefined as string | undefined,
  };
  const icms = imposto?.ICMS as Record<string, unknown> | undefined;
  if (!icms) return out;
  // Pega o primeiro (e único) subgrupo, ex. ICMS00 / ICMSSN102.
  const groupKey = Object.keys(icms)[0];
  const g = icms[groupKey] as Record<string, unknown> | undefined;
  if (!g) return out;
  out.orig = str(g.orig);
  out.cst = str(g.CST) ?? str(g.CSOSN);
  out.base = num(g.vBC);
  out.icms = num(g.vICMS);
  out.icmsSt = num(g.vICMSST) ?? num(g.vST);
  out.fcp = num(g.vFCP) ?? num(g.vFCPST);
  return out;
}

function extractItem(det: Record<string, unknown>): ParsedInvoiceItem {
  const prod = (det.prod ?? {}) as Record<string, unknown>;
  const imposto = det.imposto as Record<string, unknown> | undefined;
  const icms = extractIcms(imposto);

  const ipi = imposto?.IPI as Record<string, unknown> | undefined;
  const ipiTrib = ipi?.IPITrib as Record<string, unknown> | undefined;
  // PIS e Cofins são polimórficos como o ICMS. `PISNT` (não tributado) e
  // `PISSN`/`COFINSSN` não têm valor, mas TÊM CST — e é justamente o CST que
  // decide o crédito. Ignorar esses grupos faria item monofásico e de alíquota
  // zero passarem como creditáveis.
  const pis = imposto?.PIS as Record<string, unknown> | undefined;
  const pisGroup = (pis?.PISAliq ?? pis?.PISQtde ?? pis?.PISNT ?? pis?.PISOutr) as
    | Record<string, unknown>
    | undefined;
  const cofins = imposto?.COFINS as Record<string, unknown> | undefined;
  const cofinsGroup = (cofins?.COFINSAliq ??
    cofins?.COFINSQtde ??
    cofins?.COFINSNT ??
    cofins?.COFINSOutr) as Record<string, unknown> | undefined;
  const difal = imposto?.ICMSUFDest as Record<string, unknown> | undefined;

  return {
    lineNumber: intOrZero(det["@_nItem"]),
    description: str(prod.xProd),
    ncm: str(prod.NCM),
    cest: str(prod.CEST),
    cfop: str(prod.CFOP),
    cstCsosn: icms.cst,
    quantity: num(prod.qCom),
    unitValue: num(prod.vUnCom),
    totalValue: num(prod.vProd),
    icmsBase: icms.base,
    icmsValue: icms.icms,
    icmsStValue: icms.icmsSt,
    fcpValue: icms.fcp,
    difalValue: num(difal?.vICMSUFDest),
    ipiValue: num(ipiTrib?.vIPI),
    pisValue: num(pisGroup?.vPIS),
    cofinsValue: num(cofinsGroup?.vCOFINS),
    cstPis: str(pisGroup?.CST),
    cstCofins: str(cofinsGroup?.CST),
    origem: icms.orig,
    ufOrigin: undefined, // preenchido no nível da nota
    ufDestination: undefined,
  };
}

/** Só os dígitos — CNPJ vem com máscara em muitos lugares. */
export function soDigitos(v: string | undefined | null): string {
  return (v ?? "").replace(/\D+/g, "");
}

/**
 * Código do evento de CANCELAMENTO da NF-e.
 * Manual de Orientação do Contribuinte, evento 110111.
 */
export const EVENTO_CANCELAMENTO = "110111";

/**
 * Lê um `procEventoNFe` — cancelamento, carta de correção ou manifestação do
 * destinatário.
 *
 * Esses arquivos vêm MISTURADOS com as notas dentro do pacote baixado do
 * portal. Sem reconhecê-los, cada evento viraria um "XML que não é NF-e" e o
 * cancelamento passaria despercebido — nota cancelada continuaria contando
 * como receita.
 *
 * Devolve `null` quando o XML não é um evento.
 */
export function parseNfeEvento(xml: string): ParsedEventoNfe | null {
  let root: Record<string, unknown>;
  try {
    root = parser.parse(xml) as Record<string, unknown>;
  } catch {
    return null;
  }

  const proc = root.procEventoNFe as Record<string, unknown> | undefined;
  const eventoNode = (proc?.evento ?? root.evento) as
    | Record<string, unknown>
    | undefined;
  const inf = eventoNode?.infEvento as Record<string, unknown> | undefined;
  if (!inf) return null;

  const accessKey = soDigitos(str(inf.chNFe));
  if (accessKey.length !== 44) return null;

  const tipoEvento = str(inf.tpEvento) ?? "";
  const det = inf.detEvento as Record<string, unknown> | undefined;

  // O protocolo de registro fica no retorno, fora do infEvento.
  const retorno = proc?.retEvento as Record<string, unknown> | undefined;
  const infRet = retorno?.infEvento as Record<string, unknown> | undefined;

  const dataRaw = str(inf.dhEvento);
  const dataEvento = dataRaw ? new Date(dataRaw) : undefined;

  return {
    accessKey,
    tipoEvento,
    descricaoEvento: str(det?.descEvento),
    dataEvento:
      dataEvento && !Number.isNaN(dataEvento.getTime()) ? dataEvento : undefined,
    sequencia: inf.nSeqEvento ? intOrZero(inf.nSeqEvento) : undefined,
    autorDoc: str(inf.CNPJ) ?? str(inf.CPF),
    protocolo: str(infRet?.nProt),
    cancelaNota: tipoEvento === EVENTO_CANCELAMENTO,
  };
}

/**
 * Decide se a nota é ENTRADA ou SAÍDA **para a empresa do projeto**.
 *
 * O XML não traz essa informação: ele é o mesmo documento para as duas pontas.
 * O que decide é quem a empresa é dentro da nota.
 *
 *   empresa é a EMITENTE     → `tpNF` manda (1 = saída, 0 = entrada, caso de
 *                              devolução ou retorno emitido pela própria empresa)
 *   empresa é a DESTINATÁRIA → ENTRADA
 *
 * Sem o CNPJ da empresa, cai no palpite que veio do tipo do documento — e isso
 * fica declarado como alerta, porque um pacote com nota de compra e de venda
 * misturadas seria classificado inteiro para o mesmo lado.
 */
function decidirDirecao(
  emitCnpj: string | undefined,
  destDoc: string | undefined,
  tpNF: string | undefined,
  fallback: "ENTRADA" | "SAIDA",
  contexto: ContextoExtracao | undefined,
): { direction: "ENTRADA" | "SAIDA"; alerta?: string } {
  const empresa = soDigitos(contexto?.cnpjEmpresa);
  if (!empresa) {
    return {
      direction: fallback,
      alerta:
        "Direção (entrada/saída) assumida do tipo informado no envio: o CNPJ da " +
        "empresa do projeto não foi informado ao leitor. Confira, porque um " +
        "pacote com compras e vendas juntas ficaria todo do mesmo lado.",
    };
  }

  const emit = soDigitos(emitCnpj);
  const dest = soDigitos(destDoc);

  if (emit && emit === empresa) {
    // tpNF: 0 = entrada, 1 = saída (perspectiva do emitente).
    return { direction: tpNF === "0" ? "ENTRADA" : "SAIDA" };
  }
  if (dest && dest === empresa) {
    return { direction: "ENTRADA" };
  }

  return {
    direction: fallback,
    alerta:
      `Nota em que a empresa do projeto (CNPJ ${empresa}) não é emitente ` +
      `(${emit || "—"}) nem destinatária (${dest || "—"}). Direção assumida como ` +
      `${fallback}. Confira se o arquivo pertence mesmo a este projeto.`,
  };
}

/**
 * @param xml conteúdo do arquivo XML.
 * @param direction palpite de direção, usado só quando o CNPJ não resolve.
 * @param contexto CNPJ da empresa do projeto — é o que decide a direção.
 */
export function parseNfeXml(
  xml: string,
  direction: "ENTRADA" | "SAIDA",
  contexto?: ContextoExtracao,
): ExtractionResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  let root: Record<string, unknown>;
  try {
    root = parser.parse(xml) as Record<string, unknown>;
  } catch (e) {
    return {
      parser: "nfe-xml",
      invoices: [],
      warnings,
      errors: [`XML inválido: ${(e as Error).message}`],
      apuracoes: [],
    };
  }

  // Localiza infNFe em qualquer um dos layouts.
  const nfeProc = root.nfeProc as Record<string, unknown> | undefined;
  const nfeNode = (nfeProc?.NFe ?? root.NFe) as
    | Record<string, unknown>
    | undefined;
  const infNFe = nfeNode?.infNFe as Record<string, unknown> | undefined;

  if (!infNFe) {
    // Antes de reclamar, verifica se é um EVENTO — cancelamento, carta de
    // correção ou manifestação vêm no mesmo pacote e não têm infNFe.
    const evento = parseNfeEvento(xml);
    if (evento) {
      return {
        parser: "nfe-evento",
        invoices: [],
        warnings,
        errors: [],
        apuracoes: [],
        eventos: [evento],
      };
    }
    return {
      parser: "nfe-xml",
      invoices: [],
      warnings,
      errors: ["Não foi possível localizar infNFe. O arquivo é uma NF-e/NFC-e?"],
      apuracoes: [],
    };
  }

  const ide = (infNFe.ide ?? {}) as Record<string, unknown>;
  const emit = (infNFe.emit ?? {}) as Record<string, unknown>;
  const dest = (infNFe.dest ?? {}) as Record<string, unknown>;
  const enderEmit = (emit.enderEmit ?? {}) as Record<string, unknown>;
  const enderDest = (dest.enderDest ?? {}) as Record<string, unknown>;
  const total = (infNFe.total ?? {}) as Record<string, unknown>;
  const icmsTot = (total.ICMSTot ?? {}) as Record<string, unknown>;

  const mod = str(ide.mod);
  const model = mod === "65" ? "NFCE" : "NFE";

  // Chave de acesso vem no atributo Id: "NFe" + 44 dígitos.
  const rawId = str(infNFe["@_Id"]) ?? "";
  const accessKey = rawId.replace(/^NFe/i, "") || undefined;

  // Data de emissão (dhEmi novo, dEmi antigo).
  const issueRaw = str(ide.dhEmi) ?? str(ide.dEmi);
  const issueDate = issueRaw ? new Date(issueRaw) : undefined;

  const emitUf = str(enderEmit.UF);
  const destUf = str(enderDest.UF);

  // det vem como objeto único (1 item) ou array (vários) — a asserção precisa cobrir os dois.
  const dets = asArray<Record<string, unknown>>(
    infNFe.det as Record<string, unknown> | Record<string, unknown>[] | undefined,
  );
  if (dets.length === 0) warnings.push("Nota sem itens (det).");

  const items: ParsedInvoiceItem[] = dets.map((d) => {
    const it = extractItem(d);
    it.ufOrigin = emitUf;
    it.ufDestination = destUf;
    return it;
  });

  const emitCnpj = str(emit.CNPJ) ?? str(emit.CPF);
  const destDoc = str(dest.CNPJ) ?? str(dest.CPF) ?? str(dest.idEstrangeiro);

  const decisao = decidirDirecao(
    emitCnpj,
    destDoc,
    str(ide.tpNF),
    direction,
    contexto,
  );
  if (decisao.alerta) warnings.push(decisao.alerta);

  const invoice: ParsedInvoice = {
    model: model as ParsedInvoice["model"],
    direction: decisao.direction as ParsedInvoice["direction"],
    accessKey,
    number: str(ide.nNF),
    series: str(ide.serie),
    issueDate: issueDate && !isNaN(issueDate.getTime()) ? issueDate : undefined,
    emitCnpj,
    emitName: str(emit.xNome),
    emitUf,
    destDoc,
    destName: str(dest.xNome),
    destUf,
    totalProducts: num(icmsTot.vProd),
    totalInvoice: num(icmsTot.vNF),
    totalIcms: num(icmsTot.vICMS),
    totalIcmsSt: num(icmsTot.vST) ?? num(icmsTot.vICMSST),
    totalIpi: num(icmsTot.vIPI),
    totalPis: num(icmsTot.vPIS),
    totalCofins: num(icmsTot.vCOFINS),
    totalFcp: num(icmsTot.vFCP),
    items,
  };

  if (!accessKey) warnings.push("Chave de acesso ausente.");
  if (!invoice.emitCnpj) warnings.push("CNPJ do emitente ausente.");

  return { parser: "nfe-xml", invoices: [invoice], warnings, errors, apuracoes: [] };
}

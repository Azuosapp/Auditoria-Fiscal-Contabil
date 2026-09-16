import type { InvoiceModel, InvoiceDirection } from "./tipos-prisma";
import type { Money } from "@/server/tax/decimal";

/**
 * Item normalizado extraído de uma nota.
 *
 * Valor e quantidade são `Money` (Decimal), nunca `number`: o XML traz string,
 * e converter para float no meio do caminho perde precisão antes de chegar ao banco.
 * `lineNumber` continua `number` porque é índice, não grandeza monetária.
 */
export interface ParsedInvoiceItem {
  lineNumber: number;
  /** Código do item no cadastro do emitente (XML cProd; SPED COD_ITEM). */
  code?: string;
  /** Alíquota de ICMS aplicada ao item, em percentual (pICMS / ALIQ_ICMS). */
  icmsRate?: Money;
  /** Alíquotas de PIS e COFINS destacadas no item, em percentual. */
  pisRate?: Money;
  cofinsRate?: Money;
  /** Grupo IBS/CBS presente no item (Reforma Tributária, NT 2025.002). */
  hasIbsCbs?: boolean;
  description?: string;
  ncm?: string;
  cest?: string;
  cfop?: string;
  cstCsosn?: string;
  quantity?: Money;
  unitValue?: Money;
  totalValue?: Money;
  icmsBase?: Money;
  icmsValue?: Money;
  icmsStValue?: Money;
  fcpValue?: Money;
  difalValue?: Money;
  ipiValue?: Money;
  pisValue?: Money;
  cofinsValue?: Money;
  /**
   * CST de PIS e de Cofins do item (tabelas 4.3.3 e 4.3.4 do leiaute da NF-e).
   *
   * Numa nota de ENTRADA, esses códigos são os que o FORNECEDOR aplicou na saída
   * dele — e é o que decide se a compra gera crédito no regime não cumulativo.
   * Item monofásico (CST 04), de alíquota zero (06), isento (07) ou de fornecedor
   * optante do Simples não gera crédito algum. Sem ler esses códigos, a base de
   * crédito vira "tudo o que entrou", o que superestima o Lucro Real.
   */
  cstPis?: string;
  cstCofins?: string;
  /** Origem da mercadoria (tabela A do CST de ICMS): 0 nacional, 1 a 8 importada. */
  origem?: string;
  ufOrigin?: string;
  ufDestination?: string;
}

/**
 * Registro analítico por CST/CFOP/alíquota associado a uma nota (SPED registro
 * C190). Não existe em XML de NF-e — fica vazio/ausente nesses parsers.
 */
export interface ParsedInvoiceAnalytic {
  cstIcms?: string;
  cfop?: string;
  icmsRate?: Money;
  operationValue?: Money;
  icmsBase?: Money;
  icmsValue?: Money;
  icmsStBase?: Money;
  icmsStValue?: Money;
  baseReductionValue?: Money;
  ipiValue?: Money;
  observationCode?: string;
}

/** Nota fiscal normalizada, independente do layout de origem. */
export interface ParsedInvoice {
  model: InvoiceModel;
  direction: InvoiceDirection;
  accessKey?: string;
  number?: string;
  series?: string;
  issueDate?: Date;
  emitCnpj?: string;
  emitName?: string;
  emitUf?: string;
  destDoc?: string;
  destName?: string;
  destUf?: string;
  totalProducts?: Money;
  totalInvoice?: Money;
  totalIcms?: Money;
  totalIcmsSt?: Money;
  totalIpi?: Money;
  totalPis?: Money;
  totalCofins?: Money;
  totalFcp?: Money;
  /** indIEDest: 1 contribuinte, 2 isento, 9 não contribuinte. */
  destIeIndicator?: string;
  /** indFinal: operação com consumidor final. */
  finalConsumer?: boolean;
  items: ParsedInvoiceItem[];
  /**
   * Situação do documento fiscal (SPED registro C100 campo COD_SIT / tabela
   * 4.1.2). Nota cancelada, denegada ou com numeração inutilizada é extraída e
   * guardada, mas NÃO deve entrar em apuração — quem consome este campo decide
   * a exclusão; o parser não descarta o registro.
   */
  situationCode?: string;
  situationLabel?: string;
  /** Registros C190 (analítico por CST/CFOP/alíquota) da nota, quando houver. */
  analytics?: ParsedInvoiceAnalytic[];
  raw?: unknown;
}

/**
 * Ajuste da apuração do ICMS (SPED registro E111 — tabela 5.3 de códigos de
 * ajuste, publicada por UF).
 */
export interface ParsedApuracaoAjuste {
  code?: string;
  complementaryDescription?: string;
  value?: Money;
}

/**
 * Informação adicional declaratória da apuração (SPED registro E115 — tabela
 * 5.4, publicada por UF). É onde vivem os códigos GO0200xx que a média do
 * PROGOIÁS usa (ver src/server/tax/calc/progoias.ts).
 */
export interface ParsedApuracaoInfoAdicional {
  code?: string;
  value?: Money;
  complementaryDescription?: string;
}

/**
 * Apuração do ICMS de um período (SPED registros E100/E110/E111/E115).
 * Não é nota fiscal — por isso vive em campo próprio no resultado da
 * extração, e não dentro de `invoices`.
 */
export interface ParsedApuracao {
  periodStart?: Date;
  periodEnd?: Date;

  /** Campo 02 — VL_TOT_DEBITOS. */
  totalDebits?: Money;
  /** Campo 03 — VL_AJ_DEBITOS. */
  debitAdjustments?: Money;
  /** Campo 04 — VL_TOT_AJ_DEBITOS. */
  totalDebitAdjustments?: Money;
  /** Campo 05 — VL_ESTORNOS_CRED. */
  creditReversals?: Money;
  /** Campo 06 — VL_TOT_CREDITOS. */
  totalCredits?: Money;
  /** Campo 07 — VL_AJ_CREDITOS. */
  creditAdjustments?: Money;
  /** Campo 08 — VL_TOT_AJ_CREDITOS. */
  totalCreditAdjustments?: Money;
  /** Campo 09 — VL_ESTORNOS_DEB. */
  debitReversals?: Money;
  /** Campo 10 — VL_SLD_CREDOR_ANT. */
  previousCreditBalance?: Money;
  /**
   * Campo 11 — VL_SLD_APURADO. Origem da média do PROGOIÁS
   * (Decreto nº 9.724/2020, art. 9º; ver progoias.ts, `calcularMedia`).
   */
  assessedBalance?: Money;
  /** Campo 12 — VL_TOT_DED. */
  totalDeductions?: Money;
  /** Campo 13 — VL_ICMS_RECOLHER. */
  icmsToPay?: Money;
  /** Campo 14 — VL_SLD_CREDOR_TRANSPORTAR. */
  creditBalanceToCarry?: Money;
  /** Campo 15 — DEB_ESP (código, não é grandeza monetária). */
  specialDebitCode?: string;

  adjustments: ParsedApuracaoAjuste[];
  additionalInfo: ParsedApuracaoInfoAdicional[];
}

/** Identificação da entidade e do período do arquivo (SPED registro 0000). */
export interface ParsedSpedIdentification {
  layoutVersion?: string;
  purposeCode?: string;
  periodStart?: Date;
  periodEnd?: Date;
  name?: string;
  cnpj?: string;
  cpf?: string;
  uf?: string;
  ie?: string;
  municipalityCode?: string;
  profile?: string;
  activityIndicator?: string;
}

/**
 * Evento de NF-e (`procEventoNFe`).
 *
 * NÃO é nota fiscal: é um documento à parte que se refere a uma nota pela chave
 * de acesso. Cancelamento, carta de correção e manifestação do destinatário
 * chegam assim — e vêm no MESMO pacote das notas, misturados.
 *
 * Tratar evento como nota inflaria o faturamento; ignorá-lo faria nota
 * cancelada continuar contando como receita. Por isso ele tem tipo próprio.
 */
export interface ParsedEventoNfe {
  /** Chave da NF-e a que o evento se refere. */
  accessKey: string;
  /** Código do evento (110111 cancelamento, 110110 carta de correção, ...). */
  tipoEvento: string;
  descricaoEvento?: string;
  dataEvento?: Date;
  sequencia?: number;
  /** CNPJ/CPF de quem registrou o evento. */
  autorDoc?: string;
  protocolo?: string;
  /** O evento cancela a nota? Só o 110111 cancela. */
  cancelaNota: boolean;
}

/**
 * Contexto do projeto, para o parser decidir o que não está no arquivo.
 *
 * O caso concreto: um XML de NF-e não diz se, para ESTA empresa, ele é entrada
 * ou saída — isso depende de a empresa ser a emitente ou a destinatária. Sem o
 * CNPJ da empresa, a direção viraria chute pelo nome do arquivo.
 */
export interface ContextoExtracao {
  /** CNPJ da empresa do projeto, só dígitos. */
  cnpjEmpresa?: string;
}

/** Resultado de um parser: notas + alertas de qualidade. */
export interface ExtractionResult {
  parser: string;
  invoices: ParsedInvoice[];
  warnings: string[];
  errors: string[];
  /** Apurações de ICMS extraídas (Bloco E do SPED). Vazio quando não se aplica. */
  apuracoes: ParsedApuracao[];
  /** Identificação do arquivo (registro 0000 do SPED). Ausente para XML. */
  identification?: ParsedSpedIdentification;
  /** Eventos de NF-e encontrados (cancelamento, carta de correção, manifestação). */
  eventos?: ParsedEventoNfe[];
  /** DIFAL/FCP por UF de destino (E300/E310 do SPED Fiscal). */
  difal?: ParsedDifal[];
  /** Apuração do IPI por período (E500/E520). */
  apuracoesIpi?: ParsedApuracaoIpi[];
  /** Inventário (H005 e soma dos H010). */
  inventarios?: ParsedInventario[];
  /** Bloco K: COM_DADOS, SEM_DADOS (K001 = 1) ou AUSENTE. */
  blocoK?: "COM_DADOS" | "SEM_DADOS" | "AUSENTE";
  /** Data da assinatura digital do arquivo (signingTime do PKCS#7), em UTC. */
  dataAssinatura?: Date;
  /** Quantos arquivos foram lidos, quando a origem é um pacote (.zip). */
  arquivosLidos?: number;
}

export interface ParsedDifal {
  uf: string;
  periodStart?: Date;
  periodEnd?: Date;
  /** E310 campo 04 — VL_TOT_DEBITOS_DIFAL */
  totalDebitos?: Money;
  /** E310 campo 06 — VL_TOT_CREDITOS_DIFAL */
  totalCreditos?: Money;
  /** E310 campo 10 — VL_RECOL_DIFAL */
  aRecolher?: Money;
}

/** Apuração do IPI (E500/E520 do SPED Fiscal). */
export interface ParsedApuracaoIpi {
  periodStart?: Date;
  periodEnd?: Date;
  /** E520 campo 03 — VL_DEB_IPI */
  debitos?: Money;
  /** E520 campo 04 — VL_CRED_IPI */
  creditos?: Money;
  /** E520 campo 07 — VL_SC_IPI, saldo credor a transportar */
  saldoCredor?: Money;
  /** E520 campo 08 — VL_SD_IPI, saldo devedor a recolher */
  aRecolher?: Money;
}

export interface ParsedInventario {
  /** H005 DT_INV */
  data?: Date;
  /** H005 VL_INV */
  valor?: Money;
  /** H005 MOT_INV — 01 final do período, 02 mudança de tributação, ... */
  motivo?: string;
  /** Soma de VL_ITEM dos H010 do inventário. */
  somaItens?: Money;
  itens: number;
}

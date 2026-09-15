import type { Severidade } from "@prisma/client";
import type { TipoDocumento } from "@prisma/client";

/**
 * Catálogo de achados — a definição declarativa de tudo que a auditoria procura.
 * Documentação de referência: docs/CATALOGO_ACHADOS.md
 *
 * Este arquivo é só o CADASTRO: o que cada achado é, o que exige e quanto pesa.
 * A detecção mora em `regras/`, uma função por família, e cada função devolve
 * achados carimbados com o código daqui.
 *
 * Separar as duas coisas permite:
 *   - a tela de "o que falta importar" ser gerada a partir de `fontesNecessarias`;
 *   - o relatório declarar a lacuna (qual achado não pôde ser avaliado e por quê);
 *   - testar a regra sem carregar o catálogo inteiro.
 */

export type FamiliaAchado =
  | "DIVERGENCIA_PAGAMENTO"
  | "RECEITA"
  | "CREDITO"
  | "REGIME"
  | "ICMS_OPERACIONAL"
  | "CONTABIL"
  | "ACESSORIA";

export interface DefinicaoAchado {
  codigo: string;
  titulo: string;
  familia: FamiliaAchado;
  severidade: Severidade;
  /** Tributo afetado; `null` quando o achado é transversal. */
  tributo: string | null;
  /** Sem TODOS estes documentos, o achado não pode ser avaliado — vira Lacuna. */
  fontesNecessarias: TipoDocumento[];
  /** Fontes que elevam a confiança de MEDIA para ALTA quando presentes. */
  fontesQueConfirmam?: TipoDocumento[];
  descricao: string;
  baseLegal: string[];
  /** Frase-modelo da apresentação ao cliente. `{valor}` e `{competencia}` são trocados. */
  textoCliente: string;
}

/**
 * Família A — apurado × confessado × pago.
 *
 * ATENÇÃO AO FALSO POSITIVO: compensação (PER/DCOMP), retenção na fonte, saldo credor
 * de período anterior e parcelamento quitam o débito SEM DARF correspondente. As regras
 * desta família descontam as quatro hipóteses antes de acusar. Quando o documento que
 * comprovaria a vinculação não foi importado, o achado sai com confiança MEDIA e
 * ressalva explícita — nunca como certeza.
 */
const FAMILIA_A: DefinicaoAchado[] = [
  {
    codigo: "A01",
    titulo: "ICMS declarado no SPED Fiscal e não recolhido",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "ICMS",
    fontesNecessarias: ["SPED_FISCAL", "COMPROVANTE_ARRECADACAO"],
    descricao:
      "O registro E110 aponta ICMS a recolher sem arrecadação correspondente na competência.",
    baseLegal: ["CTN, art. 142", "LC 87/1996, art. 24"],
    textoCliente:
      "A empresa declarou ao fisco estadual {valor} de ICMS em {competencia} e não há recolhimento correspondente. O valor permanece exigível e sujeito a multa e juros.",
  },
  {
    codigo: "A02",
    titulo: "PIS declarado na EFD-Contribuições e não recolhido",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "PIS",
    fontesNecessarias: ["SPED_CONTRIBUICOES", "COMPROVANTE_ARRECADACAO"],
    fontesQueConfirmam: ["DCTF", "SITUACAO_FISCAL"],
    descricao: "Registro M200 com valor a recolher sem DARF correspondente.",
    baseLegal: ["Lei nº 10.637/2002", "Lei nº 9.718/1998"],
    textoCliente:
      "Há {valor} de PIS apurado em {competencia} sem pagamento localizado.",
  },
  {
    codigo: "A03",
    titulo: "COFINS declarada na EFD-Contribuições e não recolhida",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "COFINS",
    fontesNecessarias: ["SPED_CONTRIBUICOES", "COMPROVANTE_ARRECADACAO"],
    fontesQueConfirmam: ["DCTF", "SITUACAO_FISCAL"],
    descricao: "Registro M600 com valor a recolher sem DARF correspondente.",
    baseLegal: ["Lei nº 10.833/2003", "Lei nº 9.718/1998"],
    textoCliente:
      "Há {valor} de COFINS apurada em {competencia} sem pagamento localizado.",
  },
  {
    codigo: "A04",
    titulo: "IRPJ/CSLL apurado na ECF e não confessado em DCTF",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "IRPJ_CSLL",
    fontesNecessarias: ["ECF", "DCTF"],
    descricao:
      "A ECF apura tributo que a DCTF do mesmo período não confessa — divergência entre duas declarações da própria empresa.",
    baseLegal: ["Lei nº 9.430/1996", "IN RFB nº 1.700/2017"],
    textoCliente:
      "A ECF informa {valor} de tributo apurado em {competencia} que não aparece na DCTF. Divergência entre declarações é cruzamento automático da Receita.",
  },
  {
    codigo: "A05",
    titulo: "Tributo federal confessado e não pago",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "FEDERAL",
    fontesNecessarias: ["DCTF", "COMPROVANTE_ARRECADACAO"],
    fontesQueConfirmam: ["SITUACAO_FISCAL"],
    descricao:
      "Débito confessado em DCTF sem pagamento, compensação, parcelamento ou suspensão que o quite.",
    baseLegal: ["DL nº 2.124/1984, art. 5º, § 1º", "CTN, art. 150"],
    textoCliente:
      "A empresa confessou {valor} em {competencia} e não quitou. Confissão em DCTF é título executivo: a Receita inscreve em dívida ativa sem precisar autuar.",
  },
  {
    codigo: "A06",
    titulo: "DAS do Simples declarado e não pago",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "SIMPLES",
    fontesNecessarias: ["PGDAS", "COMPROVANTE_ARRECADACAO"],
    descricao: "PGDAS-D apurado sem DAS quitado na competência.",
    baseLegal: ["LC nº 123/2006, art. 21"],
    textoCliente:
      "Há {valor} de DAS apurado em {competencia} sem pagamento. O débito impede a certidão negativa e pode gerar exclusão do Simples.",
  },
  {
    codigo: "A07",
    titulo: "Contribuição previdenciária confessada e não paga",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "INSS",
    fontesNecessarias: ["DCTFWEB", "COMPROVANTE_ARRECADACAO"],
    fontesQueConfirmam: ["ESOCIAL"],
    descricao: "DCTFWeb com débito previdenciário sem arrecadação correspondente.",
    baseLegal: ["Lei nº 8.212/1991", "IN RFB nº 2.110/2022"],
    textoCliente:
      "Há {valor} de contribuição previdenciária confessada em {competencia} sem recolhimento. Débito previdenciário tem consequência pessoal para o administrador.",
  },
  {
    codigo: "A08",
    titulo: "Débito em aberto que o cliente desconhece",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: null,
    fontesNecessarias: ["SITUACAO_FISCAL"],
    descricao:
      "Pendência registrada no Relatório de Situação Fiscal do e-CAC: débito, omissão de declaração, malha ou inscrição em dívida ativa.",
    baseLegal: ["Lei nº 6.830/1980", "CTN, art. 201"],
    textoCliente:
      "O relatório de situação fiscal da própria Receita registra {valor} em aberto. Isso bloqueia certidão negativa, crédito bancário e participação em licitação.",
  },
];

/** Família B — receita e omissão. */
const FAMILIA_B: DefinicaoAchado[] = [
  {
    codigo: "B01",
    titulo: "NF-e autorizada e não escriturada",
    familia: "RECEITA",
    severidade: "CRITICO",
    tributo: "ICMS",
    fontesNecessarias: ["NFE_XML", "SPED_FISCAL"],
    descricao:
      "Chave de acesso autorizada pela SEFAZ sem registro C100 correspondente no SPED Fiscal.",
    baseLegal: ["RCTE-GO, art. 308", "CTN, art. 149"],
    textoCliente:
      "Foram localizadas notas autorizadas e não escrituradas em {competencia}, somando {valor}. Para o fisco, nota emitida e não escriturada é omissão de receita.",
  },
  {
    codigo: "B02",
    titulo: "NF-e escriturada com valor divergente do XML",
    familia: "RECEITA",
    severidade: "ALTO",
    tributo: "ICMS",
    fontesNecessarias: ["NFE_XML", "SPED_FISCAL"],
    descricao: "Valor total do C100 diverge do valor do XML autorizado.",
    baseLegal: ["RCTE-GO, art. 308"],
    textoCliente:
      "Há divergência de {valor} entre o valor das notas emitidas e o escriturado em {competencia}.",
  },
  {
    codigo: "B03",
    titulo: "NF-e cancelada escriturada como válida",
    familia: "RECEITA",
    severidade: "ALTO",
    tributo: "ICMS",
    fontesNecessarias: ["EVENTO_NFE", "SPED_FISCAL"],
    descricao:
      "Evento de cancelamento registrado na SEFAZ, mas o SPED escriturou a nota com situação normal.",
    baseLegal: ["Ajuste SINIEF 07/2005"],
    textoCliente:
      "Notas canceladas continuam escrituradas como válidas em {competencia}, inflando a receita em {valor}.",
  },
  {
    codigo: "B05",
    titulo: "Receita divergente entre as escriturações do mesmo período",
    familia: "RECEITA",
    severidade: "ALTO",
    tributo: "PIS_COFINS",
    fontesNecessarias: ["SPED_FISCAL", "SPED_CONTRIBUICOES"],
    descricao:
      "A receita de saídas do SPED Fiscal não bate com a base de PIS/COFINS da " +
      "EFD-Contribuições da mesma competência. São duas declarações da própria " +
      "empresa, entregues ao mesmo fisco, que precisam conversar.",
    baseLegal: ["IN RFB nº 2.121/2022", "Guia Prático da EFD-Contribuições"],
    textoCliente:
      "As duas escriturações entregues ao fisco em {competencia} apresentam " +
      "receitas diferentes, com diferença de {valor}.",
  },
  {
    codigo: "B07",
    titulo: "Receita declarada no PGDAS menor que a receita real",
    familia: "RECEITA",
    severidade: "CRITICO",
    tributo: "SIMPLES",
    fontesNecessarias: ["PGDAS", "NFE_XML"],
    descricao:
      "Soma dos documentos fiscais emitidos supera a receita bruta informada no PGDAS-D.",
    baseLegal: ["LC nº 123/2006, art. 29, II"],
    textoCliente:
      "A receita informada no PGDAS de {competencia} é {valor} menor que a receita comprovada pelas notas emitidas. Omissão de receita é causa de exclusão do Simples.",
  },
  {
    codigo: "B09",
    titulo: "Receita divergente entre ECD e ECF",
    familia: "RECEITA",
    severidade: "ALTO",
    tributo: "IRPJ_CSLL",
    fontesNecessarias: ["ECD", "ECF"],
    descricao:
      "A receita das contas de resultado da ECD não bate com a receita declarada na ECF do mesmo exercício.",
    baseLegal: ["IN RFB nº 2.003/2021", "IN RFB nº 1.700/2017"],
    textoCliente:
      "A contabilidade (ECD) e a declaração fiscal (ECF) do exercício apresentam receitas diferentes, com diferença de {valor}. São duas declarações da mesma empresa que precisam conversar.",
  },
];

/** Família C — crédito indevido e crédito perdido. É aqui que mora a oportunidade. */
const FAMILIA_C: DefinicaoAchado[] = [
  {
    codigo: "C01",
    titulo: "Crédito de PIS/COFINS sobre item monofásico",
    familia: "CREDITO",
    severidade: "ALTO",
    tributo: "PIS_COFINS",
    fontesNecessarias: ["SPED_CONTRIBUICOES", "NFE_XML"],
    descricao:
      "Crédito tomado sobre entrada com CST de tributação monofásica, em que não há débito na revenda nem direito a crédito.",
    baseLegal: ["Lei nº 10.637/2002, art. 3º", "Lei nº 10.833/2003, art. 3º"],
    textoCliente:
      "Foram apropriados {valor} de crédito sobre produtos monofásicos em {competencia} — crédito que a Receita glosa em fiscalização.",
  },
  {
    codigo: "C03",
    titulo: "ICMS não excluído da base de PIS/COFINS",
    familia: "CREDITO",
    severidade: "OPORTUNIDADE",
    tributo: "PIS_COFINS",
    fontesNecessarias: ["SPED_CONTRIBUICOES", "SPED_FISCAL"],
    descricao:
      "Base de cálculo de PIS/COFINS aparentemente calculada com o ICMS incluído, contrariando o Tema 69 do STF.",
    baseLegal: ["STF, RE 574.706 (Tema 69)", "Lei nº 12.973/2014"],
    textoCliente:
      "A empresa pagou a mais em PIS/COFINS por não excluir o ICMS da base. O valor recuperável estimado nos últimos 5 anos é de {valor}.",
  },
  {
    codigo: "C04",
    titulo: "Crédito de ICMS de energia, frete e ativo não aproveitado",
    familia: "CREDITO",
    severidade: "OPORTUNIDADE",
    tributo: "ICMS",
    fontesNecessarias: ["SPED_FISCAL", "NFE_XML"],
    descricao:
      "Entradas que dariam direito a crédito (energia em atividade industrial, frete sobre venda, imobilizado via CIAP) sem crédito correspondente na apuração.",
    baseLegal: ["LC nº 87/1996, art. 20 e art. 33", "RCTE-GO, Anexo IX"],
    textoCliente:
      "Há {valor} de crédito de ICMS a que a empresa tinha direito e não aproveitou.",
  },
];

/** Família D — regime e enquadramento. */
const FAMILIA_D: DefinicaoAchado[] = [
  {
    codigo: "D01",
    titulo: "Sublimite do Simples ultrapassado sem segregar ICMS e ISS",
    familia: "REGIME",
    severidade: "CRITICO",
    tributo: "SIMPLES",
    fontesNecessarias: ["PGDAS"],
    descricao:
      "RBT12 acima do sublimite estadual sem que ICMS e ISS tenham saído do DAS para recolhimento em guia própria.",
    baseLegal: ["LC nº 123/2006, art. 19 e art. 20"],
    textoCliente:
      "A empresa ultrapassou o sublimite em {competencia} e continuou recolhendo ICMS e ISS dentro do DAS. O estado e o município podem cobrar o tributo próprio, com multa.",
  },
  {
    codigo: "D02",
    titulo: "Anexo do Simples ou fator R aplicado incorretamente",
    familia: "REGIME",
    severidade: "ALTO",
    tributo: "SIMPLES",
    fontesNecessarias: ["PGDAS"],
    fontesQueConfirmam: ["ESOCIAL"],
    descricao:
      "Razão folha/receita dos 12 meses anteriores indica anexo diferente do utilizado.",
    baseLegal: ["LC nº 123/2006, art. 18, §§ 5º-J e 5º-M"],
    textoCliente:
      "O enquadramento por fator R está incorreto em {competencia}, com impacto de {valor}.",
  },
  {
    codigo: "D04",
    titulo: "Regime tributário mais caro que a alternativa disponível",
    familia: "REGIME",
    severidade: "OPORTUNIDADE",
    tributo: null,
    fontesNecessarias: ["SPED_FISCAL"],
    fontesQueConfirmam: ["ECD", "ECF", "SPED_CONTRIBUICOES"],
    descricao:
      "Recálculo mês a mês nos três regimes indica carga menor em regime diverso do adotado.",
    baseLegal: ["Lei nº 9.718/1998", "Lei nº 9.249/1995", "LC nº 123/2006"],
    textoCliente:
      "Nos últimos 12 meses, o regime adotado custou {valor} a mais do que a melhor alternativa disponível.",
  },
];

/** Família E — ICMS operacional (Goiás e interestadual). */
const FAMILIA_E: DefinicaoAchado[] = [
  {
    codigo: "E02",
    titulo: "DIFAL não recolhido em venda interestadual",
    familia: "ICMS_OPERACIONAL",
    severidade: "ALTO",
    tributo: "ICMS",
    fontesNecessarias: ["NFE_XML"],
    fontesQueConfirmam: ["SPED_FISCAL", "COMPROVANTE_ARRECADACAO"],
    descricao:
      "Venda interestadual a consumidor final não contribuinte sem o diferencial de alíquota correspondente.",
    baseLegal: ["EC nº 87/2015", "LC nº 190/2022"],
    textoCliente:
      "Há {valor} de DIFAL devido e não recolhido em {competencia}.",
  },
  {
    codigo: "E05",
    titulo: "CFOP incompatível com o destino da operação",
    familia: "ICMS_OPERACIONAL",
    severidade: "MEDIO",
    tributo: "ICMS",
    fontesNecessarias: ["NFE_XML"],
    descricao:
      "Saída com CFOP interno (5xxx) para destinatário de outra UF, ou CFOP " +
      "interestadual (6xxx) dentro do próprio estado. O CFOP errado leva à " +
      "alíquota errada e compromete a apuração e o diferencial de alíquota.",
    baseLegal: ["Convênio SINIEF s/nº de 1970, Anexo — Tabela de CFOP"],
    textoCliente:
      "Em {competencia} há itens emitidos com CFOP incompatível com o destino " +
      "da operação, somando {valor}.",
  },
  {
    codigo: "E06",
    titulo: "PROTEGE recolhido a 15% em vez de 10%, 8% ou 6%",
    familia: "ICMS_OPERACIONAL",
    severidade: "OPORTUNIDADE",
    tributo: "ICMS",
    fontesNecessarias: ["SPED_FISCAL", "COMPROVANTE_ARRECADACAO"],
    descricao:
      "Contribuição ao PROTEGE calculada sobre percentual indevido. A alíquota é de 10%, 8% ou 6% sobre o VALOR DO BENEFÍCIO, conforme o caso — nunca 15%.",
    baseLegal: ["Lei nº 14.469/2003", "RCTE-GO, Anexo IX"],
    textoCliente:
      "A contribuição ao PROTEGE foi calculada a maior. O valor pago indevidamente é de {valor} e é recuperável.",
  },
];

/** Família F — contábil. É o que o cliente não enxerga sozinho. */
const FAMILIA_F: DefinicaoAchado[] = [
  {
    codigo: "F01",
    titulo: "Caixa com saldo credor (caixa negativo)",
    familia: "CONTABIL",
    severidade: "CRITICO",
    tributo: null,
    fontesNecessarias: ["ECD"],
    descricao:
      "Conta de caixa com saldo credor — situação impossível de fato, que a fiscalização trata como presunção de omissão de receita.",
    baseLegal: ["Lei nº 9.430/1996, art. 42", "RIR/2018, art. 293"],
    textoCliente:
      "A contabilidade apresenta caixa negativo de {valor} em {competencia}. Caixa não fica negativo na vida real: para o fisco, isso é presunção de receita omitida.",
  },
  {
    codigo: "F02",
    titulo: "Passivo fictício — empréstimo de sócio sem lastro",
    familia: "CONTABIL",
    severidade: "CRITICO",
    tributo: null,
    fontesNecessarias: ["ECD"],
    descricao:
      "Conta de mútuo com sócio mantida sem contrato, sem movimentação bancária correspondente e sem liquidação.",
    baseLegal: ["Lei nº 9.430/1996, art. 40", "RIR/2018, art. 293"],
    textoCliente:
      "Há {valor} registrado como empréstimo de sócio sem comprovação de entrada do recurso. A fiscalização trata passivo não comprovado como receita omitida.",
  },
  {
    codigo: "F03",
    titulo: "Balancete que não fecha",
    familia: "CONTABIL",
    severidade: "ALTO",
    tributo: null,
    fontesNecessarias: ["ECD"],
    descricao: "Ativo diferente de Passivo mais Patrimônio Líquido na ECD entregue.",
    baseLegal: ["Lei nº 6.404/1976, art. 177", "NBC TG Estrutura Conceitual"],
    textoCliente:
      "O balanço entregue à Receita não fecha, com diferença de {valor}. Escrituração que não fecha não serve de prova a favor da empresa.",
  },
  {
    codigo: "F05",
    titulo: "Distribuição de lucro acima do presumido sem escrituração contábil",
    familia: "CONTABIL",
    severidade: "CRITICO",
    tributo: "IRRF",
    fontesNecessarias: ["ECD", "ECF"],
    descricao:
      "Lucro distribuído acima da base presumida líquida de tributos, sem escrituração contábil que demonstre lucro maior.",
    baseLegal: ["Lei nº 9.249/1995, art. 10", "RIR/2018, art. 238"],
    textoCliente:
      "Foram distribuídos {valor} acima do limite isento. Sem escrituração que comprove lucro maior, a parcela excedente é tributável na pessoa física.",
  },
  {
    codigo: "F09",
    titulo: "Contabilidade sem lastro — lançamentos globais mensais",
    familia: "CONTABIL",
    severidade: "ALTO",
    tributo: null,
    fontesNecessarias: ["ECD"],
    descricao:
      "Razão composto por lançamentos consolidados de fim de mês, sem individualização por documento.",
    baseLegal: ["Lei nº 6.404/1976, art. 177", "IN RFB nº 2.003/2021"],
    textoCliente:
      "A contabilidade foi feita por lançamentos globais de fim de mês, sem individualizar documento. Escrituração assim não sustenta defesa em fiscalização.",
  },
];

/** Família G — obrigações acessórias. */
const FAMILIA_G: DefinicaoAchado[] = [
  {
    codigo: "G02",
    titulo: "Obrigação acessória não entregue em exercício obrigatório",
    familia: "ACESSORIA",
    severidade: "ALTO",
    tributo: null,
    fontesNecessarias: ["SITUACAO_FISCAL"],
    descricao:
      "Exercício em que a empresa estava obrigada a ECD, ECF, DCTF ou EFD-Contribuições e não há entrega registrada.",
    baseLegal: ["IN RFB nº 2.003/2021", "Lei nº 10.426/2002"],
    textoCliente:
      "Não há registro de entrega da obrigação em {competencia}. A multa por falta de entrega é autônoma e continua correndo.",
  },
  {
    codigo: "G04",
    titulo: "Documento fiscal sem os campos de IBS e CBS",
    familia: "ACESSORIA",
    severidade: "ALTO",
    tributo: "IBS_CBS",
    fontesNecessarias: ["NFE_XML"],
    descricao:
      "Empresa do regime regular com documento fiscal emitido sem os campos de IBS e CBS, para fato gerador a partir de 03/08/2026.",
    baseLegal: ["LC nº 214/2025", "Ato Conjunto RFB/CGIBS nº 4, de 30/07/2026"],
    textoCliente:
      "Documentos fiscais de {competencia} foram emitidos sem os campos de IBS e CBS. A dispensa de recolhimento em 2026 depende justamente do cumprimento das obrigações acessórias.",
  },
];

export const CATALOGO: DefinicaoAchado[] = [
  ...FAMILIA_A,
  ...FAMILIA_B,
  ...FAMILIA_C,
  ...FAMILIA_D,
  ...FAMILIA_E,
  ...FAMILIA_F,
  ...FAMILIA_G,
];

const PORCODIGO = new Map(CATALOGO.map((d) => [d.codigo, d]));

export function definicaoDe(codigo: string): DefinicaoAchado {
  const d = PORCODIGO.get(codigo);
  // Código inexistente é erro de programação, não dado ruim do cliente: falhar alto.
  if (!d) throw new Error(`Achado ${codigo} não existe no catálogo.`);
  return d;
}

/**
 * Quais achados são avaliáveis com os documentos que o cliente entregou, e quais
 * viram lacuna declarada no relatório.
 */
export function cobertura(fontesDisponiveis: Set<TipoDocumento>): {
  avaliaveis: DefinicaoAchado[];
  bloqueados: { definicao: DefinicaoAchado; faltando: TipoDocumento[] }[];
} {
  const avaliaveis: DefinicaoAchado[] = [];
  const bloqueados: { definicao: DefinicaoAchado; faltando: TipoDocumento[] }[] = [];

  for (const d of CATALOGO) {
    const faltando = d.fontesNecessarias.filter((f) => !fontesDisponiveis.has(f));
    if (faltando.length === 0) avaliaveis.push(d);
    else bloqueados.push({ definicao: d, faltando });
  }

  return { avaliaveis, bloqueados };
}

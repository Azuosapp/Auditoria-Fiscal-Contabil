import type { RegimeTributario, Severidade, TipoDocumento } from "@prisma/client";

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

/**
 * Onde o achado é apresentado.
 *
 * FISCAL é erro de apuração e de documento fiscal — o que a empresa declarou,
 * escriturou e emitiu. CONTABIL é o que envolve pagamento, confissão e
 * escrituração contábil: se o tributo foi recolhido, o que a DCTF confessou, o
 * que a ECD registra. São conversas diferentes com o cliente e não se misturam
 * na mesma tela.
 */
export type AreaAchado = "FISCAL" | "CONTABIL";

export interface DefinicaoAchado {
  codigo: string;
  titulo: string;
  familia: FamiliaAchado;
  area: AreaAchado;
  /**
   * Regimes em que o achado faz sentido. Ausente = vale para todos.
   *
   * Sem isto, uma indústria do Lucro Real veria "sublimite do Simples
   * ultrapassado" na lista do que não foi avaliado — ruído que faz o relatório
   * parecer genérico.
   */
  regimesAplicaveis?: RegimeTributario[];
  severidade: Severidade;
  /** Tributo afetado; `null` quando o achado é transversal. */
  tributo: string | null;
  /** Sem TODOS estes documentos, o achado não pode ser avaliado — vira Lacuna. */
  fontesNecessarias: TipoDocumento[];
  /** Fontes que elevam a confiança de MEDIA para ALTA quando presentes. */
  fontesQueConfirmam?: TipoDocumento[];
  descricao: string;
  /**
   * Como o erro se manifesta na prática, com números e registros.
   *
   * ILUSTRATIVO — não é dado de empresa nenhuma. Serve para quem lê o catálogo
   * entender o que a regra procura: "divergência entre escriturações" é
   * abstrato; "o SPED soma R$ 440 mil de saídas e a base de PIS é R$ 325 mil"
   * é o que a pessoa reconhece quando vê no cliente dela.
   */
  exemplo: string;
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
    area: "CONTABIL",
    titulo: "ICMS declarado no SPED Fiscal e não recolhido",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "ICMS",
    fontesNecessarias: ["SPED_FISCAL", "COMPROVANTE_ARRECADACAO"],
    descricao:
      "O registro E110 aponta ICMS a recolher sem arrecadação correspondente na competência.",
    exemplo:
      "O registro E110 de 03/2026 informa R$ 45.320,15 no campo " +
      "VL_ICMS_RECOLHER, e não há DARE-GO nem GNRE dessa competência entre " +
      "os comprovantes entregues.",
    baseLegal: ["CTN, art. 142", "LC 87/1996, art. 24"],
    textoCliente:
      "A empresa declarou ao fisco estadual {valor} de ICMS em {competencia} e não há recolhimento correspondente. O valor permanece exigível e sujeito a multa e juros.",
  },
  {
    codigo: "A02",
    area: "CONTABIL",
    regimesAplicaveis: ["LUCRO_PRESUMIDO", "LUCRO_REAL"],
    titulo: "PIS declarado na EFD-Contribuições e não recolhido",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "PIS",
    fontesNecessarias: ["SPED_CONTRIBUICOES", "COMPROVANTE_ARRECADACAO"],
    fontesQueConfirmam: ["DCTF", "SITUACAO_FISCAL"],
    descricao: "Registro M200 com valor a recolher sem DARF correspondente.",
    exemplo:
      "O registro M200 de 03/2026 fecha com R$ 5.367,01 a recolher e não há " +
      "DARF do código 6912 (não cumulativo) nem 8109 (cumulativo) na " +
      "competência.",
    baseLegal: ["Lei nº 10.637/2002", "Lei nº 9.718/1998"],
    textoCliente:
      "Há {valor} de PIS apurado em {competencia} sem pagamento localizado.",
  },
  {
    codigo: "A03",
    area: "CONTABIL",
    regimesAplicaveis: ["LUCRO_PRESUMIDO", "LUCRO_REAL"],
    titulo: "COFINS declarada na EFD-Contribuições e não recolhida",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "COFINS",
    fontesNecessarias: ["SPED_CONTRIBUICOES", "COMPROVANTE_ARRECADACAO"],
    fontesQueConfirmam: ["DCTF", "SITUACAO_FISCAL"],
    descricao: "Registro M600 com valor a recolher sem DARF correspondente.",
    exemplo:
      "O registro M600 de 03/2026 fecha com R$ 24.720,79 a recolher e não " +
      "há DARF do código 5856 (não cumulativo) nem 2172 (cumulativo) na " +
      "competência.",
    baseLegal: ["Lei nº 10.833/2003", "Lei nº 9.718/1998"],
    textoCliente:
      "Há {valor} de COFINS apurada em {competencia} sem pagamento localizado.",
  },
  {
    codigo: "A04",
    area: "CONTABIL",
    regimesAplicaveis: ["LUCRO_PRESUMIDO", "LUCRO_REAL"],
    titulo: "IRPJ/CSLL apurado na ECF e não confessado em DCTF",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "IRPJ_CSLL",
    fontesNecessarias: ["ECF", "DCTF"],
    descricao:
      "A ECF apura tributo que a DCTF do mesmo período não confessa — divergência entre duas declarações da própria empresa.",
    exemplo:
      "A ECF do exercício de 2025 apura R$ 82.400,00 de IRPJ no Bloco N, e " +
      "a DCTF do 4º trimestre não confessa esse débito.",
    baseLegal: ["Lei nº 9.430/1996", "IN RFB nº 1.700/2017"],
    textoCliente:
      "A ECF informa {valor} de tributo apurado em {competencia} que não aparece na DCTF. Divergência entre declarações é cruzamento automático da Receita.",
  },
  {
    codigo: "A05",
    area: "CONTABIL",
    titulo: "Tributo federal confessado e não pago",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "FEDERAL",
    fontesNecessarias: ["DCTF", "COMPROVANTE_ARRECADACAO"],
    fontesQueConfirmam: ["SITUACAO_FISCAL"],
    descricao:
      "Débito confessado em DCTF sem pagamento, compensação, parcelamento ou suspensão que o quite.",
    exemplo:
      "A DCTF de 05/2026 confessa R$ 18.900,00 de CSLL sem pagamento, " +
      "compensação, parcelamento ou suspensão vinculada ao débito.",
    baseLegal: ["DL nº 2.124/1984, art. 5º, § 1º", "CTN, art. 150"],
    textoCliente:
      "A empresa confessou {valor} em {competencia} e não quitou. Confissão em DCTF é título executivo: a Receita inscreve em dívida ativa sem precisar autuar.",
  },
  {
    codigo: "A06",
    area: "CONTABIL",
    regimesAplicaveis: ["SIMPLES_NACIONAL"],
    titulo: "DAS do Simples declarado e não pago",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "SIMPLES",
    fontesNecessarias: ["PGDAS", "COMPROVANTE_ARRECADACAO"],
    descricao: "PGDAS-D apurado sem DAS quitado na competência.",
    exemplo:
      "O PGDAS-D de 04/2026 apura DAS de R$ 7.340,22 e não há comprovante " +
      "de recolhimento da competência.",
    baseLegal: ["LC nº 123/2006, art. 21"],
    textoCliente:
      "Há {valor} de DAS apurado em {competencia} sem pagamento. O débito impede a certidão negativa e pode gerar exclusão do Simples.",
  },
  {
    codigo: "A07",
    area: "CONTABIL",
    titulo: "Contribuição previdenciária confessada e não paga",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: "INSS",
    fontesNecessarias: ["DCTFWEB", "COMPROVANTE_ARRECADACAO"],
    fontesQueConfirmam: ["ESOCIAL"],
    descricao: "DCTFWeb com débito previdenciário sem arrecadação correspondente.",
    exemplo:
      "A DCTFWeb de 06/2026 confessa R$ 23.150,00 de contribuição " +
      "previdenciária patronal sem DARF correspondente.",
    baseLegal: ["Lei nº 8.212/1991", "IN RFB nº 2.110/2022"],
    textoCliente:
      "Há {valor} de contribuição previdenciária confessada em {competencia} sem recolhimento. Débito previdenciário tem consequência pessoal para o administrador.",
  },
  {
    codigo: "A08",
    area: "CONTABIL",
    titulo: "Débito em aberto que o cliente desconhece",
    familia: "DIVERGENCIA_PAGAMENTO",
    severidade: "CRITICO",
    tributo: null,
    fontesNecessarias: ["SITUACAO_FISCAL"],
    descricao:
      "Pendência registrada no Relatório de Situação Fiscal do e-CAC: débito, omissão de declaração, malha ou inscrição em dívida ativa.",
    exemplo:
      "O Relatório de Situação Fiscal lista a receita 5952-07 (CSRF), PA " +
      "08/2025, com saldo consolidado de R$ 1.845,20 e situação DEVEDOR.",
    baseLegal: ["Lei nº 6.830/1980", "CTN, art. 201"],
    textoCliente:
      "O relatório de situação fiscal da própria Receita registra {valor} em aberto. Isso bloqueia certidão negativa, crédito bancário e participação em licitação.",
  },
];

/** Família B — receita e omissão. */
const FAMILIA_B: DefinicaoAchado[] = [
  {
    codigo: "B01",
    area: "FISCAL",
    titulo: "NF-e autorizada e não escriturada",
    familia: "RECEITA",
    severidade: "CRITICO",
    tributo: "ICMS",
    fontesNecessarias: ["NFE_XML", "SPED_FISCAL"],
    descricao:
      "Chave de acesso autorizada pela SEFAZ sem registro C100 correspondente no SPED Fiscal.",
    exemplo:
      "A NF-e 3001, série 1, chave 52260112345678000199550010000030011, " +
      "emitida em 20/01/2026 por R$ 625,00, foi autorizada pela SEFAZ e não " +
      "tem registro C100 no SPED Fiscal de 01/2026.",
    baseLegal: ["RCTE-GO, art. 308", "CTN, art. 149"],
    textoCliente:
      "Foram localizadas notas autorizadas e não escrituradas em {competencia}, somando {valor}. Para o fisco, nota emitida e não escriturada é omissão de receita.",
  },
  {
    codigo: "B02",
    area: "FISCAL",
    titulo: "NF-e escriturada com valor divergente do XML",
    familia: "RECEITA",
    severidade: "ALTO",
    tributo: "ICMS",
    fontesNecessarias: ["NFE_XML", "SPED_FISCAL"],
    descricao: "Valor total do C100 diverge do valor do XML autorizado.",
    exemplo:
      "A NF-e 11200 traz R$ 12.480,00 no XML autorizado e R$ 12.048,00 no " +
      "registro C100 do SPED da mesma competência — diferença de R$ 432,00 " +
      "na mesma chave.",
    baseLegal: ["RCTE-GO, art. 308"],
    textoCliente:
      "Há divergência de {valor} entre o valor das notas emitidas e o escriturado em {competencia}.",
  },
  {
    codigo: "B03",
    area: "FISCAL",
    titulo: "NF-e cancelada escriturada como válida",
    familia: "RECEITA",
    severidade: "ALTO",
    tributo: "ICMS",
    fontesNecessarias: ["EVENTO_NFE", "SPED_FISCAL"],
    descricao:
      "Evento de cancelamento registrado na SEFAZ, mas o SPED escriturou a nota com situação normal.",
    exemplo:
      "A NF-e 2001 foi cancelada na SEFAZ em 12/01/2026 (evento 110111, " +
      "protocolo 152260000123456), e o registro C100 do SPED a escriturou " +
      "com COD_SIT 00 (documento regular).",
    baseLegal: ["Ajuste SINIEF 07/2005"],
    textoCliente:
      "Notas canceladas continuam escrituradas como válidas em {competencia}, inflando a receita em {valor}.",
  },
  {
    codigo: "B05",
    area: "FISCAL",
    regimesAplicaveis: ["LUCRO_PRESUMIDO", "LUCRO_REAL"],
    titulo: "Receita divergente entre as escriturações do mesmo período",
    familia: "RECEITA",
    severidade: "ALTO",
    tributo: "PIS_COFINS",
    fontesNecessarias: ["SPED_FISCAL", "SPED_CONTRIBUICOES"],
    descricao:
      "A receita de saídas do SPED Fiscal não bate com a base de PIS/COFINS da " +
      "EFD-Contribuições da mesma competência. São duas declarações da própria " +
      "empresa, entregues ao mesmo fisco, que precisam conversar.",
    exemplo:
      "Em 01/2026 o SPED Fiscal soma R$ 440.699,96 em saídas escrituradas, " +
      "enquanto a base de cálculo do PIS no registro M210 da " +
      "EFD-Contribuições é de R$ 325.273,60 — diferença de R$ 115.426,36 " +
      "(26,2%).",
    baseLegal: ["IN RFB nº 2.121/2022", "Guia Prático da EFD-Contribuições"],
    textoCliente:
      "As duas escriturações entregues ao fisco em {competencia} apresentam " +
      "receitas diferentes, com diferença de {valor}.",
  },
  {
    codigo: "B10",
    area: "FISCAL",
    titulo: "Nota escriturada sem XML correspondente",
    familia: "RECEITA",
    severidade: "MEDIO",
    tributo: "ICMS",
    fontesNecessarias: ["NFE_XML", "SPED_FISCAL"],
    descricao:
      "O SPED Fiscal escriturou nota cuja chave de acesso não aparece entre os " +
      "XMLs entregues. Ou o XML não foi entregue na coleta, ou foi escriturado " +
      "documento que não existe.",
    exemplo:
      "O registro C100 de 03/2026 escritura a nota 11447, chave " +
      "52260307903652000185550010000114471, por R$ 784,18, e esse XML não " +
      "está entre os arquivos entregues.",
    baseLegal: ["RCTE-GO, art. 308", "Ajuste SINIEF 07/2005"],
    textoCliente:
      "Em {competencia} há notas escrituradas cujo documento eletrônico não foi " +
      "localizado, somando {valor}.",
  },
  {
    codigo: "B07",
    area: "FISCAL",
    regimesAplicaveis: ["SIMPLES_NACIONAL"],
    titulo: "Receita declarada no PGDAS menor que a receita real",
    familia: "RECEITA",
    severidade: "CRITICO",
    tributo: "SIMPLES",
    fontesNecessarias: ["PGDAS", "NFE_XML"],
    descricao:
      "Soma dos documentos fiscais emitidos supera a receita bruta informada no PGDAS-D.",
    exemplo:
      "O PGDAS-D de 03/2026 declara R$ 180.000,00 de receita bruta, e as " +
      "NF-e e NFS-e autorizadas e não canceladas da competência somam R$ " +
      "214.500,00.",
    baseLegal: ["LC nº 123/2006, art. 29, II"],
    textoCliente:
      "A receita informada no PGDAS de {competencia} é {valor} menor que a receita comprovada pelas notas emitidas. Omissão de receita é causa de exclusão do Simples.",
  },
  {
    codigo: "B09",
    area: "CONTABIL",
    regimesAplicaveis: ["LUCRO_PRESUMIDO", "LUCRO_REAL"],
    titulo: "Receita divergente entre ECD e ECF",
    familia: "RECEITA",
    severidade: "ALTO",
    tributo: "IRPJ_CSLL",
    fontesNecessarias: ["ECD", "ECF"],
    descricao:
      "A receita das contas de resultado da ECD não bate com a receita declarada na ECF do mesmo exercício.",
    exemplo:
      "A conta 3.1.1.01 da ECD acumula R$ 2.480.000,00 de receita no " +
      "exercício, e a ECF informa R$ 2.310.000,00 no Bloco P do mesmo " +
      "período.",
    baseLegal: ["IN RFB nº 2.003/2021", "IN RFB nº 1.700/2017"],
    textoCliente:
      "A contabilidade (ECD) e a declaração fiscal (ECF) do exercício apresentam receitas diferentes, com diferença de {valor}. São duas declarações da mesma empresa que precisam conversar.",
  },
];

/** Família C — crédito indevido e crédito perdido. É aqui que mora a oportunidade. */
const FAMILIA_C: DefinicaoAchado[] = [
  {
    codigo: "C01",
    area: "FISCAL",
    regimesAplicaveis: ["LUCRO_REAL"],
    titulo: "Crédito de PIS/COFINS sobre item monofásico",
    familia: "CREDITO",
    severidade: "ALTO",
    tributo: "PIS_COFINS",
    fontesNecessarias: ["SPED_CONTRIBUICOES", "NFE_XML"],
    descricao:
      "Entrada cujo fornecedor aplicou CST de 04 a 09 (monofásico, substituição, " +
      "alíquota zero, isento, sem incidência ou suspensão), em competência com " +
      "crédito de PIS/COFINS apropriado. Não confundir com os CST 70 a 75 do " +
      "C170, que são a classificação correta de aquisição sem crédito.",
    exemplo:
      "Em 05/2026 a empresa apropriou R$ 31.000,00 de crédito de PIS/COFINS " +
      "e, na mesma competência, comprou R$ 48.200,00 em itens com CST 04 " +
      "(monofásico), que não geram crédito nem débito na revenda.",
    baseLegal: ["Lei nº 10.637/2002, art. 3º", "Lei nº 10.833/2003, art. 3º"],
    textoCliente:
      "Foram apropriados {valor} de crédito sobre produtos monofásicos em {competencia} — crédito que a Receita glosa em fiscalização.",
  },
  {
    codigo: "C03",
    area: "FISCAL",
    regimesAplicaveis: ["LUCRO_PRESUMIDO", "LUCRO_REAL"],
    titulo: "ICMS não excluído da base de PIS/COFINS",
    familia: "CREDITO",
    severidade: "OPORTUNIDADE",
    tributo: "PIS_COFINS",
    fontesNecessarias: ["SPED_CONTRIBUICOES", "SPED_FISCAL"],
    descricao:
      "Base de cálculo de PIS/COFINS aparentemente calculada com o ICMS incluído, contrariando o Tema 69 do STF.",
    exemplo:
      "A base de PIS do registro M210 de 02/2026 é de R$ 186.369,31 e " +
      "inclui R$ 22.360,00 de ICMS destacado nas notas de saída da " +
      "competência.",
    baseLegal: ["STF, RE 574.706 (Tema 69)", "Lei nº 12.973/2014"],
    textoCliente:
      "A empresa pagou a mais em PIS/COFINS por não excluir o ICMS da base. O valor recuperável estimado nos últimos 5 anos é de {valor}.",
  },
  {
    codigo: "C04",
    area: "FISCAL",
    titulo: "Crédito de ICMS de energia, frete e ativo não aproveitado",
    familia: "CREDITO",
    severidade: "OPORTUNIDADE",
    tributo: "ICMS",
    fontesNecessarias: ["SPED_FISCAL", "NFE_XML"],
    descricao:
      "Entradas que dariam direito a crédito (energia em atividade industrial, frete sobre venda, imobilizado via CIAP) sem crédito correspondente na apuração.",
    exemplo:
      "As entradas de energia elétrica do exercício somam R$ 96.000,00, com " +
      "R$ 16.320,00 de ICMS destacado, e o Bloco E não registra crédito " +
      "correspondente em nenhuma competência.",
    baseLegal: ["LC nº 87/1996, art. 20 e art. 33", "RCTE-GO, Anexo IX"],
    textoCliente:
      "Há {valor} de crédito de ICMS a que a empresa tinha direito e não aproveitou.",
  },
];

/** Família D — regime e enquadramento. */
const FAMILIA_D: DefinicaoAchado[] = [
  {
    codigo: "D01",
    area: "FISCAL",
    regimesAplicaveis: ["SIMPLES_NACIONAL"],
    titulo: "Sublimite do Simples ultrapassado sem segregar ICMS e ISS",
    familia: "REGIME",
    severidade: "CRITICO",
    tributo: "SIMPLES",
    fontesNecessarias: ["PGDAS"],
    descricao:
      "RBT12 acima do sublimite estadual sem que ICMS e ISS tenham saído do DAS para recolhimento em guia própria.",
    exemplo:
      "O extrato do PGDAS-D de 08/2026 marca 'impedido de recolher ICMS/ISS " +
      "no DAS' e, ainda assim, o DAS da competência inclui R$ 4.180,00 de " +
      "ICMS.",
    baseLegal: ["LC nº 123/2006, art. 19 e art. 20"],
    textoCliente:
      "A empresa ultrapassou o sublimite em {competencia} e continuou recolhendo ICMS e ISS dentro do DAS. O estado e o município podem cobrar o tributo próprio, com multa.",
  },
  {
    codigo: "D02",
    area: "FISCAL",
    regimesAplicaveis: ["SIMPLES_NACIONAL"],
    titulo: "Anexo do Simples ou fator R aplicado incorretamente",
    familia: "REGIME",
    severidade: "ALTO",
    tributo: "SIMPLES",
    fontesNecessarias: ["PGDAS"],
    fontesQueConfirmam: ["ESOCIAL"],
    descricao:
      "Razão folha/receita dos 12 meses anteriores indica anexo diferente do utilizado.",
    exemplo:
      "O PGDAS-D de 07/2026 informa fator R de 26,40% — abaixo dos 28% que " +
      "levariam a receita de serviço do Anexo V para o Anexo III.",
    baseLegal: ["LC nº 123/2006, art. 18, §§ 5º-J e 5º-M"],
    textoCliente:
      "O enquadramento por fator R está incorreto em {competencia}, com impacto de {valor}.",
  },
  {
    codigo: "D04",
    area: "FISCAL",
    titulo: "Planejamento tributário recomendado",
    familia: "REGIME",
    severidade: "OPORTUNIDADE",
    tributo: null,
    fontesNecessarias: ["SPED_FISCAL"],
    /**
     * NÃO é um comparativo de regimes — é a indicação de que ele deve ser feito.
     *
     * Comparar Simples, Presumido e Real exige folha de pagamento, resultado
     * contábil, composição de custos, benefícios fiscais aplicáveis e as
     * vedações de cada regime. A auditoria express não tem nada disso, e
     * afirmar "o regime adotado custou X a mais" com base só na apuração
     * fiscal seria vender um número que o sistema não apurou — e que o cliente
     * cobraria depois.
     *
     * O achado existe para abrir a porta do trabalho seguinte, não para
     * substituí-lo.
     */
    descricao:
      "Há base para avaliar, em estudo próprio, se o regime tributário adotado " +
      "é o mais econômico para a operação da empresa.",
    exemplo:
      "Empresa no Lucro Real, com 8 competências apuradas e R$ 3.200.000,00 " +
      "de receita no período: há base para simular os três regimes em estudo " +
      "próprio. A comparação em si depende da folha, do resultado contábil e " +
      "dos benefícios aplicáveis — que esta auditoria não levanta.",
    baseLegal: ["Lei nº 9.718/1998", "Lei nº 9.249/1995", "LC nº 123/2006"],
    textoCliente:
      "Recomenda-se um planejamento tributário para verificar se há regime " +
      "mais vantajoso que o atualmente adotado. A comparação entre Simples, " +
      "Lucro Presumido e Lucro Real depende da folha de pagamento, do resultado " +
      "contábil e dos benefícios fiscais aplicáveis — que não fazem parte desta " +
      "auditoria.",
  },
];

/** Família E — ICMS operacional (Goiás e interestadual). */
const FAMILIA_E: DefinicaoAchado[] = [
  {
    codigo: "E02",
    area: "FISCAL",
    titulo: "DIFAL não recolhido em venda interestadual",
    familia: "ICMS_OPERACIONAL",
    severidade: "ALTO",
    tributo: "ICMS",
    fontesNecessarias: ["NFE_XML"],
    fontesQueConfirmam: ["SPED_FISCAL", "COMPROVANTE_ARRECADACAO"],
    descricao:
      "Venda interestadual a consumidor final não contribuinte sem o diferencial de alíquota correspondente.",
    exemplo:
      "A NF-e 4820 vendeu R$ 8.900,00 a consumidor final não contribuinte " +
      "em MG, e não há recolhimento do diferencial de alíquota na " +
      "competência.",
    baseLegal: ["EC nº 87/2015", "LC nº 190/2022"],
    textoCliente:
      "Há {valor} de DIFAL devido e não recolhido em {competencia}.",
  },
  {
    codigo: "E05",
    area: "FISCAL",
    titulo: "CFOP incompatível com o destino da operação",
    familia: "ICMS_OPERACIONAL",
    severidade: "MEDIO",
    tributo: "ICMS",
    fontesNecessarias: ["NFE_XML"],
    descricao:
      "Saída com CFOP interno (5xxx) para destinatário de outra UF, ou CFOP " +
      "interestadual (6xxx) dentro do próprio estado. O CFOP errado leva à " +
      "alíquota errada e compromete a apuração e o diferencial de alíquota.",
    exemplo:
      "A NF-e 9130 foi emitida com CFOP 5101 (venda de produção, operação " +
      "interna) para destinatário no DF, enquanto a empresa está " +
      "estabelecida em GO.",
    baseLegal: ["Convênio SINIEF s/nº de 1970, Anexo — Tabela de CFOP"],
    textoCliente:
      "Em {competencia} há itens emitidos com CFOP incompatível com o destino " +
      "da operação, somando {valor}.",
  },
  {
    codigo: "E06",
    area: "FISCAL",
    titulo: "PROTEGE recolhido a 15% em vez de 10%, 8% ou 6%",
    familia: "ICMS_OPERACIONAL",
    severidade: "OPORTUNIDADE",
    tributo: "ICMS",
    fontesNecessarias: ["SPED_FISCAL", "COMPROVANTE_ARRECADACAO"],
    descricao:
      "Contribuição ao PROTEGE calculada sobre percentual indevido. A alíquota é de 10%, 8% ou 6% sobre o VALOR DO BENEFÍCIO, conforme o caso — nunca 15%.",
    exemplo:
      "O benefício do Anexo IX gerou R$ 120.000,00 no exercício, e a " +
      "contribuição ao PROTEGE foi recolhida a 15% (R$ 18.000,00) em vez " +
      "dos 10% devidos sobre o valor do benefício (R$ 12.000,00) — R$ " +
      "6.000,00 pagos a maior.",
    baseLegal: ["Lei nº 14.469/2003", "RCTE-GO, Anexo IX"],
    textoCliente:
      "A contribuição ao PROTEGE foi calculada a maior. O valor pago indevidamente é de {valor} e é recuperável.",
  },
];

/** Família F — contábil. É o que o cliente não enxerga sozinho. */
const FAMILIA_F: DefinicaoAchado[] = [
  {
    codigo: "F01",
    area: "CONTABIL",
    titulo: "Caixa com saldo credor (caixa negativo)",
    familia: "CONTABIL",
    severidade: "CRITICO",
    tributo: null,
    fontesNecessarias: ["ECD"],
    descricao:
      "Conta de caixa com saldo credor — situação impossível de fato, que a fiscalização trata como presunção de omissão de receita.",
    exemplo:
      "O razão da conta 1.1.1.01 (Caixa) encerra 03/2026 com saldo CREDOR " +
      "de R$ 84.200,00 — situação impossível de fato.",
    baseLegal: ["Lei nº 9.430/1996, art. 42", "RIR/2018, art. 293"],
    textoCliente:
      "A contabilidade apresenta caixa negativo de {valor} em {competencia}. Caixa não fica negativo na vida real: para o fisco, isso é presunção de receita omitida.",
  },
  {
    codigo: "F02",
    area: "CONTABIL",
    titulo: "Passivo fictício — empréstimo de sócio sem lastro",
    familia: "CONTABIL",
    severidade: "CRITICO",
    tributo: null,
    fontesNecessarias: ["ECD"],
    descricao:
      "Conta de mútuo com sócio mantida sem contrato, sem movimentação bancária correspondente e sem liquidação.",
    exemplo:
      "A conta 2.1.5.01 (Empréstimo de sócios) mantém R$ 350.000,00 desde " +
      "2023, sem contrato de mútuo e sem ingresso correspondente em conta " +
      "bancária.",
    baseLegal: ["Lei nº 9.430/1996, art. 40", "RIR/2018, art. 293"],
    textoCliente:
      "Há {valor} registrado como empréstimo de sócio sem comprovação de entrada do recurso. A fiscalização trata passivo não comprovado como receita omitida.",
  },
  {
    codigo: "F03",
    area: "CONTABIL",
    titulo: "Balancete que não fecha",
    familia: "CONTABIL",
    severidade: "ALTO",
    tributo: null,
    fontesNecessarias: ["ECD"],
    descricao: "Ativo diferente de Passivo mais Patrimônio Líquido na ECD entregue.",
    exemplo:
      "O balancete de 12/2025 da ECD apresenta ativo de R$ 4.210.000,00 " +
      "contra passivo mais patrimônio líquido de R$ 4.198.000,00 — " +
      "diferença de R$ 12.000,00.",
    baseLegal: ["Lei nº 6.404/1976, art. 177", "NBC TG Estrutura Conceitual"],
    textoCliente:
      "O balanço entregue à Receita não fecha, com diferença de {valor}. Escrituração que não fecha não serve de prova a favor da empresa.",
  },
  {
    codigo: "F05",
    area: "CONTABIL",
    regimesAplicaveis: ["LUCRO_PRESUMIDO", "LUCRO_REAL"],
    titulo: "Distribuição de lucro acima do presumido sem escrituração contábil",
    familia: "CONTABIL",
    severidade: "CRITICO",
    tributo: "IRRF",
    fontesNecessarias: ["ECD", "ECF"],
    descricao:
      "Lucro distribuído acima da base presumida líquida de tributos, sem escrituração contábil que demonstre lucro maior.",
    exemplo:
      "Foram distribuídos R$ 600.000,00 de lucro no exercício, e o lucro " +
      "presumido líquido dos tributos é de R$ 420.000,00, sem escrituração " +
      "contábil que comprove lucro maior. A diferença de R$ 180.000,00 é " +
      "tributável na pessoa física.",
    baseLegal: ["Lei nº 9.249/1995, art. 10", "RIR/2018, art. 238"],
    textoCliente:
      "Foram distribuídos {valor} acima do limite isento. Sem escrituração que comprove lucro maior, a parcela excedente é tributável na pessoa física.",
  },
  {
    codigo: "F09",
    area: "CONTABIL",
    titulo: "Contabilidade sem lastro — lançamentos globais mensais",
    familia: "CONTABIL",
    severidade: "ALTO",
    tributo: null,
    fontesNecessarias: ["ECD"],
    descricao:
      "Razão composto por lançamentos consolidados de fim de mês, sem individualização por documento.",
    exemplo:
      "O razão registra um único lançamento de receita por mês na conta " +
      "3.1.1.01, sempre no último dia — R$ 206.000,00 em 31/03/2025, por " +
      "exemplo — sem individualização por documento fiscal.",
    baseLegal: ["Lei nº 6.404/1976, art. 177", "IN RFB nº 2.003/2021"],
    textoCliente:
      "A contabilidade foi feita por lançamentos globais de fim de mês, sem individualizar documento. Escrituração assim não sustenta defesa em fiscalização.",
  },
];

/** Família G — obrigações acessórias. */
const FAMILIA_G: DefinicaoAchado[] = [
  {
    codigo: "G02",
    area: "CONTABIL",
    titulo: "Obrigação acessória não entregue em exercício obrigatório",
    familia: "ACESSORIA",
    severidade: "ALTO",
    tributo: null,
    fontesNecessarias: ["SITUACAO_FISCAL"],
    descricao:
      "Exercício em que a empresa estava obrigada a ECD, ECF, DCTF ou EFD-Contribuições e não há entrega registrada.",
    exemplo:
      "Não há registro de entrega da ECF do exercício de 2024, cujo prazo " +
      "venceu em 31/07/2025, obrigatória para a empresa no Lucro Real. A " +
      "multa por atraso é autônoma e continua correndo.",
    baseLegal: ["IN RFB nº 2.003/2021", "Lei nº 10.426/2002"],
    textoCliente:
      "Não há registro de entrega da obrigação em {competencia}. A multa por falta de entrega é autônoma e continua correndo.",
  },
  {
    codigo: "G04",
    area: "FISCAL",
    regimesAplicaveis: ["LUCRO_PRESUMIDO", "LUCRO_REAL"],
    titulo: "Documento fiscal sem os campos de IBS e CBS",
    familia: "ACESSORIA",
    severidade: "ALTO",
    tributo: "IBS_CBS",
    fontesNecessarias: ["NFE_XML"],
    descricao:
      "Empresa do regime regular com documento fiscal emitido sem os campos de IBS e CBS, para fato gerador a partir de 03/08/2026.",
    exemplo:
      "A NF-e 15022, emitida em 20/08/2026 por empresa do regime regular, " +
      "não traz os grupos de IBS e CBS no XML — obrigatórios para fatos " +
      "geradores a partir de 03/08/2026.",
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
 * O achado se aplica a algum dos regimes em que a empresa esteve no período?
 *
 * Regime desconhecido deixa tudo passar: é melhor listar a mais do que esconder
 * achado por uma suposição nossa sobre o enquadramento.
 */
export function aplicavelAoRegime(
  d: DefinicaoAchado,
  regimes: Set<RegimeTributario>,
): boolean {
  if (!d.regimesAplicaveis) return true;
  if (regimes.size === 0) return true;
  return d.regimesAplicaveis.some((r) => regimes.has(r));
}

/**
 * Quais achados são avaliáveis com os documentos que o cliente entregou, e quais
 * viram lacuna declarada no relatório.
 *
 * O que não se aplica ao regime da empresa não entra em nenhum dos dois lados:
 * uma indústria do Lucro Real não tem "sublimite do Simples" nem como achado nem
 * como lacuna — a regra simplesmente não existe para ela.
 */
export function cobertura(
  fontesDisponiveis: Set<TipoDocumento>,
  regimes: Set<RegimeTributario> = new Set(),
): {
  avaliaveis: DefinicaoAchado[];
  bloqueados: { definicao: DefinicaoAchado; faltando: TipoDocumento[] }[];
  foraDoRegime: DefinicaoAchado[];
} {
  const avaliaveis: DefinicaoAchado[] = [];
  const bloqueados: { definicao: DefinicaoAchado; faltando: TipoDocumento[] }[] = [];
  const foraDoRegime: DefinicaoAchado[] = [];

  for (const d of CATALOGO) {
    if (!aplicavelAoRegime(d, regimes)) {
      foraDoRegime.push(d);
      continue;
    }
    const faltando = d.fontesNecessarias.filter((f) => !fontesDisponiveis.has(f));
    if (faltando.length === 0) avaliaveis.push(d);
    else bloqueados.push({ definicao: d, faltando });
  }

  return { avaliaveis, bloqueados, foraDoRegime };
}

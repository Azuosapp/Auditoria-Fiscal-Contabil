import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família B — receita e omissão.
 *
 * É a família que mais rende com o que o cliente costuma entregar primeiro: XML
 * e SPED. Todo achado aqui compara o que a empresa EMITIU com o que a
 * contabilidade ESCRITUROU — os dois lados vêm de arquivos diferentes, e é por
 * isso que `NotaFiscal.origem` existe.
 */

const ZERO = new Prisma.Decimal(0);

/** Tolerância de centavos: diferença menor que isso é arredondamento, não achado. */
const TOLERANCIA = new Prisma.Decimal("0.02");

export const familiaB: Regra = {
  codigos: ["B01", "B02", "B03", "B05", "B07", "B10", "B11"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    const achados: AchadoProduzido[] = [];

    achados.push(...(await b01NotasNaoEscrituradas(ctx)));
    achados.push(...(await b02ValorDivergente(ctx)));
    achados.push(...(await b03CanceladaEscriturada(ctx)));
    achados.push(...(await b05ReceitaDivergenteEntreEscrituracoes(ctx)));
    achados.push(...(await b07ReceitaPgdasMenorQueReal(ctx)));
    achados.push(...(await b10EscrituradaSemXml(ctx)));
    achados.push(...(await b11NotaDeTerceiroComoSaida(ctx)));

    return achados;
  },
};

/**
 * B01 — NF-e autorizada e não escriturada.
 *
 * Só roda com SPED Fiscal presente: sem ele, TODA nota apareceria como não
 * escriturada, o que seria um falso positivo em massa — o pior erro possível
 * numa reunião com o cliente.
 *
 * Agrupa por competência porque o cliente entende "em março de 2024 faltaram 18
 * notas, somando R$ 240 mil", não uma lista de 18 chaves.
 */
async function b01NotasNaoEscrituradas(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (!ctx.fontesDisponiveis.has("SPED_FISCAL")) return [];

  // A comparação só vale nas competências em que HÁ escrituração. Um mês sem
  // SPED importado não significa nota omitida — significa arquivo faltando, e
  // isso é lacuna, tratada na família G.
  const competenciasComSped = await competenciasComEscrituracao(ctx.auditoriaId);
  if (competenciasComSped.size === 0) return [];

  const filtro = {
    documento: { auditoriaId: ctx.auditoriaId },
    origem: "XML_AUTORIZADO" as const,
    situacao: "AUTORIZADA" as const,
    direcao: "SAIDA" as const,
    escriturada: false,
    competencia: { in: [...competenciasComSped] },
  };

  const [naoEscrituradas, exemplos] = await Promise.all([
    prisma.notaFiscal.groupBy({
      by: ["competencia"],
      where: filtro,
      _count: { _all: true },
      _sum: { valorTotal: true },
    }),
    // As notas concretas. O relatório precisa mostrar QUAL nota faltou, com
    // número, chave e data: é o que o cliente confere no próprio sistema dele.
    prisma.notaFiscal.findMany({
      where: filtro,
      select: {
        competencia: true,
        numero: true,
        serie: true,
        chave: true,
        dataEmissao: true,
        valorTotal: true,
        cnpjDestinatario: true,
      },
      orderBy: [{ competencia: "asc" }, { dataEmissao: "asc" }],
    }),
  ]);

  const exemplosPorCompetencia = new Map<string, typeof exemplos>();
  for (const e of exemplos) {
    const lista = exemplosPorCompetencia.get(e.competencia) ?? [];
    lista.push(e);
    exemplosPorCompetencia.set(e.competencia, lista);
  }

  return naoEscrituradas.map((g) => {
    const valor = g._sum.valorTotal ?? ZERO;
    const daCompetencia = exemplosPorCompetencia.get(g.competencia) ?? [];
    return {
      codigo: "B01",
      competencia: g.competencia,
      descricao:
        `${g._count._all} nota(s) de saída autorizada(s) pela SEFAZ sem registro ` +
        `C100 correspondente no SPED Fiscal da competência.`,
      textoCliente:
        `Foram localizadas ${g._count._all} notas emitidas e não escrituradas em ` +
        `${mesAno(g.competencia)}, somando ${moeda(valor)}. Para o fisco, nota ` +
        `emitida e não escriturada é omissão de receita.`,
      recomendacao:
        "Escriturar as notas em SPED retificador e recolher a diferença de ICMS " +
        "com denúncia espontânea, antes de iniciada a fiscalização.",
      valorExposicao: valor,
      // Nota não escriturada é receita não declarada: não há pagamento a
      // homologar, então a contagem é a do art. 173, I.
      declarado: false,
      evidencias: [
        // Até 10 notas por competência: o suficiente para o cliente conferir
        // sem transformar o relatório numa listagem de mil linhas.
        ...daCompetencia.slice(0, 10).map((n) => ({
          tipo: "EXEMPLO" as const,
          arquivo: `XML autorizado · ausente no SPED ${mesAno(g.competencia)}`,
          registro: "C100",
          documentoNumero: `${n.numero}${n.serie ? `/${n.serie}` : ""}`,
          chave: n.chave ?? undefined,
          dataDocumento: n.dataEmissao.toLocaleDateString("pt-BR", {
            timeZone: "UTC",
          }),
          participante: n.cnpjDestinatario ?? undefined,
          valor: moeda(n.valorTotal),
          observacao: "nota autorizada pela SEFAZ e não escriturada",
        })),
        {
          tipo: "CONTEXTO" as const,
          arquivo: `SPED Fiscal ${mesAno(g.competencia)}`,
          registro: "C100",
          observacao:
            `${g._count._all} chave(s) de acesso autorizadas sem registro ` +
            `correspondente` +
            (daCompetencia.length > 10
              ? `; as 10 primeiras estão detalhadas acima`
              : ""),
        },
      ],
    };
  });
}

/**
 * B02 — nota escriturada com valor diferente do XML autorizado.
 *
 * Compara chave a chave. Diferença de centavos é ignorada: o SPED arredonda em
 * pontos que o XML não arredonda, e acusar R$ 0,01 destruiria a credibilidade
 * do relatório inteiro.
 */
async function b02ValorDivergente(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (!ctx.fontesDisponiveis.has("SPED_FISCAL")) return [];

  const [xmls, escrituradas] = await Promise.all([
    prisma.notaFiscal.findMany({
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "XML_AUTORIZADO",
        situacao: "AUTORIZADA",
        chave: { not: null },
      },
      select: {
        chave: true,
        numero: true,
        competencia: true,
        valorTotal: true,
        dataEmissao: true,
      },
    }),
    prisma.notaFiscal.findMany({
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "ESCRITURACAO",
        chave: { not: null },
      },
      select: { chave: true, valorTotal: true },
    }),
  ]);

  const porChave = new Map(escrituradas.map((n) => [n.chave!, n.valorTotal]));

  interface Divergente {
    numero: string;
    chave: string;
    emissao: Date;
    noXml: Prisma.Decimal;
    noSped: Prisma.Decimal;
    diferenca: Prisma.Decimal;
  }

  const divergencias = new Map<
    string,
    { quantidade: number; soma: Prisma.Decimal; exemplos: Divergente[] }
  >();

  for (const xml of xmls) {
    const noSped = porChave.get(xml.chave!);
    if (!noSped) continue;

    const diferenca = xml.valorTotal.minus(noSped).abs();
    if (diferenca.lessThanOrEqualTo(TOLERANCIA)) continue;

    const atual = divergencias.get(xml.competencia) ?? {
      quantidade: 0,
      soma: ZERO,
      exemplos: [] as Divergente[],
    };
    atual.quantidade += 1;
    atual.soma = atual.soma.plus(diferenca);
    if (atual.exemplos.length < 10) {
      atual.exemplos.push({
        numero: xml.numero,
        chave: xml.chave!,
        emissao: xml.dataEmissao,
        noXml: xml.valorTotal,
        noSped,
        diferenca,
      });
    }
    divergencias.set(xml.competencia, atual);
  }

  return [...divergencias.entries()].map(([competencia, d]) => ({
    codigo: "B02",
    competencia,
    descricao:
      `${d.quantidade} nota(s) escriturada(s) com valor diferente do XML ` +
      `autorizado. Diferença somada: ${moeda(d.soma)}.`,
    textoCliente:
      `Há divergência de ${moeda(d.soma)} entre o valor das notas emitidas e o ` +
      `escriturado em ${mesAno(competencia)}.`,
    recomendacao:
      "Conferir os registros C100 divergentes e retificar a escrituração.",
    valorExposicao: d.soma,
    declarado: true,
    evidencias: d.exemplos.map((e) => ({
      tipo: "EXEMPLO" as const,
      arquivo: `XML × SPED Fiscal ${mesAno(competencia)}`,
      registro: "C100",
      documentoNumero: e.numero,
      chave: e.chave,
      dataDocumento: e.emissao.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
      valor: `XML ${moeda(e.noXml)} × escriturado ${moeda(e.noSped)}`,
      observacao: `diferença de ${moeda(e.diferenca)}`,
    })),
  }));
}

/**
 * B03 — nota cancelada na SEFAZ e escriturada como válida.
 *
 * Exige o evento de cancelamento: é ele que prova o cancelamento. Sem os
 * eventos importados, este achado não pode ser afirmado.
 */
async function b03CanceladaEscriturada(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (
    !ctx.fontesDisponiveis.has("EVENTO_NFE") ||
    !ctx.fontesDisponiveis.has("SPED_FISCAL")
  ) {
    return [];
  }

  const eventos = await prisma.eventoNfe.findMany({
    where: { documento: { auditoriaId: ctx.auditoriaId }, cancelaNota: true },
    select: { chave: true, dataEvento: true, protocolo: true },
  });
  if (eventos.length === 0) return [];

  const chavesCanceladas = new Map(eventos.map((e) => [e.chave, e]));

  const escrituradasValidas = await prisma.notaFiscal.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      origem: "ESCRITURACAO",
      situacao: "AUTORIZADA",
      chave: { in: [...chavesCanceladas.keys()] },
    },
    select: { chave: true, numero: true, competencia: true, valorTotal: true },
  });

  const porCompetencia = new Map<
    string,
    { quantidade: number; soma: Prisma.Decimal; exemplos: typeof escrituradasValidas }
  >();

  for (const n of escrituradasValidas) {
    const atual = porCompetencia.get(n.competencia) ?? {
      quantidade: 0,
      soma: ZERO,
      exemplos: [],
    };
    atual.quantidade += 1;
    atual.soma = atual.soma.plus(n.valorTotal);
    if (atual.exemplos.length < 5) atual.exemplos.push(n);
    porCompetencia.set(n.competencia, atual);
  }

  return [...porCompetencia.entries()].map(([competencia, d]) => ({
    codigo: "B03",
    competencia,
    descricao:
      `${d.quantidade} nota(s) com evento de cancelamento registrado na SEFAZ ` +
      `continuam escrituradas com situação normal no SPED Fiscal.`,
    textoCliente:
      `Notas canceladas continuam escrituradas como válidas em ` +
      `${mesAno(competencia)}, inflando a receita em ${moeda(d.soma)}.`,
    recomendacao:
      "Retificar o SPED com o código de situação 02 (cancelamento) e ajustar a " +
      "apuração do período.",
    valorExposicao: d.soma,
    declarado: true,
    evidencias: d.exemplos.map((n) => ({
      tipo: "EXEMPLO" as const,
      arquivo: `SPED Fiscal ${mesAno(competencia)}`,
      registro: "C100",
      campo: "COD_SIT",
      documentoNumero: n.numero,
      chave: n.chave ?? undefined,
      dataDocumento: chavesCanceladas
        .get(n.chave!)
        ?.dataEvento?.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
      valor: `${moeda(n.valorTotal)} · escriturada como "00 — normal"`,
      observacao: `cancelada na SEFAZ, protocolo ${
        chavesCanceladas.get(n.chave!)?.protocolo ?? "não informado"
      }`,
    })),
  }));
}

/**
 * B05 — receita divergente entre as escriturações do mesmo mês.
 *
 * A base de PIS/COFINS da EFD-Contribuições e a receita de saídas do SPED Fiscal
 * descrevem a mesma operação por caminhos diferentes. Divergência relevante
 * significa que uma das duas está errada — e as duas foram entregues ao fisco.
 *
 * Não é comparação exata: a base de PIS/COFINS legitimamente exclui itens
 * (monofásico, alíquota zero, exportação). Por isso o achado só nasce acima de
 * um limiar percentual, e sai com confiança MÉDIA, com a ressalva dita.
 */
async function b05ReceitaDivergenteEntreEscrituracoes(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (
    !ctx.fontesDisponiveis.has("SPED_FISCAL") ||
    !ctx.fontesDisponiveis.has("SPED_CONTRIBUICOES")
  ) {
    return [];
  }

  const [saidasPorMes, basesPorMes] = await Promise.all([
    prisma.notaFiscal.groupBy({
      by: ["competencia"],
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "ESCRITURACAO",
        direcao: "SAIDA",
        situacao: "AUTORIZADA",
      },
      _sum: { valorTotal: true },
    }),
    prisma.apuracaoContribuicoes.findMany({
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        contribuicao: "PIS",
      },
      select: { competencia: true, baseCalculo: true },
    }),
  ]);

  const base = new Map(
    basesPorMes
      .filter((b) => b.baseCalculo !== null)
      .map((b) => [b.competencia, b.baseCalculo!]),
  );

  const achados: AchadoProduzido[] = [];

  for (const s of saidasPorMes) {
    const receitaFiscal = s._sum.valorTotal ?? ZERO;
    const basePis = base.get(s.competencia);
    if (!basePis || receitaFiscal.isZero()) continue;

    const diferenca = receitaFiscal.minus(basePis).abs();
    const percentual = diferenca.dividedBy(receitaFiscal).times(100);

    // 10% é o limiar a partir do qual a diferença deixa de ser explicável só
    // por exclusões normais de base e passa a merecer conferência.
    if (percentual.lessThan(10)) continue;

    achados.push({
      codigo: "B05",
      competencia: s.competencia,
      confianca: "MEDIA",
      descricao:
        `Receita de saídas no SPED Fiscal (${moeda(receitaFiscal)}) diverge da ` +
        `base de PIS na EFD-Contribuições (${moeda(basePis)}) em ` +
        `${percentual.toFixed(1)}%.`,
      textoCliente:
        `As duas escriturações entregues ao fisco em ${mesAno(s.competencia)} ` +
        `apresentam receitas diferentes, com diferença de ${moeda(diferenca)}.`,
      recomendacao:
        "Conciliar a base de PIS/COFINS com a receita escriturada e documentar " +
        "as exclusões de base aplicadas.",
      valorExposicao: diferenca,
      declarado: true,
      ressalva:
        "A base de PIS/COFINS legitimamente exclui receita monofásica, de " +
        "alíquota zero e de exportação. Conferir se a diferença é explicada por " +
        "essas exclusões antes de tratar como inconsistência.",
      evidencias: [
        {
          tipo: "CONFRONTO" as const,
          arquivo: `SPED Fiscal ${mesAno(s.competencia)}`,
          registro: "C100",
          campo: "soma das saídas escrituradas",
          valor: moeda(receitaFiscal),
        },
        {
          tipo: "CONFRONTO" as const,
          arquivo: `EFD-Contribuições ${mesAno(s.competencia)}`,
          registro: "M210",
          campo: "base de cálculo do PIS",
          valor: moeda(basePis),
        },
        {
          tipo: "CONFRONTO" as const,
          arquivo: "Diferença apurada",
          campo: "SPED Fiscal menos base de PIS",
          valor: `${moeda(diferenca)} (${percentual.toFixed(1)}%)`,
        },
      ],
    });
  }

  return achados;
}

/**
 * B07 — receita declarada no PGDAS menor que a receita real.
 *
 * Confronta o que a empresa declarou no Simples com a soma dos documentos que
 * ela própria emitiu. Omissão de receita é causa de exclusão do Simples, o que
 * torna este achado dos mais graves para o cliente.
 */
async function b07ReceitaPgdasMenorQueReal(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (!ctx.fontesDisponiveis.has("PGDAS")) return [];

  const temDocumentoDeSaida =
    ctx.fontesDisponiveis.has("NFE_XML") ||
    ctx.fontesDisponiveis.has("NFCE_XML") ||
    ctx.fontesDisponiveis.has("NFSE_XML");
  if (!temDocumentoDeSaida) return [];

  const [declaradas, emitidas] = await Promise.all([
    prisma.apuracaoSimples.findMany({
      where: { documento: { auditoriaId: ctx.auditoriaId } },
      select: { competencia: true, receitaBruta: true },
    }),
    prisma.notaFiscal.groupBy({
      by: ["competencia"],
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "XML_AUTORIZADO",
        direcao: "SAIDA",
        situacao: "AUTORIZADA",
      },
      _sum: { valorTotal: true },
      _count: { _all: true },
    }),
  ]);

  const real = new Map(
    emitidas.map((e) => [e.competencia, e._sum.valorTotal ?? ZERO]),
  );

  const achados: AchadoProduzido[] = [];

  for (const d of declaradas) {
    const receitaReal = real.get(d.competencia);
    if (!receitaReal || receitaReal.isZero()) continue;

    const diferenca = receitaReal.minus(d.receitaBruta);
    // Só acusa quando a declarada é MENOR. Declarar a mais não é omissão —
    // é pagamento indevido, e vira oportunidade em regra própria.
    if (diferenca.lessThanOrEqualTo(TOLERANCIA)) continue;

    achados.push({
      codigo: "B07",
      competencia: d.competencia,
      descricao:
        `Receita declarada no PGDAS-D (${moeda(d.receitaBruta)}) é menor que a ` +
        `soma dos documentos fiscais emitidos (${moeda(receitaReal)}).`,
      textoCliente:
        `A receita informada no PGDAS de ${mesAno(d.competencia)} é ` +
        `${moeda(diferenca)} menor que a receita comprovada pelas notas ` +
        `emitidas. Omissão de receita é causa de exclusão do Simples Nacional.`,
      recomendacao:
        "Retificar o PGDAS-D da competência e recolher a diferença do DAS com " +
        "os acréscimos legais.",
      valorExposicao: diferenca,
      // A parcela omitida não foi declarada: contagem do art. 173, I.
      declarado: false,
      ressalva:
        "Confirmar se a diferença decorre de nota cancelada, devolução ou " +
        "operação não tributável antes de tratar como omissão.",
      evidencias: [
        {
          tipo: "CONFRONTO" as const,
          arquivo: `PGDAS-D ${mesAno(d.competencia)}`,
          campo: "receita bruta declarada",
          valor: moeda(d.receitaBruta),
        },
        {
          tipo: "CONFRONTO" as const,
          arquivo: "XMLs autorizados da competência",
          campo: "soma das notas de saída autorizadas e não canceladas",
          valor: moeda(receitaReal),
        },
        {
          tipo: "CONFRONTO" as const,
          arquivo: "Diferença apurada",
          campo: "receita real menos declarada",
          valor: moeda(diferenca),
        },
      ],
    });
  }

  return achados;
}

/**
 * B10 — nota escriturada cuja chave não aparece entre os XMLs entregues.
 *
 * É o inverso do B01, e a leitura honesta é outra: na prática, quase sempre
 * significa que o XML não veio na coleta — o cliente baixou o SPED completo mas
 * só parte dos XMLs. Por isso nasce com severidade MÉDIA e confiança MÉDIA, e o
 * texto diz as duas hipóteses. Tratar como "documento inexistente" seria
 * acusação grave apoiada em ausência de arquivo.
 *
 * Ainda assim vale apontar: se o XML realmente não existir, há escrituração de
 * documento inidôneo — e, se existir, a auditoria está incompleta naquele mês e
 * o auditor precisa saber disso.
 */
async function b10EscrituradaSemXml(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (
    !ctx.fontesDisponiveis.has("SPED_FISCAL") ||
    !ctx.fontesDisponiveis.has("NFE_XML")
  ) {
    return [];
  }

  const [escrituradas, xmls] = await Promise.all([
    prisma.notaFiscal.findMany({
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "ESCRITURACAO",
        direcao: "SAIDA",
        situacao: "AUTORIZADA",
        chave: { not: null },
      },
      select: {
        chave: true,
        numero: true,
        competencia: true,
        valorTotal: true,
        dataEmissao: true,
      },
    }),
    prisma.notaFiscal.findMany({
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "XML_AUTORIZADO",
        chave: { not: null },
      },
      select: { chave: true },
    }),
  ]);

  const chavesComXml = new Set(xmls.map((x) => x.chave!));

  const porCompetencia = new Map<
    string,
    { quantidade: number; soma: Prisma.Decimal; exemplos: typeof escrituradas }
  >();

  for (const n of escrituradas) {
    if (chavesComXml.has(n.chave!)) continue;

    const atual = porCompetencia.get(n.competencia) ?? {
      quantidade: 0,
      soma: ZERO,
      exemplos: [],
    };
    atual.quantidade += 1;
    atual.soma = atual.soma.plus(n.valorTotal);
    if (atual.exemplos.length < 10) atual.exemplos.push(n);
    porCompetencia.set(n.competencia, atual);
  }

  return [...porCompetencia.entries()].map(([competencia, d]) => ({
    codigo: "B10",
    competencia,
    confianca: "MEDIA" as const,
    descricao:
      `${d.quantidade} nota(s) escriturada(s) no SPED Fiscal sem XML ` +
      `correspondente entre os arquivos entregues, somando ${moeda(d.soma)}.`,
    textoCliente:
      `Em ${mesAno(competencia)} há ${d.quantidade} nota(s) escriturada(s), ` +
      `somando ${moeda(d.soma)}, cujo documento eletrônico não foi localizado ` +
      `entre os arquivos analisados.`,
    recomendacao:
      "Obter os XMLs faltantes na distribuição DF-e da SEFAZ e reimportar. " +
      "Persistindo a ausência, verificar se houve escrituração de documento " +
      "inexistente.",
    valorExposicao: d.soma,
    declarado: true,
    ressalva:
      "Na maior parte dos casos significa apenas que o XML não veio na coleta, " +
      "e não que o documento não exista. Só há irregularidade se o documento " +
      "realmente não constar na SEFAZ. Enquanto isso, a auditoria está " +
      "incompleta nesta competência.",
    evidencias: d.exemplos.map((e) => ({
      tipo: "EXEMPLO" as const,
      arquivo: `SPED Fiscal ${mesAno(competencia)} · XML não localizado`,
      registro: "C100",
      documentoNumero: e.numero,
      chave: e.chave ?? undefined,
      dataDocumento: e.dataEmissao.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
      valor: moeda(e.valorTotal),
      observacao: "escriturada no SPED, sem documento eletrônico entre os arquivos",
    })),
  }));
}

/**
 * B11 — nota de terceiro escriturada como saída da empresa.
 *
 * O C100 traz IND_OPER (entrada ou saída) declarado pelo próprio contribuinte, e
 * a chave de acesso carrega o CNPJ de quem emitiu. Quando os dois discordam —
 * "saída" numa nota que outro emitiu —, a compra entrou na escrituração como
 * venda: infla a receita, infla o débito de ICMS e distorce toda comparação
 * com os XMLs.
 *
 * Encontrado em arquivo real: duas compras de GLP escrituradas com IND_OPER 1
 * e CFOP 5660, o CFOP de venda do FORNECEDOR, somando R$ 9.200,49 de receita
 * que não existiu.
 *
 * Sai com confiança MÉDIA porque há caso legítimo — autofaturamento e operação
 * triangular produzem nota de saída emitida por terceiro. São raros, e o texto
 * pede a conferência em vez de afirmar o erro.
 */
async function b11NotaDeTerceiroComoSaida(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (!ctx.fontesDisponiveis.has("SPED_FISCAL")) return [];

  const suspeitas = await prisma.notaFiscal.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      origem: "ESCRITURACAO",
      direcao: "SAIDA",
      situacao: "AUTORIZADA",
      // O CNPJ do emitente vem da chave de acesso: se não é a empresa, a nota
      // não pode ser saída dela.
      cnpjEmitente: { not: ctx.empresaCnpj },
    },
    select: {
      numero: true,
      chave: true,
      competencia: true,
      dataEmissao: true,
      valorTotal: true,
      cnpjEmitente: true,
    },
    orderBy: [{ competencia: "asc" }, { valorTotal: "desc" }],
  });

  if (suspeitas.length === 0) return [];

  const porCompetencia = new Map<string, typeof suspeitas>();
  for (const n of suspeitas) {
    const lista = porCompetencia.get(n.competencia) ?? [];
    lista.push(n);
    porCompetencia.set(n.competencia, lista);
  }

  return [...porCompetencia.entries()].map(([competencia, notas]) => {
    const soma = notas.reduce((s, n) => s.plus(n.valorTotal), ZERO);

    return {
      codigo: "B11",
      competencia,
      confianca: "MEDIA" as const,
      descricao:
        `${notas.length} nota(s) com IND_OPER 1 (saída) no registro C100 cuja ` +
        `chave de acesso aponta outro emitente, somando ${moeda(soma)}.`,
      textoCliente:
        `Em ${mesAno(competencia)} há ${notas.length} nota(s) emitida(s) por ` +
        `terceiros escriturada(s) como saída da empresa, somando ${moeda(soma)}. ` +
        `A receita e o débito de ICMS do período estão inflados nesse valor.`,
      recomendacao:
        "Conferir o IND_OPER e o CFOP dessas notas no SPED. Sendo compras, " +
        "retificar a escrituração para entrada, com o CFOP correspondente, e " +
        "refazer a apuração do ICMS da competência.",
      valorExposicao: soma,
      declarado: true,
      ressalva:
        "Existe nota de saída legitimamente emitida por terceiro — " +
        "autofaturamento e operação triangular. Conferir caso a caso antes de " +
        "retificar.",
      evidencias: notas.slice(0, 10).map((n) => ({
        tipo: "EXEMPLO" as const,
        arquivo: `SPED Fiscal ${mesAno(competencia)}`,
        registro: "C100",
        campo: "IND_OPER = 1 (saída)",
        documentoNumero: n.numero,
        chave: n.chave ?? undefined,
        dataDocumento: n.dataEmissao.toLocaleDateString("pt-BR", {
          timeZone: "UTC",
        }),
        participante: n.cnpjEmitente,
        valor: moeda(n.valorTotal),
        observacao: `emitida pelo CNPJ ${n.cnpjEmitente}, não pela empresa`,
      })),
    };
  });
}

/** Competências em que há SPED Fiscal efetivamente importado e lido. */
async function competenciasComEscrituracao(
  auditoriaId: string,
): Promise<Set<string>> {
  const apuracoes = await prisma.apuracaoFiscal.findMany({
    where: { documento: { auditoriaId } },
    select: { competencia: true },
  });
  const notas = await prisma.notaFiscal.groupBy({
    by: ["competencia"],
    where: { documento: { auditoriaId }, origem: "ESCRITURACAO" },
  });

  return new Set([
    ...apuracoes.map((a) => a.competencia),
    ...notas.map((n) => n.competencia),
  ]);
}

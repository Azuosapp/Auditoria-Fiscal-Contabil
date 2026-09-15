import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda, percentual as pct } from "../texto";
import { exercicioDe } from "../prescricao";

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
  codigos: ["B01", "B02", "B03", "B05", "B07", "B11", "B12"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    const achados: AchadoProduzido[] = [];

    achados.push(...(await b01NotasNaoEscrituradas(ctx)));
    achados.push(...(await b02ValorDivergente(ctx)));
    achados.push(...(await b03CanceladaEscriturada(ctx)));
    achados.push(...(await b05ReceitaDivergenteEntreEscrituracoes(ctx)));
    achados.push(...(await b07ReceitaPgdasMenorQueReal(ctx)));
    achados.push(...(await b11NotaDeTerceiroComoSaida(ctx)));
    achados.push(...(await b12ContribuicoesSemReceita(ctx)));

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
      // IPI e ICMS-ST vêm somados porque NÃO integram a receita bruta: o valor
      // total da nota os inclui, a base de PIS/COFINS não. Comparar os dois
      // sem descontá-los acusa divergência em toda indústria que destaca IPI.
      _sum: { valorTotal: true, valorIpi: true, valorIcmsSt: true },
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
    const totalNotas = s._sum.valorTotal ?? ZERO;
    const ipi = s._sum.valorIpi ?? ZERO;
    const icmsSt = s._sum.valorIcmsSt ?? ZERO;
    const basePis = base.get(s.competencia);
    if (!basePis || totalNotas.isZero()) continue;

    // O que de fato se compara com a base de PIS/COFINS: o valor da nota menos
    // os tributos que não são receita. O IPI destacado está fora da receita
    // bruta por força do art. 12, § 4º, do DL 1.598/1977, e o ICMS-ST porque é
    // cobrado do adquirente por substituição. Sem esse ajuste o confronto
    // acusaria divergência em toda indústria — falso positivo garantido.
    const receitaFiscal = totalNotas.minus(ipi).minus(icmsSt);
    if (receitaFiscal.lessThanOrEqualTo(0)) continue;

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
        `Receita de saídas no SPED Fiscal (${moeda(receitaFiscal)}, já sem IPI ` +
        `e ICMS-ST) diverge da base de PIS na EFD-Contribuições ` +
        `(${moeda(basePis)}) em ${pct(percentual)}.`,
      textoCliente:
        `As duas escriturações entregues ao fisco em ${mesAno(s.competencia)} ` +
        `apresentam receitas diferentes, com ${moeda(diferenca)} fora da base ` +
        `de PIS/COFINS sem justificativa visível nos arquivos entregues.`,
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
          campo: "receita de saídas, já sem IPI e ICMS-ST",
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
          campo: "receita de saídas menos base de PIS",
          valor: `${moeda(diferenca)} (${pct(percentual)})`,
        },
        // O caminho da conta, linha a linha. É o que o contador do cliente
        // refaz na frente da gente: sai do total das notas, desce até a base
        // declarada e mostra onde a conta para de fechar.
        {
          tipo: "EXEMPLO" as const,
          arquivo: `SPED Fiscal ${mesAno(s.competencia)}`,
          registro: "C100",
          campo: "Valor total das notas de saída escrituradas",
          valor: moeda(totalNotas),
          observacao: "soma do campo VL_DOC dos registros C100 de saída",
        },
        ...(ipi.isZero()
          ? []
          : [
              {
                tipo: "EXEMPLO" as const,
                arquivo: `SPED Fiscal ${mesAno(s.competencia)}`,
                registro: "C100",
                campo: "(−) IPI destacado nas mesmas notas",
                valor: moeda(ipi),
                observacao:
                  "o IPI não integra a receita bruta (DL 1.598/1977, art. 12, § 4º)",
              },
            ]),
        ...(icmsSt.isZero()
          ? []
          : [
              {
                tipo: "EXEMPLO" as const,
                arquivo: `SPED Fiscal ${mesAno(s.competencia)}`,
                registro: "C100",
                campo: "(−) ICMS-ST destacado nas mesmas notas",
                valor: moeda(icmsSt),
                observacao: "cobrado do adquirente por substituição, não é receita",
              },
            ]),
        {
          tipo: "EXEMPLO" as const,
          arquivo: "Cálculo",
          campo: "(=) Receita que deveria compor a base",
          valor: moeda(receitaFiscal),
          observacao: "é este número que se compara com a base declarada",
        },
        {
          tipo: "EXEMPLO" as const,
          arquivo: `EFD-Contribuições ${mesAno(s.competencia)}`,
          registro: "M210",
          campo: "(−) Base de PIS efetivamente declarada",
          valor: moeda(basePis),
          observacao: "campo VL_BC_CONT da apuração entregue",
        },
        {
          tipo: "EXEMPLO" as const,
          arquivo: "Cálculo",
          campo: "(=) Receita fora da base, sem justificativa nos arquivos",
          valor: `${moeda(diferenca)} (${pct(percentual)})`,
          observacao:
            "conferir se corresponde a venda monofásica, com alíquota zero, " +
            "isenta, suspensa ou de exportação — cada uma dessas exclusões tem " +
            "de estar demonstrada na própria escrituração",
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
 * B12 — EFD-Contribuições sem receita, com faturamento no SPED Fiscal.
 *
 * O caso que o B05 não alcança. O B05 compara duas receitas declaradas; aqui
 * uma delas simplesmente não existe: a EFD-Contribuições veio com todos os
 * blocos sem dados e M200/M600 zerados, enquanto o SPED Fiscal do mesmo mês
 * escritura saídas com débito de ICMS.
 *
 * Não é divergência de critério — é receita que não foi oferecida à tributação
 * federal. Por isso nasce CRÍTICO, e não como variação percentual.
 *
 * A confiança é MÉDIA de propósito: a soma das saídas do SPED inclui operações
 * que não são receita (remessa, devolução, transferência, bonificação), e o
 * C170 não vem nas saídas próprias, então não dá para expurgá-las por CFOP
 * aqui. O valor sai como estimativa declarada, para conferência — não como
 * número a cobrar do cliente.
 */
async function b12ContribuicoesSemReceita(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (
    !ctx.fontesDisponiveis.has("SPED_FISCAL") ||
    !ctx.fontesDisponiveis.has("SPED_CONTRIBUICOES")
  ) {
    return [];
  }

  const [saidasPorMes, apuracoes, apuracoesIcms] = await Promise.all([
    prisma.notaFiscal.groupBy({
      by: ["competencia"],
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "ESCRITURACAO",
        direcao: "SAIDA",
        situacao: "AUTORIZADA",
      },
      _sum: { valorTotal: true, valorIpi: true, valorIcmsSt: true },
      _count: { _all: true },
    }),
    prisma.apuracaoContribuicoes.findMany({
      where: { documento: { auditoriaId: ctx.auditoriaId } },
      select: {
        competencia: true,
        contribuicao: true,
        baseCalculo: true,
        valorApurado: true,
      },
    }),
    prisma.apuracaoFiscal.findMany({
      where: { documento: { auditoriaId: ctx.auditoriaId } },
      select: { competencia: true, debitos: true },
    }),
  ]);

  // Competências em que a EFD-Contribuições foi entregue. Sem entrega, o caso
  // é outro — falta de arquivo, que já vira lacuna.
  const entregues = new Set(apuracoes.map((a) => a.competencia));

  /** Zerada: nenhuma base e nenhum valor apurado em nenhuma contribuição. */
  const semReceita = new Set(
    [...entregues].filter((competencia) =>
      apuracoes
        .filter((a) => a.competencia === competencia)
        .every(
          (a) =>
            (a.baseCalculo === null || a.baseCalculo.isZero()) &&
            a.valorApurado.isZero(),
        ),
    ),
  );

  const debitoIcms = new Map(
    apuracoesIcms.map((a) => [a.competencia, a.debitos]),
  );

  const achados: AchadoProduzido[] = [];

  for (const s of saidasPorMes) {
    if (!semReceita.has(s.competencia)) continue;

    const totalNotas = s._sum.valorTotal ?? ZERO;
    const receita = totalNotas
      .minus(s._sum.valorIpi ?? ZERO)
      .minus(s._sum.valorIcmsSt ?? ZERO);
    if (receita.lessThanOrEqualTo(0)) continue;

    const exercicio = exercicioDe(s.competencia);
    const regime = ctx.regimePorExercicio.get(exercicio);
    const cumulativo = regime === "LUCRO_PRESUMIDO";

    // Só estima o tributo no regime cumulativo, onde a conta é direta:
    // 0,65% de PIS e 3% de COFINS sobre a receita. No não cumulativo o valor
    // depende dos créditos do período, que não estão apurados aqui — estimar
    // seria dar ao cliente um número que o estudo ainda vai desmentir.
    const estimativa = cumulativo
      ? receita.times(new Prisma.Decimal("0.0365"))
      : undefined;

    const icms = debitoIcms.get(s.competencia);

    achados.push({
      codigo: "B12",
      competencia: s.competencia,
      confianca: "MEDIA",
      descricao:
        `${s._count._all} nota(s) de saída escriturada(s) no SPED Fiscal, ` +
        `somando ${moeda(receita)}, e EFD-Contribuições da mesma competência ` +
        `entregue sem receita (M200 e M600 zerados).`,
      textoCliente:
        `Em ${mesAno(s.competencia)} a empresa escriturou ${moeda(receita)} de ` +
        `saídas no SPED Fiscal` +
        (icms && !icms.isZero()
          ? `, com ${moeda(icms)} de débito de ICMS,`
          : "") +
        ` e entregou a EFD-Contribuições sem nenhuma receita. PIS e COFINS não ` +
        `foram apurados sobre o faturamento do mês.` +
        (estimativa
          ? ` No regime cumulativo, a contribuição sobre essa receita seria de ` +
            `aproximadamente ${moeda(estimativa)}.`
          : ""),
      recomendacao:
        "Confirmar se houve faturamento na competência e, havendo, retificar a " +
        "EFD-Contribuições com a receita e a apuração devidas, recolhendo PIS " +
        "e COFINS com denúncia espontânea antes de iniciada a fiscalização.",
      valorExposicao: estimativa,
      // Receita não declarada: não há pagamento a homologar, então a contagem
      // da decadência é a do art. 173, I.
      declarado: false,
      severidade: "CRITICO",
      ressalva:
        "A soma das saídas do SPED Fiscal inclui operações que não são receita " +
        "— remessa, devolução, transferência e bonificação —, e o valor acima " +
        "não as expurga. Confirmar a receita efetiva do mês antes de apurar a " +
        "diferença." +
        (cumulativo
          ? ""
          : regime
            ? ` No ${exercicio} a empresa está no regime não cumulativo, em ` +
              `que a contribuição depende dos créditos do período: por isso ` +
              `nenhum valor foi estimado aqui.`
            : ` O regime tributário de ${exercicio} não está cadastrado — ` +
              `cadastre-o na ficha da empresa para o sistema estimar a ` +
              `contribuição devida sobre essa receita.`),
      evidencias: [
        {
          tipo: "CONFRONTO" as const,
          arquivo: `SPED Fiscal ${mesAno(s.competencia)}`,
          registro: "C100",
          campo: "saídas escrituradas, já sem IPI e ICMS-ST",
          valor: moeda(receita),
        },
        {
          tipo: "CONFRONTO" as const,
          arquivo: `EFD-Contribuições ${mesAno(s.competencia)}`,
          registro: "M200/M600",
          campo: "receita informada",
          valor: moeda(ZERO),
        },
        {
          tipo: "EXEMPLO" as const,
          arquivo: `SPED Fiscal ${mesAno(s.competencia)}`,
          registro: "C100",
          campo: "Notas de saída escrituradas na competência",
          valor: `${s._count._all} nota(s) · ${moeda(receita)}`,
          observacao: "soma do VL_DOC dos registros C100 de saída, sem IPI e ICMS-ST",
        },
        ...(icms && !icms.isZero()
          ? [
              {
                tipo: "EXEMPLO" as const,
                arquivo: `SPED Fiscal ${mesAno(s.competencia)}`,
                registro: "E110",
                campo: "Débito de ICMS apurado sobre essas saídas",
                valor: moeda(icms),
                observacao:
                  "a própria empresa reconheceu a operação tributada no estadual",
              },
            ]
          : []),
        {
          tipo: "EXEMPLO" as const,
          arquivo: `EFD-Contribuições ${mesAno(s.competencia)}`,
          registro: "M200 e M600",
          campo: "Receita oferecida a PIS e COFINS",
          valor: moeda(ZERO),
          observacao:
            "apuração entregue zerada, com os blocos de documentos sem dados",
        },
        ...(estimativa
          ? [
              {
                tipo: "EXEMPLO" as const,
                arquivo: "Cálculo",
                campo: "Contribuição estimada no regime cumulativo",
                valor: moeda(estimativa),
                observacao:
                  "PIS 0,65% + COFINS 3% sobre a receita — estimativa a confirmar",
              },
            ]
          : []),
      ],
    });
  }

  return achados;
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

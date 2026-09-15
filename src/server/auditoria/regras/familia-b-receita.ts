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
  codigos: ["B01", "B02", "B03", "B05", "B07"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    const achados: AchadoProduzido[] = [];

    achados.push(...(await b01NotasNaoEscrituradas(ctx)));
    achados.push(...(await b02ValorDivergente(ctx)));
    achados.push(...(await b03CanceladaEscriturada(ctx)));
    achados.push(...(await b05ReceitaDivergenteEntreEscrituracoes(ctx)));
    achados.push(...(await b07ReceitaPgdasMenorQueReal(ctx)));

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

  const naoEscrituradas = await prisma.notaFiscal.groupBy({
    by: ["competencia"],
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      origem: "XML_AUTORIZADO",
      situacao: "AUTORIZADA",
      direcao: "SAIDA",
      escriturada: false,
      competencia: { in: [...competenciasComSped] },
    },
    _count: { _all: true },
    _sum: { valorTotal: true },
  });

  return naoEscrituradas.map((g) => {
    const valor = g._sum.valorTotal ?? ZERO;
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
        {
          arquivo: `SPED Fiscal ${mesAno(g.competencia)}`,
          registro: "C100",
          observacao:
            `${g._count._all} chave(s) de acesso autorizadas sem registro correspondente.`,
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
      select: { chave: true, numero: true, competencia: true, valorTotal: true },
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

  const divergencias = new Map<
    string,
    { quantidade: number; soma: Prisma.Decimal; exemplos: string[] }
  >();

  for (const xml of xmls) {
    const noSped = porChave.get(xml.chave!);
    if (!noSped) continue;

    const diferenca = xml.valorTotal.minus(noSped).abs();
    if (diferenca.lessThanOrEqualTo(TOLERANCIA)) continue;

    const atual = divergencias.get(xml.competencia) ?? {
      quantidade: 0,
      soma: ZERO,
      exemplos: [],
    };
    atual.quantidade += 1;
    atual.soma = atual.soma.plus(diferenca);
    if (atual.exemplos.length < 5) {
      atual.exemplos.push(
        `nota ${xml.numero}: XML ${moeda(xml.valorTotal)} × escriturado ${moeda(noSped)}`,
      );
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
      arquivo: `SPED Fiscal ${mesAno(competencia)}`,
      registro: "C100",
      observacao: e,
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
      arquivo: `SPED Fiscal ${mesAno(competencia)}`,
      registro: "C100",
      campo: "COD_SIT",
      valor: "00 (normal)",
      observacao: `nota ${n.numero}, chave ${n.chave} — cancelada na SEFAZ, protocolo ${
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
          arquivo: `SPED Fiscal ${mesAno(s.competencia)}`,
          registro: "C100",
          valor: moeda(receitaFiscal),
          observacao: "soma das saídas escrituradas",
        },
        {
          arquivo: `EFD-Contribuições ${mesAno(s.competencia)}`,
          registro: "M210",
          valor: moeda(basePis),
          observacao: "base de cálculo do PIS",
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
          arquivo: `PGDAS-D ${mesAno(d.competencia)}`,
          campo: "receita bruta do período",
          valor: moeda(d.receitaBruta),
        },
        {
          arquivo: "XMLs autorizados da competência",
          valor: moeda(receitaReal),
          observacao: "soma das notas de saída autorizadas e não canceladas",
        },
      ],
    });
  }

  return achados;
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

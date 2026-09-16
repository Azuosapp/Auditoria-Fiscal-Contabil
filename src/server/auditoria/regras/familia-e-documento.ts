import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família E — ICMS nos documentos de saída.
 *
 * Os erros que o auditor encontra abrindo a nota: alíquota que não é a da
 * operação, item tributado sem imposto, ICMS do documento diferente do
 * escriturado, DIFAL destacado e não levado à apuração, CFOP de contribuinte em
 * venda a quem não é contribuinte. Todos se provam com o XML e a EFD, sem
 * depender de julgamento.
 *
 *   E07 — ICMS destacado na NF-e diferente do escriturado na EFD
 *   E08 — alíquota acima da interestadual em saída para outra UF
 *   E09 — item tributado (CST 00) sem ICMS em saída interestadual
 *   E02 — DIFAL destacado na NF-e e não escriturado no E300/E310
 *   E10 — CFOP de venda a contribuinte em venda a não contribuinte de outra UF
 */

const ZERO = new Prisma.Decimal(0);
const CENTAVO = new Prisma.Decimal("0.01");

/** Sul e Sudeste, exceto Espírito Santo (Resolução do Senado Federal nº 22/1989). */
const SUL_SUDESTE_EXCETO_ES = new Set(["PR", "RS", "SC", "MG", "RJ", "SP"]);

/** Origens com conteúdo importado sujeitas a 4% (Resolução do Senado Federal nº 13/2012). */
const ORIGEM_IMPORTADA = new Set(["1", "2", "3", "8"]);

/**
 * Alíquota interestadual da operação.
 *
 * 12% como regra; 7% quando a mercadoria sai do Sul ou Sudeste (exceto ES) para
 * Norte, Nordeste, Centro-Oeste ou ES; 4% para mercadoria com conteúdo
 * importado das origens 1, 2, 3 e 8.
 */
export function aliquotaInterestadual(
  ufOrigem: string,
  ufDestino: string,
  origemMercadoria?: string | null,
): Prisma.Decimal {
  if (origemMercadoria && ORIGEM_IMPORTADA.has(origemMercadoria)) return new Prisma.Decimal(4);
  if (SUL_SUDESTE_EXCETO_ES.has(ufOrigem) && !SUL_SUDESTE_EXCETO_ES.has(ufDestino)) {
    return new Prisma.Decimal(7);
  }
  return new Prisma.Decimal(12);
}

export const familiaEDocumento: Regra = {
  codigos: ["E02", "E07", "E08", "E09", "E10"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    if (!ctx.fontesDisponiveis.has("NFE_XML") || !ctx.empresaUf) return [];
    const achados: AchadoProduzido[] = [];
    const saidas = await saidasPropriasInterestaduais(ctx);
    achados.push(...e08AliquotaAcimaDaInterestadual(ctx, saidas));
    achados.push(...e10CfopNaoContribuinte(ctx, saidas));
    if (ctx.fontesDisponiveis.has("SPED_FISCAL")) {
      achados.push(...(await e07IcmsXmlEfd(ctx)));
      achados.push(...(await e09ItemSemIcms(ctx, saidas)));
      achados.push(...(await e02DifalNaoEscriturado(ctx, saidas)));
    }
    return achados;
  },
};

async function saidasPropriasInterestaduais(ctx: ContextoRegra) {
  return prisma.notaFiscal.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      origem: "XML_AUTORIZADO",
      situacao: "AUTORIZADA",
      cnpjEmitente: ctx.empresaCnpj,
      ufDestino: { not: ctx.empresaUf },
      NOT: { ufDestino: null },
    },
    include: {
      itens: { orderBy: { numeroItem: "asc" } },
      documento: { select: { nomeArquivo: true } },
    },
    orderBy: [{ competencia: "asc" }, { numero: "asc" }],
  });
}

type Saida = Awaited<ReturnType<typeof saidasPropriasInterestaduais>>[number];

/** Agrupa por competência preservando a ordem. */
function porCompetencia<T extends { competencia: string }>(lista: T[]): Map<string, T[]> {
  const mapa = new Map<string, T[]>();
  for (const x of lista) {
    const l = mapa.get(x.competencia) ?? [];
    l.push(x);
    mapa.set(x.competencia, l);
  }
  return mapa;
}

function pct(v: Prisma.Decimal): string {
  return `${v.toFixed(2).replace(".", ",").replace(/,00$/, "")}%`;
}

/**
 * E08 — alíquota acima da interestadual.
 *
 * O destinatário contribuinte só pode se creditar da alíquota interestadual, e
 * para o não contribuinte a diferença até a alíquota interna é DIFAL da UF de
 * destino — nunca ICMS de Goiás. Destacar a alíquota interna faz a empresa
 * recolher a mais ao próprio estado e emitir documento que o cliente não pode
 * aproveitar por inteiro.
 */
function e08AliquotaAcimaDaInterestadual(ctx: ContextoRegra, saidas: Saida[]): AchadoProduzido[] {
  interface Caso { nota: Saida; item: Saida["itens"][number]; correta: Prisma.Decimal; excesso: Prisma.Decimal }
  const casos: (Caso & { competencia: string })[] = [];

  for (const nota of saidas) {
    for (const item of nota.itens) {
      if (!item.aliqIcms || !item.baseIcms || item.aliqIcms.isZero()) continue;
      const correta = aliquotaInterestadual(ctx.empresaUf!, nota.ufDestino!, item.origemMercadoria);
      if (item.aliqIcms.lessThanOrEqualTo(correta.plus(CENTAVO))) continue;
      const excesso = item.baseIcms.times(item.aliqIcms.minus(correta)).dividedBy(100).toDecimalPlaces(2);
      casos.push({ nota, item, correta, excesso, competencia: nota.competencia });
    }
  }

  return [...porCompetencia(casos)].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.excesso), ZERO);
    const notas = [...new Set(lista.map((c) => c.nota.numero))];
    return {
      codigo: "E08",
      competencia,
      confianca: "ALTA" as const,
      descricao:
        `${lista.length} item(ns) de ${notas.length} NF-e com alíquota de ICMS acima da ` +
        `interestadual em saída para outra UF, somando ${moeda(total)} destacados a maior.`,
      textoCliente:
        `Em ${mesAno(competencia)} as notas ${notas.join(", ")} saíram para outros estados com ` +
        `alíquota interna em vez da interestadual. A empresa destacou e recolheu ` +
        `${moeda(total)} a mais de ICMS, e o cliente não consegue se creditar dessa diferença.`,
      recomendacao:
        "Corrigir o cadastro de tributação do emissor para operações interestaduais. " +
        "Avaliar a restituição do ICMS recolhido a maior, que depende de provar que o " +
        "imposto não foi repassado ao adquirente ou de autorização dele (CTN, art. 166).",
      valorExposicao: total,
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.nota.documento.nomeArquivo,
        documentoNumero: c.nota.numero,
        chave: c.nota.chave ?? undefined,
        dataDocumento: c.nota.dataEmissao.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
        valor: moeda(c.excesso),
        observacao:
          `item ${c.item.numeroItem} para ${c.nota.ufDestino}: ${pct(c.item.aliqIcms!)} aplicada, ` +
          `${pct(c.correta)} devida, base ${moeda(c.item.baseIcms!)}`,
      })),
    };
  });
}

/**
 * E10 — CFOP 6101/6102 em venda a não contribuinte de outra UF.
 *
 * A tabela de CFOP tem códigos próprios para venda a não contribuinte em outra
 * UF (6107 produção, 6108 revenda). É por eles que a UF de destino identifica o
 * DIFAL que lhe cabe; com 6101/6102 a operação parece venda a contribuinte.
 */
function e10CfopNaoContribuinte(ctx: ContextoRegra, saidas: Saida[]): AchadoProduzido[] {
  const casos = saidas.flatMap((nota) =>
    nota.indicadorIeDestinatario === "9"
      ? nota.itens
          .filter((i) => i.cfop === "6101" || i.cfop === "6102")
          .map((item) => ({ nota, item, competencia: nota.competencia }))
      : [],
  );

  return [...porCompetencia(casos)].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.item.valorItem), ZERO);
    const notas = [...new Set(lista.map((c) => c.nota.numero))];
    return {
      codigo: "E10",
      competencia,
      confianca: "ALTA" as const,
      descricao:
        `${notas.length} NF-e para não contribuinte de outra UF com CFOP de venda a ` +
        `contribuinte (6101/6102), somando ${moeda(total)}.`,
      textoCliente:
        `Em ${mesAno(competencia)} as notas ${notas.join(", ")} venderam para consumidor não ` +
        `contribuinte de outro estado usando CFOP de venda a contribuinte. O correto é 6107 ` +
        `(produção própria) ou 6108 (revenda).`,
      recomendacao: "Ajustar a regra de CFOP do emissor para destinatário com indicador de IE 9.",
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.nota.documento.nomeArquivo,
        documentoNumero: c.nota.numero,
        chave: c.nota.chave ?? undefined,
        dataDocumento: c.nota.dataEmissao.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
        valor: moeda(c.item.valorItem),
        observacao: `CFOP ${c.item.cfop} para ${c.nota.ufDestino}, destinatário não contribuinte (indIEDest 9)`,
      })),
    };
  });
}

/**
 * E07 — ICMS da NF-e diferente do escriturado.
 *
 * Os dois lados vão para o Fisco: o XML autorizado e a EFD. Se a EFD debita
 * menos que o documento, falta imposto; se debita mais, o imposto foi pago mas
 * o documento não o mostra — e o cruzamento da SEFAZ acusa a divergência do
 * mesmo jeito.
 */
async function e07IcmsXmlEfd(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const notas = await prisma.notaFiscal.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      cnpjEmitente: ctx.empresaCnpj,
      situacao: "AUTORIZADA",
      chave: { not: null },
    },
    select: {
      chave: true,
      numero: true,
      competencia: true,
      origem: true,
      dataEmissao: true,
      valorIcms: true,
      documento: { select: { nomeArquivo: true } },
    },
  });

  const pares = new Map<string, { xml?: (typeof notas)[number]; efd?: (typeof notas)[number] }>();
  for (const n of notas) {
    const p = pares.get(n.chave!) ?? {};
    if (n.origem === "XML_AUTORIZADO") p.xml = n;
    else p.efd = n;
    pares.set(n.chave!, p);
  }

  interface Caso { competencia: string; xml: (typeof notas)[number]; efd: (typeof notas)[number]; diferenca: Prisma.Decimal }
  const casos: Caso[] = [];
  for (const { xml, efd } of pares.values()) {
    if (!xml || !efd) continue;
    const diferenca = (efd.valorIcms ?? ZERO).minus(xml.valorIcms ?? ZERO);
    if (diferenca.abs().lessThanOrEqualTo(CENTAVO)) continue;
    casos.push({ competencia: xml.competencia, xml, efd, diferenca });
  }

  const achados: AchadoProduzido[] = [];
  for (const [competencia, lista] of porCompetencia(casos)) {
    for (const sentido of ["EFD_MENOR", "EFD_MAIOR"] as const) {
      const grupo = lista.filter((c) => (sentido === "EFD_MENOR" ? c.diferenca.isNegative() : c.diferenca.isPositive()));
      if (grupo.length === 0) continue;
      const total = grupo.reduce((s, c) => s.plus(c.diferenca.abs()), ZERO);
      const notasTxt = grupo.map((c) => c.xml.numero).join(", ");
      achados.push({
        codigo: "E07",
        competencia,
        severidade: sentido === "EFD_MENOR" ? "CRITICO" : "ALTO",
        confianca: "ALTA",
        descricao:
          sentido === "EFD_MENOR"
            ? `${grupo.length} NF-e com ICMS escriturado abaixo do destacado no XML, diferença de ${moeda(total)}.`
            : `${grupo.length} NF-e com ICMS escriturado acima do destacado no XML, diferença de ${moeda(total)}.`,
        textoCliente:
          sentido === "EFD_MENOR"
            ? `Em ${mesAno(competencia)} as notas ${notasTxt} destacaram ${moeda(total)} de ICMS a mais ` +
              `do que a escrituração levou à apuração. É imposto cobrado do cliente e não declarado.`
            : `Em ${mesAno(competencia)} as notas ${notasTxt} foram escrituradas com ${moeda(total)} de ICMS ` +
              `que o documento não destaca. O imposto entrou na apuração, mas a nota não o mostra, e ` +
              `o cruzamento da SEFAZ acusa a divergência.`,
        recomendacao:
          sentido === "EFD_MENOR"
            ? "Retificar a EFD da competência e recolher a diferença com denúncia espontânea."
            : "Emitir NF-e complementar de ICMS vinculada às notas, para alinhar documento e escrituração.",
        valorExposicao: total,
        declarado: sentido !== "EFD_MENOR",
        evidencias: grupo.slice(0, 15).map((c) => ({
          tipo: "EXEMPLO" as const,
          arquivo: c.xml.documento.nomeArquivo,
          documentoNumero: c.xml.numero,
          chave: c.xml.chave ?? undefined,
          dataDocumento: c.xml.dataEmissao.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
          valor: moeda(c.diferenca.abs()),
          observacao: `ICMS no XML ${moeda(c.xml.valorIcms ?? ZERO)} · na EFD (${c.efd.documento.nomeArquivo}) ${moeda(c.efd.valorIcms ?? ZERO)}`,
        })),
      });
    }
  }
  return achados;
}

/**
 * E09 — item tributado sem ICMS em saída interestadual.
 *
 * CST 00 declara tributação integral. Item com esse CST, alíquota zero e sem
 * imposto não tem benefício que o explique. Só vira achado quando a EFD também
 * não debitou: se a escrituração cobriu o imposto, o caso é o E07.
 */
async function e09ItemSemIcms(ctx: ContextoRegra, saidas: Saida[]): Promise<AchadoProduzido[]> {
  const escrituradas = await prisma.notaFiscal.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      origem: "ESCRITURACAO",
      chave: { in: saidas.map((s) => s.chave).filter((c): c is string => Boolean(c)) },
    },
    select: { chave: true, valorIcms: true },
  });
  const icmsEfd = new Map(escrituradas.map((e) => [e.chave!, e.valorIcms ?? ZERO]));

  interface Caso { competencia: string; nota: Saida; item: Saida["itens"][number]; devido: Prisma.Decimal; aliquota: Prisma.Decimal }
  const casos: Caso[] = [];
  for (const nota of saidas) {
    const semImposto = nota.itens.filter(
      (i) => i.cstIcms?.endsWith("00") && (!i.valorIcms || i.valorIcms.isZero()) && i.valorItem.greaterThan(0),
    );
    if (semImposto.length === 0) continue;
    const devidos = semImposto.map((item) => {
      const aliquota = aliquotaInterestadual(ctx.empresaUf!, nota.ufDestino!, item.origemMercadoria);
      return { item, aliquota, devido: item.valorItem.times(aliquota).dividedBy(100).toDecimalPlaces(2) };
    });
    const faltante = devidos.reduce((s, d) => s.plus(d.devido), ZERO);
    const escriturado = nota.chave ? icmsEfd.get(nota.chave) : undefined;
    // A EFD cobriu o imposto dos itens sem destaque: é divergência de documento (E07).
    if (escriturado && escriturado.greaterThanOrEqualTo((nota.valorIcms ?? ZERO).plus(faltante).minus(CENTAVO))) continue;
    for (const d of devidos) casos.push({ competencia: nota.competencia, nota, ...d });
  }

  return [...porCompetencia(casos)].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.devido), ZERO);
    const notas = [...new Set(lista.map((c) => c.nota.numero))];
    return {
      codigo: "E09",
      competencia,
      severidade: "CRITICO" as const,
      confianca: "ALTA" as const,
      descricao:
        `${lista.length} item(ns) com CST 00 sem ICMS em saída interestadual, ` +
        `${moeda(total)} de imposto não destacado nem escriturado.`,
      textoCliente:
        `Em ${mesAno(competencia)} as notas ${notas.join(", ")} têm itens tributados vendidos para outro ` +
        `estado sem ICMS. O imposto de ${moeda(total)} não foi destacado nem levado à apuração.`,
      recomendacao:
        "Emitir NF-e complementar de ICMS, retificar a EFD da competência e recolher a diferença " +
        "com denúncia espontânea. Revisar o cadastro de tributação dos produtos.",
      valorExposicao: total,
      declarado: false,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.nota.documento.nomeArquivo,
        documentoNumero: c.nota.numero,
        chave: c.nota.chave ?? undefined,
        dataDocumento: c.nota.dataEmissao.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
        valor: moeda(c.devido),
        observacao: `item ${c.item.numeroItem} (CST ${c.item.cstIcms}, ${moeda(c.item.valorItem)}) para ${c.nota.ufDestino} sem ICMS; devido a ${pct(c.aliquota)}`,
      })),
    };
  });
}

/**
 * E02 — DIFAL destacado na NF-e e não escriturado.
 *
 * Venda a não contribuinte de outra UF: o grupo ICMSUFDest do XML diz quanto de
 * DIFAL cabe à UF de destino. A EFD tem de levar esse valor ao E300/E310 daquela
 * UF. UF aberta com o E310 zerado — ou nem aberta — é DIFAL cobrado no documento
 * e não declarado ao estado de destino.
 */
async function e02DifalNaoEscriturado(ctx: ContextoRegra, saidas: Saida[]): Promise<AchadoProduzido[]> {
  const difalPorChave = new Map<string, { competencia: string; uf: string; valor: Prisma.Decimal; notas: Saida[] }>();
  for (const nota of saidas) {
    const valor = nota.itens.reduce((s, i) => s.plus(i.valorDifal ?? ZERO), ZERO);
    if (valor.isZero()) continue;
    const chave = `${nota.competencia}|${nota.ufDestino}`;
    const atual = difalPorChave.get(chave) ?? { competencia: nota.competencia, uf: nota.ufDestino!, valor: ZERO, notas: [] };
    atual.valor = atual.valor.plus(valor);
    atual.notas.push(nota);
    difalPorChave.set(chave, atual);
  }
  if (difalPorChave.size === 0) return [];

  const [escrituracoes, apuracoes] = await Promise.all([
    prisma.escrituracaoArquivo.findMany({
      where: { documento: { auditoriaId: ctx.auditoriaId, tipo: "SPED_FISCAL" } },
      select: { competencia: true },
    }),
    prisma.apuracaoDifal.findMany({
      where: { documento: { auditoriaId: ctx.auditoriaId } },
      include: { documento: { select: { nomeArquivo: true } } },
    }),
  ]);
  const competenciasComEfd = new Set(escrituracoes.map((e) => e.competencia));

  const achados: AchadoProduzido[] = [];
  for (const d of difalPorChave.values()) {
    if (!competenciasComEfd.has(d.competencia)) continue;
    const apuracao = apuracoes.find((a) => a.competencia === d.competencia && a.uf === d.uf);
    const escriturado = apuracao?.totalDebitos ?? ZERO;
    const diferenca = d.valor.minus(escriturado);
    if (diferenca.lessThanOrEqualTo(CENTAVO)) continue;

    achados.push({
      codigo: "E02",
      competencia: d.competencia,
      severidade: "CRITICO",
      confianca: "ALTA",
      descricao:
        `DIFAL de ${moeda(d.valor)} destacado para ${d.uf} e ${moeda(escriturado)} escriturado no E310 da UF.`,
      textoCliente:
        `Em ${mesAno(d.competencia)} a empresa destacou ${moeda(d.valor)} de diferencial de alíquota ` +
        `devido a ${d.uf} nas notas ${d.notas.map((n) => n.numero).join(", ")}, e a escrituração não ` +
        `levou ${moeda(diferenca)} à apuração daquele estado. É imposto do estado de destino não declarado.`,
      recomendacao:
        `Retificar a EFD da competência lançando o DIFAL no E300/E310 de ${d.uf} e recolher por GNRE, ` +
        "com os acréscimos. Conferir a inscrição estadual ou o recolhimento por operação no estado de destino.",
      valorExposicao: diferenca,
      declarado: false,
      evidencias: [
        {
          tipo: "CONFRONTO",
          arquivo: "XML das NF-e",
          campo: `DIFAL destacado para ${d.uf} (ICMSUFDest.vICMSUFDest)`,
          valor: moeda(d.valor),
        },
        {
          tipo: "CONFRONTO",
          arquivo: apuracao?.documento.nomeArquivo ?? `EFD ${mesAno(d.competencia)}`,
          registro: "E310",
          campo: apuracao ? `Débitos de DIFAL escriturados para ${d.uf}` : `Nenhum E300 aberto para ${d.uf}`,
          valor: moeda(escriturado),
        },
        ...d.notas.slice(0, 15).map((n) => ({
          tipo: "EXEMPLO" as const,
          arquivo: n.documento.nomeArquivo,
          documentoNumero: n.numero,
          chave: n.chave ?? undefined,
          dataDocumento: n.dataEmissao.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
          valor: moeda(n.itens.reduce((s, i) => s.plus(i.valorDifal ?? ZERO), ZERO)),
          observacao: `DIFAL destacado para ${n.ufDestino}, destinatário com indIEDest ${n.indicadorIeDestinatario ?? "?"}`,
        })),
      ],
    });
  }
  return achados;
}

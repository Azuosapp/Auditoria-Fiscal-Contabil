import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família E — CFOP.
 *
 * O CFOP diz ao fisco o que a operação é. Errá-lo não muda sozinho o ICMS do
 * mês, mas muda o que a empresa declara ser: industrial que "revende" o que
 * fabrica esconde a produção do IPI e do Bloco K; compra interna com CFOP
 * interestadual distorce a apuração por UF; mercadoria recebida para
 * industrializar sem retorno é estoque de terceiro que sumiu.
 *
 *   E11 — produção própria vendida com CFOP de revenda
 *   E12 — CFOP de entrada incompatível com a UF do emitente
 *   E13 — entrada para industrialização por encomenda sem retorno nem cobrança
 */

const ZERO = new Prisma.Decimal(0);

/** Código IBGE da UF — os dois primeiros dígitos da chave de acesso. */
const UF_POR_CODIGO: Record<string, string> = {
  "11": "RO", "12": "AC", "13": "AM", "14": "RR", "15": "PA", "16": "AP", "17": "TO",
  "21": "MA", "22": "PI", "23": "CE", "24": "RN", "25": "PB", "26": "PE", "27": "AL",
  "28": "SE", "29": "BA", "31": "MG", "32": "ES", "33": "RJ", "35": "SP", "41": "PR",
  "42": "SC", "43": "RS", "50": "MS", "51": "MT", "52": "GO", "53": "DF",
};

const CFOP_VENDA_PRODUCAO = new Set(["5101", "6101", "6107", "5103", "6103", "5105", "6105", "5401", "6401"]);
const CFOP_VENDA_REVENDA = new Set(["5102", "6102", "6108"]);
const CFOP_COMPRA_REVENDA = new Set(["1102", "2102", "1403", "2403", "1152", "2152", "1409", "2409"]);

/** Entrada de insumo de terceiro para industrializar e devolver. */
const CFOP_ENTRADA_ENCOMENDA = new Set(["1901", "2901", "1924", "2924"]);
/** Retorno do insumo (5902/5925) ou cobrança da industrialização (5124/5125). */
const CFOP_RETORNO_ENCOMENDA = new Set([
  "5902", "6902", "5925", "6925", "5124", "6124", "5125", "6125",
]);

export const familiaECfop: Regra = {
  codigos: ["E11", "E12", "E13"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    const achados: AchadoProduzido[] = [];
    if (ctx.fontesDisponiveis.has("NFE_XML")) {
      achados.push(...(await e11ProducaoComoRevenda(ctx)));
    }
    if (ctx.empresaUf) achados.push(...(await e12CfopEntradaUf(ctx)));
    if (ctx.fontesDisponiveis.has("NFE_XML") && ctx.fontesDisponiveis.has("SPED_FISCAL")) {
      achados.push(...(await e13EncomendaSemRetorno(ctx)));
    }
    return achados;
  },
};

function dataBr(d: Date): string {
  return d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

function porCompetencia<T extends { competencia: string }>(lista: T[]): Map<string, T[]> {
  const mapa = new Map<string, T[]>();
  for (const x of lista) mapa.set(x.competencia, [...(mapa.get(x.competencia) ?? []), x]);
  return mapa;
}

/**
 * E11 — produção própria vendida com CFOP de revenda.
 *
 * Três condições, todas verificáveis nos arquivos: a empresa é industrial
 * (IND_ATIV 0 na EFD, ou vende com CFOP de produção); o mesmo NCM sai em outras
 * notas com CFOP de produção; e esse NCM nunca entrou com CFOP de compra para
 * revenda. Sem a terceira condição (EFD ausente) a confiança cai para média —
 * a empresa pode ter comprado e revendido o mesmo produto que fabrica.
 */
async function e11ProducaoComoRevenda(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const saidas = await prisma.notaFiscal.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      origem: "XML_AUTORIZADO",
      situacao: "AUTORIZADA",
      direcao: "SAIDA",
      cnpjEmitente: ctx.empresaCnpj,
    },
    include: { itens: true, documento: { select: { nomeArquivo: true } } },
    orderBy: { dataEmissao: "asc" },
  });

  const ncmProducao = new Set<string>();
  for (const n of saidas) {
    for (const i of n.itens) if (i.ncm && CFOP_VENDA_PRODUCAO.has(i.cfop ?? "")) ncmProducao.add(i.ncm);
  }

  const industrialNaEfd = await prisma.escrituracaoArquivo.count({
    where: { documento: { auditoriaId: ctx.auditoriaId }, indAtividade: "0" },
  });
  if (industrialNaEfd === 0 && ncmProducao.size === 0) return [];

  const temEfd = ctx.fontesDisponiveis.has("SPED_FISCAL");
  const ncmCompraRevenda = new Set<string>();
  if (temEfd) {
    const compras = await prisma.notaFiscalItem.findMany({
      where: {
        nota: { documento: { auditoriaId: ctx.auditoriaId }, direcao: "ENTRADA" },
        cfop: { in: [...CFOP_COMPRA_REVENDA] },
        NOT: { ncm: null },
      },
      select: { ncm: true },
      distinct: ["ncm"],
    });
    for (const c of compras) ncmCompraRevenda.add(c.ncm!);
  }

  const casos = saidas.flatMap((nota) =>
    nota.itens
      .filter((i) => CFOP_VENDA_REVENDA.has(i.cfop ?? "") && i.ncm && !ncmCompraRevenda.has(i.ncm))
      .map((item) => ({ nota, item, competencia: nota.competencia })),
  );
  if (casos.length === 0) return [];

  return [...porCompetencia(casos)].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.item.valorItem), ZERO);
    const notas = [...new Set(lista.map((c) => c.nota.numero))];
    const confirmado = temEfd && lista.every((c) => ncmProducao.has(c.item.ncm!));
    return {
      codigo: "E11",
      competencia,
      confianca: confirmado ? ("ALTA" as const) : ("MEDIA" as const),
      descricao:
        `${lista.length} item(ns) de ${notas.length} NF-e vendidos com CFOP de revenda, somando ` +
        `${moeda(total)}, em empresa industrial e sem compra para revenda do mesmo NCM.`,
      textoCliente:
        `Em ${mesAno(competencia)} as notas ${notas.join(", ")} saíram com CFOP de revenda ` +
        `(5102/6102) para produtos que a empresa fabrica. O CFOP correto é o de venda de ` +
        `produção (5101/6101), que também sujeita a saída ao IPI e ao controle do Bloco K.`,
      recomendacao:
        "Corrigir o CFOP no cadastro dos produtos fabricados e rever a incidência de IPI " +
        "sobre essas saídas.",
      ressalva: confirmado
        ? undefined
        : "Confirmar que o produto é fabricado pela empresa e não adquirido pronto de terceiro.",
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.nota.documento.nomeArquivo,
        documentoNumero: c.nota.numero,
        chave: c.nota.chave ?? undefined,
        dataDocumento: dataBr(c.nota.dataEmissao),
        valor: moeda(c.item.valorItem),
        observacao:
          `CFOP ${c.item.cfop} · ${c.item.descricao ?? "item"} · NCM ${c.item.ncm}` +
          (ncmProducao.has(c.item.ncm!) ? " — o mesmo NCM sai com CFOP de produção em outras notas" : "") +
          (temEfd ? "; nenhuma entrada para revenda desse NCM na EFD" : ""),
      })),
    };
  });
}

/**
 * E12 — CFOP de entrada incompatível com a UF do emitente.
 *
 * O primeiro dígito do CFOP de entrada diz de onde veio a mercadoria: 1 do
 * próprio estado, 2 de outro. A chave de acesso diz de onde ela veio de fato.
 * Só se examina nota de terceiro: na nota de entrada emitida pela própria
 * empresa (devolução de venda) a origem é o cliente, não o emitente.
 */
async function e12CfopEntradaUf(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const itens = await prisma.notaFiscalItem.findMany({
    where: {
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        direcao: "ENTRADA",
        situacao: "AUTORIZADA",
        NOT: [{ cnpjEmitente: ctx.empresaCnpj }, { chave: null }],
      },
      OR: [{ cfop: { startsWith: "1" } }, { cfop: { startsWith: "2" } }],
    },
    include: {
      nota: { include: { documento: { select: { nomeArquivo: true } } } },
    },
    orderBy: [{ nota: { dataEmissao: "asc" } }, { numeroItem: "asc" }],
  });

  const casos = itens.flatMap((item) => {
    const chave = item.nota.chave ?? "";
    const ufEmitente = chave.length === 44 ? UF_POR_CODIGO[chave.slice(0, 2)] : undefined;
    if (!ufEmitente) return [];
    const interna = ufEmitente === ctx.empresaUf;
    const cfopInterno = item.cfop!.startsWith("1");
    if (interna === cfopInterno) return [];
    return [{ item, nota: item.nota, ufEmitente, competencia: item.nota.competencia }];
  });

  return [...porCompetencia(casos)].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.item.valorItem), ZERO);
    const notas = [...new Set(lista.map((c) => c.nota.numero))];
    const cfops = [...new Set(lista.map((c) => c.item.cfop))].join(", ");
    return {
      codigo: "E12",
      competencia,
      confianca: "ALTA" as const,
      descricao:
        `${lista.length} item(ns) de ${notas.length} nota(s) de entrada com CFOP ${cfops} ` +
        `incompatível com a UF do emitente, somando ${moeda(total)}.`,
      textoCliente:
        `Em ${mesAno(competencia)} as entradas das notas ${notas.join(", ")} foram escrituradas ` +
        `com CFOP ${cfops}, que não corresponde à UF de quem vendeu.`,
      recomendacao:
        "Corrigir a regra de conversão de CFOP na importação das notas de entrada: " +
        "1xxx para fornecedor do próprio estado, 2xxx para fornecedor de outro estado.",
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.nota.documento.nomeArquivo,
        documentoNumero: c.nota.numero,
        chave: c.nota.chave ?? undefined,
        dataDocumento: dataBr(c.nota.dataEmissao),
        participante: c.nota.cnpjEmitente,
        valor: moeda(c.item.valorItem),
        observacao:
          `CFOP ${c.item.cfop} · emitente em ${c.ufEmitente} (chave), empresa em ${ctx.empresaUf}` +
          (c.item.descricao ? ` · ${c.item.descricao}` : ""),
      })),
    };
  });
}

/**
 * E13 — industrialização por encomenda sem retorno nem cobrança.
 *
 * Quem recebe insumo de terceiro com 1901/1924 fica com a suspensão do ICMS
 * condicionada ao retorno. Sem nota de retorno (5902/5925) nem de cobrança da
 * industrialização (5124/5125), a mercadoria é estoque alheio sem saída
 * documentada — e o fisco presume saída sem nota.
 *
 * A entrada nos últimos 60 dias do período pode ter retorno logo depois do
 * último arquivo recebido: nesse caso a confiança é média.
 */
async function e13EncomendaSemRetorno(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const entradas = await prisma.notaFiscalItem.findMany({
    where: {
      cfop: { in: [...CFOP_ENTRADA_ENCOMENDA] },
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        direcao: "ENTRADA",
        situacao: "AUTORIZADA",
        NOT: { cnpjEmitente: ctx.empresaCnpj },
      },
    },
    include: { nota: { include: { documento: { select: { nomeArquivo: true } } } } },
    orderBy: { nota: { dataEmissao: "asc" } },
  });
  if (entradas.length === 0) return [];

  const retornos = await prisma.notaFiscalItem.findMany({
    where: {
      cfop: { in: [...CFOP_RETORNO_ENCOMENDA] },
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        cnpjEmitente: ctx.empresaCnpj,
        situacao: "AUTORIZADA",
      },
    },
    select: { nota: { select: { dataEmissao: true } } },
  });
  const ultimaSaida = await prisma.notaFiscal.aggregate({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      origem: "XML_AUTORIZADO",
      cnpjEmitente: ctx.empresaCnpj,
    },
    _max: { dataEmissao: true },
  });
  const fim = ultimaSaida._max.dataEmissao;
  if (!fim) return [];

  const semRetorno = entradas.filter(
    (e) => !retornos.some((r) => r.nota.dataEmissao >= e.nota.dataEmissao),
  );
  const casos = semRetorno.map((item) => ({ item, nota: item.nota, competencia: item.nota.competencia }));

  return [...porCompetencia(casos)].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.item.valorItem), ZERO);
    const notas = [...new Set(lista.map((c) => c.nota.numero))];
    const recente = lista.some(
      (c) => fim.getTime() - c.nota.dataEmissao.getTime() < 60 * 86_400_000,
    );
    return {
      codigo: "E13",
      competencia,
      confianca: recente ? ("MEDIA" as const) : ("ALTA" as const),
      descricao:
        `${lista.length} item(ns) recebido(s) para industrialização por encomenda, somando ` +
        `${moeda(total)}, sem nota de retorno nem de cobrança até ${dataBr(fim)}.`,
      textoCliente:
        `Em ${mesAno(competencia)} a empresa recebeu ${moeda(total)} em mercadoria de terceiro ` +
        `para industrializar (notas ${notas.join(", ")}) e não emitiu nota de retorno nem de ` +
        `cobrança da industrialização. Sem essas notas, a suspensão do ICMS cai e a ` +
        `mercadoria é tratada como saída sem documento.`,
      recomendacao:
        "Localizar as notas de retorno (5902/5925) e de cobrança (5124/5125); se não foram " +
        "emitidas, emiti-las ou recolher o ICMS da saída.",
      ressalva: recente
        ? "A entrada é próxima do fim do período recebido; o retorno pode ter saído depois."
        : "O retorno pode ter sido emitido por outro estabelecimento ou estar fora dos arquivos recebidos.",
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.nota.documento.nomeArquivo,
        documentoNumero: c.nota.numero,
        chave: c.nota.chave ?? undefined,
        dataDocumento: dataBr(c.nota.dataEmissao),
        participante: c.nota.cnpjEmitente,
        valor: moeda(c.item.valorItem),
        observacao:
          `CFOP ${c.item.cfop}${c.item.descricao ? ` · ${c.item.descricao}` : ""} · nenhuma ` +
          `saída 5902/5925/5124/5125 depois dessa data`,
      })),
    };
  });
}

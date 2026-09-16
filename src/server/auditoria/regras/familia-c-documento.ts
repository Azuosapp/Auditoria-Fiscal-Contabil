import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família C — crédito e alíquota lidos item a item.
 *
 *   C05 — crédito de ICMS sobre bem de uso e consumo ou alheio à atividade
 *   C06 — PIS/COFINS destacado na NF-e com alíquota de outro regime
 *   C09 — PIS/COFINS sobre exportação ou venda de imobilizado
 */

const ZERO = new Prisma.Decimal(0);

/** Entrada que a própria empresa classificou como uso e consumo. */
const CFOP_USO_CONSUMO = new Set(["1556", "2556", "1407", "2407"]);

interface Categoria {
  nome: string;
  /** ALTA: alheio à produção em qualquer indústria. MEDIA: depende de laudo. */
  confianca: "ALTA" | "MEDIA";
  ncm?: RegExp;
  descricao?: RegExp;
}

/**
 * Categorias por NCM e, onde o NCM é genérico demais, pela descrição.
 *
 * Abrasivos, serras e brocas ficam em confiança média: numa metalúrgica se
 * gastam no processo e o crédito se sustenta com laudo de consumo na produção.
 */
const CATEGORIAS: Categoria[] = [
  {
    nome: "material de construção, hidráulico e louças",
    confianca: "ALTA",
    ncm: /^(3214|39172|391740|3922|3925|6802|6907|6908|6910|6911|6912|7013|7324|730830)/,
    descricao: /TORNEIRA|SIF[AÃ]O|LAVAT[OÓ]RIO|CAIXA DE? ?DESCARGA|CAIXA D.?[AÁ]GUA|\bPIA\b|ESGOTO|VASO SANIT|CHUVEIRO|ASSENTO (SANIT|UNIVERSAL)|REJUNTE|ARGAMASSA/i,
  },
  {
    nome: "peças e manutenção de veículo",
    confianca: "ALTA",
    ncm: /^(8409|8708|841330|40103|8511)/,
    descricao: /\bL200\b|TRITON|PIST[AÃ]O|ALTERNADOR|JUNTA (DO )?MOTOR|ANEL MOTOR|15W40|OLEO (DE )?MOTOR|EMBREAGEM|PASTILHA DE FREIO/i,
  },
  {
    nome: "equipamento de proteção individual",
    confianca: "ALTA",
    ncm: /^(4203|6116|640[1-5]|6506|9004|40151)/,
    descricao: /\bEPI\b|BOTINA|AVENTAL|CAPACETE|PROTETOR AURICULAR|LUVA (DE )?RASPA/i,
  },
  {
    nome: "ferramentas manuais",
    confianca: "ALTA",
    ncm: /^(8201|8203|8204|8205)/,
  },
  {
    nome: "equipamento de escritório e máquina de cartão",
    confianca: "ALTA",
    ncm: /^(8470|8471|8443|8517)/,
  },
  {
    nome: "abrasivos, serras e brocas",
    confianca: "MEDIA",
    ncm: /^(6804|6805|8202|8207)/,
  },
];

export const familiaCDocumento: Regra = {
  codigos: ["C05", "C06", "C09"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    const achados: AchadoProduzido[] = [];
    if (ctx.fontesDisponiveis.has("SPED_FISCAL")) {
      achados.push(...(await c05CreditoUsoConsumo(ctx)));
    }
    if (ctx.fontesDisponiveis.has("NFE_XML")) {
      achados.push(...(await c06AliquotaPisCofinsDeOutroRegime(ctx)));
      achados.push(...(await c09BaseIndevidaPisCofins(ctx)));
    }
    return achados;
  },
};

function dataBr(d: Date): string {
  return d.toLocaleDateString("pt-BR", { timeZone: "UTC" });
}

function pct(v: Prisma.Decimal): string {
  return `${v.toFixed(2).replace(".", ",")}%`;
}

function categoriaDe(ncm: string | null, descricao: string | null): Categoria | undefined {
  return CATEGORIAS.find(
    (c) => (c.ncm && ncm && c.ncm.test(ncm)) || (c.descricao && descricao && c.descricao.test(descricao)),
  );
}

/**
 * C05 — crédito de ICMS sobre uso e consumo.
 *
 * O crédito de material de uso e consumo só é admitido a partir de 2033 (LC
 * 87/1996, art. 33, I), e o de bem alheio à atividade nunca (art. 20, § 1º).
 * O VL_ICMS do C170 é o crédito que a empresa tomou.
 *
 * Duas travas contra falso positivo: o item não pode ter NCM (posição de 4
 * dígitos) que a empresa também venda — aí pode ser mercadoria de revenda —, e
 * a entrada com CFOP de uso e consumo com crédito é apontada sem depender de
 * categoria, porque é a própria empresa dizendo que o bem é de consumo.
 */
async function c05CreditoUsoConsumo(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const entradas = await prisma.notaFiscalItem.findMany({
    where: {
      valorIcms: { gt: 0 },
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "ESCRITURACAO",
        direcao: "ENTRADA",
        NOT: { cnpjEmitente: ctx.empresaCnpj },
      },
    },
    include: { nota: { include: { documento: { select: { nomeArquivo: true } } } } },
    orderBy: [{ nota: { dataEmissao: "asc" } }, { numeroItem: "asc" }],
  });
  if (entradas.length === 0) return [];

  const vendidas = await prisma.notaFiscalItem.findMany({
    where: {
      nota: { documento: { auditoriaId: ctx.auditoriaId }, direcao: "SAIDA", cnpjEmitente: ctx.empresaCnpj },
      NOT: { ncm: null },
    },
    select: { ncm: true },
    distinct: ["ncm"],
  });
  const posicoesVendidas = new Set(vendidas.map((v) => v.ncm!.slice(0, 4)));

  type Caso = {
    item: (typeof entradas)[number];
    categoria: string;
    confianca: "ALTA" | "MEDIA";
    competencia: string;
  };
  const casos: Caso[] = [];
  for (const item of entradas) {
    const competencia = item.nota.competencia;
    if (CFOP_USO_CONSUMO.has(item.cfop ?? "")) {
      casos.push({ item, categoria: `CFOP ${item.cfop} (uso e consumo)`, confianca: "ALTA", competencia });
      continue;
    }
    if (item.ncm && posicoesVendidas.has(item.ncm.slice(0, 4))) continue;
    const cat = categoriaDe(item.ncm, item.descricao);
    if (cat) casos.push({ item, categoria: cat.nome, confianca: cat.confianca, competencia });
  }

  const achados: AchadoProduzido[] = [];
  for (const confianca of ["ALTA", "MEDIA"] as const) {
    const doNivel = casos.filter((c) => c.confianca === confianca);
    const porComp = new Map<string, Caso[]>();
    for (const c of doNivel) porComp.set(c.competencia, [...(porComp.get(c.competencia) ?? []), c]);

    for (const [competencia, lista] of porComp) {
      const total = lista.reduce((s, c) => s.plus(c.item.valorIcms ?? ZERO), ZERO);
      const categorias = [...new Set(lista.map((c) => c.categoria))];
      const notas = [...new Set(lista.map((c) => c.item.nota.numero))];
      achados.push({
        codigo: "C05",
        competencia,
        severidade: confianca === "ALTA" ? "ALTO" : "MEDIO",
        confianca,
        descricao:
          `${moeda(total)} de crédito de ICMS em ${lista.length} item(ns) de ${notas.length} ` +
          `nota(s): ${categorias.join("; ")}.`,
        textoCliente:
          confianca === "ALTA"
            ? `Em ${mesAno(competencia)} a empresa se creditou de ${moeda(total)} de ICMS sobre ` +
              `${categorias.join(", ")}, bens que não entram na produção. O crédito deve ser estornado.`
            : `Em ${mesAno(competencia)} há ${moeda(total)} de crédito de ICMS sobre ` +
              `${categorias.join(", ")}, que só se sustenta com laudo de consumo na produção.`,
        recomendacao:
          confianca === "ALTA"
            ? "Estornar o crédito na apuração (E111) e corrigir o cadastro de tributação das " +
              "entradas de uso e consumo."
            : "Obter laudo técnico que demonstre o consumo no processo produtivo; sem ele, estornar o crédito.",
        valorExposicao: total,
        ressalva:
          confianca === "ALTA"
            ? undefined
            : "Abrasivos, serras e brocas consumidos no processo industrial podem gerar crédito como insumo.",
        declarado: true,
        evidencias: lista.slice(0, 15).map((c) => ({
          tipo: "EXEMPLO" as const,
          arquivo: c.item.nota.documento.nomeArquivo,
          registro: "C170",
          documentoNumero: c.item.nota.numero,
          chave: c.item.nota.chave ?? undefined,
          dataDocumento: dataBr(c.item.nota.dataEmissao),
          participante: c.item.nota.cnpjEmitente,
          valor: moeda(c.item.valorIcms ?? ZERO),
          observacao:
            `${c.item.descricao ?? "item"} · NCM ${c.item.ncm ?? "—"} · CFOP ${c.item.cfop} · ` +
            `${moeda(c.item.valorItem)} · ${c.categoria}`,
        })),
      });
    }
  }
  return achados;
}

/**
 * C06 — PIS/COFINS destacado com alíquota de outro regime.
 *
 * No Lucro Presumido (cumulativo) as alíquotas são 0,65% e 3%; 1,65% e 7,6% são
 * do não cumulativo. O destaque na nota não cria o débito — ele nasce na
 * EFD-Contribuições —, mas mostra o cadastro fiscal errado, e o erro costuma
 * ir junto para a apuração.
 *
 * No Lucro Real a alíquota cumulativa pode ser legítima (receitas que a lei
 * mantém no regime cumulativo), então lá a confiança é média.
 */
async function c06AliquotaPisCofinsDeOutroRegime(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const itens = await prisma.notaFiscalItem.findMany({
    where: {
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "XML_AUTORIZADO",
        situacao: "AUTORIZADA",
        direcao: "SAIDA",
        cnpjEmitente: ctx.empresaCnpj,
      },
      OR: [{ aliqPis: { gt: 0 } }, { aliqCofins: { gt: 0 } }],
    },
    include: { nota: { include: { documento: { select: { nomeArquivo: true } } } } },
    orderBy: [{ nota: { dataEmissao: "asc" } }, { numeroItem: "asc" }],
  });

  const NAO_CUMULATIVO = { pis: new Prisma.Decimal("1.65"), cofins: new Prisma.Decimal("7.6") };
  const CUMULATIVO = { pis: new Prisma.Decimal("0.65"), cofins: new Prisma.Decimal("3") };

  type Caso = { item: (typeof itens)[number]; competencia: string; regime: string };
  const casos: Caso[] = [];
  for (const item of itens) {
    const competencia = item.nota.competencia;
    const regime = ctx.regimePorExercicio.get(Number(competencia.slice(0, 4)));
    const esperado =
      regime === "LUCRO_PRESUMIDO" ? CUMULATIVO : regime === "LUCRO_REAL" ? NAO_CUMULATIVO : undefined;
    const outro = regime === "LUCRO_PRESUMIDO" ? NAO_CUMULATIVO : regime === "LUCRO_REAL" ? CUMULATIVO : undefined;
    if (!esperado || !outro) continue;
    const pisDoOutro = item.aliqPis?.equals(outro.pis);
    const cofinsDoOutro = item.aliqCofins?.equals(outro.cofins);
    if (pisDoOutro || cofinsDoOutro) casos.push({ item, competencia, regime: regime! });
  }

  const porComp = new Map<string, Caso[]>();
  for (const c of casos) porComp.set(c.competencia, [...(porComp.get(c.competencia) ?? []), c]);

  return [...porComp].map(([competencia, lista]) => {
    const presumido = lista[0].regime === "LUCRO_PRESUMIDO";
    const total = lista.reduce((s, c) => s.plus(c.item.valorItem), ZERO);
    const notas = [...new Set(lista.map((c) => c.item.nota.numero))];
    const nomeRegime = presumido ? "Lucro Presumido (cumulativo, 0,65% e 3%)" : "Lucro Real (não cumulativo, 1,65% e 7,6%)";
    return {
      codigo: "C06",
      competencia,
      confianca: presumido ? ("ALTA" as const) : ("MEDIA" as const),
      descricao:
        `${lista.length} item(ns) de ${notas.length} NF-e, somando ${moeda(total)}, com PIS/COFINS ` +
        `destacado na alíquota do outro regime; a empresa está no ${nomeRegime}.`,
      textoCliente:
        `Em ${mesAno(competencia)} as notas ${notas.join(", ")} destacam PIS/COFINS com alíquota ` +
        `que não é a do regime da empresa, o ${nomeRegime}.`,
      recomendacao:
        "Corrigir o cadastro de tributação de PIS/COFINS do emissor e conferir se a " +
        "EFD-Contribuições apurou com a alíquota do regime.",
      ressalva: presumido
        ? undefined
        : "No Lucro Real, algumas receitas permanecem no regime cumulativo por lei (Lei nº 10.833/2003, art. 10).",
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.item.nota.documento.nomeArquivo,
        documentoNumero: c.item.nota.numero,
        chave: c.item.nota.chave ?? undefined,
        dataDocumento: dataBr(c.item.nota.dataEmissao),
        valor: moeda(c.item.valorItem),
        observacao:
          `item ${c.item.numeroItem} · PIS ${c.item.aliqPis ? pct(c.item.aliqPis) : "—"} · ` +
          `COFINS ${c.item.aliqCofins ? pct(c.item.aliqCofins) : "—"} · CST ${c.item.cstPis ?? "—"}`,
      })),
    };
  });
}

/**
 * C09 — PIS/COFINS sobre receita que não integra a base.
 *
 * Exportação (CFOP 7xxx) é imune (CF, art. 149, § 2º, I) e a venda de bem do
 * ativo imobilizado (5551/6551) fica fora da base nos dois regimes. Item com
 * CST de PIS 01 ou 02 nessas operações indica que a receita foi tributada.
 *
 * É oportunidade de recuperação, com confiança média: o destaque na nota não
 * prova o recolhimento, que está na EFD-Contribuições.
 */
async function c09BaseIndevidaPisCofins(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const itens = await prisma.notaFiscalItem.findMany({
    where: {
      cstPis: { in: ["01", "02"] },
      OR: [{ cfop: { startsWith: "7" } }, { cfop: { in: ["5551", "6551"] } }],
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "XML_AUTORIZADO",
        situacao: "AUTORIZADA",
        direcao: "SAIDA",
        cnpjEmitente: ctx.empresaCnpj,
      },
    },
    include: { nota: { include: { documento: { select: { nomeArquivo: true } } } } },
    orderBy: [{ nota: { dataEmissao: "asc" } }, { numeroItem: "asc" }],
  });

  type Caso = { item: (typeof itens)[number]; competencia: string; tributo: Prisma.Decimal };
  const casos: Caso[] = itens.map((item) => ({
    item,
    competencia: item.nota.competencia,
    tributo: item.valorItem
      .times((item.aliqPis ?? ZERO).plus(item.aliqCofins ?? ZERO))
      .dividedBy(100)
      .toDecimalPlaces(2),
  }));

  const porComp = new Map<string, Caso[]>();
  for (const c of casos) porComp.set(c.competencia, [...(porComp.get(c.competencia) ?? []), c]);

  return [...porComp].map(([competencia, lista]) => {
    const total = lista.reduce((s, c) => s.plus(c.tributo), ZERO);
    const receita = lista.reduce((s, c) => s.plus(c.item.valorItem), ZERO);
    const notas = [...new Set(lista.map((c) => c.item.nota.numero))];
    const tipos = [
      ...new Set(lista.map((c) => (c.item.cfop!.startsWith("7") ? "exportação" : "venda de imobilizado"))),
    ];
    return {
      codigo: "C09",
      competencia,
      confianca: "MEDIA" as const,
      descricao:
        `${moeda(receita)} de ${tipos.join(" e ")} com PIS/COFINS tributado (CST 01/02) em ` +
        `${notas.length} NF-e: ${moeda(total)} destacados.`,
      textoCliente:
        `Em ${mesAno(competencia)} as notas ${notas.join(", ")} tributaram PIS/COFINS sobre ` +
        `${tipos.join(" e ")}, receita que não integra a base. Se foi recolhido, há ${moeda(total)} a recuperar.`,
      recomendacao:
        "Conferir na EFD-Contribuições se a receita entrou na base; se entrou, retificar e pedir " +
        "a restituição ou a compensação.",
      ressalva: "O destaque na nota não prova o recolhimento; confirmar na EFD-Contribuições.",
      valorExposicao: total,
      declarado: true,
      evidencias: lista.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: c.item.nota.documento.nomeArquivo,
        documentoNumero: c.item.nota.numero,
        chave: c.item.nota.chave ?? undefined,
        dataDocumento: dataBr(c.item.nota.dataEmissao),
        valor: moeda(c.tributo),
        observacao:
          `CFOP ${c.item.cfop} · CST PIS ${c.item.cstPis} · ${moeda(c.item.valorItem)} · ` +
          `PIS ${c.item.aliqPis ? pct(c.item.aliqPis) : "—"} · COFINS ${c.item.aliqCofins ? pct(c.item.aliqCofins) : "—"}`,
      })),
    };
  });
}

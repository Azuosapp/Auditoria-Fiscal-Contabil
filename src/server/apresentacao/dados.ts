import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { definicaoDe } from "@/server/auditoria/catalogo";
import { confrontoApuradoDeclarado, type ResumoConfronto } from "@/server/confronto/apurado-declarado";

/**
 * Dados da apresentação ao cliente.
 *
 * O mesmo erro repetido em várias competências vira um item só, com o total e
 * o número de ocorrências. Os itens são ordenados pelo que mais pesa para o
 * cliente: gravidade, imposto em jogo e valor, e o provado antes do que falta
 * confirmar.
 */

const ZERO = new Prisma.Decimal(0);

export type NivelApresentacao = "GRAVE" | "MEDIO" | "BAIXO" | "OPORTUNIDADE";

export interface ItemApresentacao {
  codigo: string;
  titulo: string;
  area: "FISCAL" | "CONTABIL";
  nivel: NivelApresentacao;
  severidade: string;
  frase: string;
  valor: Prisma.Decimal;
  ocorrencias: number;
  periodo: string;
  tributario: boolean;
  provado: boolean;
}

export interface DadosApresentacao {
  auditoria: { id: string; competenciaIni: string; competenciaFim: string; executadaEm: Date | null };
  empresa: { razaoSocial: string; cnpj: string; uf: string | null; municipio: string | null };
  regimes: { exercicio: number; regime: string }[];
  totais: {
    apontamentos: number;
    fiscal: number;
    contabil: number;
    debitos: Prisma.Decimal;
    creditos: Prisma.Decimal;
    creditosAConfirmar: boolean;
    aConfirmar: Prisma.Decimal;
  };
  grupos: Record<NivelApresentacao, ItemApresentacao[]>;
  confronto: ResumoConfronto;
}

const PESO_SEVERIDADE: Record<string, number> = { CRITICO: 4, ALTO: 3, MEDIO: 2, BAIXO: 1, OPORTUNIDADE: 0 };

function nivelDe(severidade: string): NivelApresentacao {
  if (severidade === "CRITICO" || severidade === "ALTO") return "GRAVE";
  if (severidade === "MEDIO") return "MEDIO";
  if (severidade === "BAIXO") return "BAIXO";
  return "OPORTUNIDADE";
}

function mesAno(c: string): string {
  const [a, m] = c.split("-");
  return `${m}/${a}`;
}

export async function dadosApresentacao(auditoriaId: string): Promise<DadosApresentacao | null> {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: auditoriaId },
    include: { empresa: { include: { regimes: { orderBy: { exercicio: "asc" } } } } },
  });
  if (!auditoria) return null;

  const [achados, confronto] = await Promise.all([
    prisma.achado.findMany({ where: { auditoriaId, NOT: { situacaoPrescricional: "DECAIDO" } } }),
    confrontoApuradoDeclarado(auditoriaId),
  ]);

  // Débitos: só o que está provado. Créditos: todo crédito identificado — quase
  // sempre depende de confirmar o recolhimento, e o cartão diz isso.
  let debitos = ZERO;
  let creditos = ZERO;
  let creditosAConfirmar = false;
  let aConfirmar = ZERO;
  for (const a of achados) {
    const v = a.valorExposicao ?? ZERO;
    if (a.severidade === "OPORTUNIDADE") {
      creditos = creditos.plus(v);
      if (a.confianca !== "ALTA" && v.greaterThan(0)) creditosAConfirmar = true;
    } else if (a.confianca !== "ALTA") aConfirmar = aConfirmar.plus(v);
    else debitos = debitos.plus(v);
  }

  // Um item por código e severidade.
  const porChave = new Map<string, typeof achados>();
  for (const a of achados) {
    const k = `${a.codigo}|${nivelDe(a.severidade)}`;
    porChave.set(k, [...(porChave.get(k) ?? []), a]);
  }

  const itens: ItemApresentacao[] = [];
  for (const lista of porChave.values()) {
    const def = definicaoDe(lista[0].codigo);
    const valor = lista.reduce((s, a) => s.plus(a.valorExposicao ?? ZERO), ZERO);
    const maior = lista.reduce((x, y) => ((y.valorExposicao ?? ZERO).greaterThan(x.valorExposicao ?? ZERO) ? y : x));
    const severidade = lista.reduce((x, y) => (PESO_SEVERIDADE[y.severidade] > PESO_SEVERIDADE[x.severidade] ? y : x)).severidade;
    const comps = lista.map((a) => a.competencia).filter((c): c is string => !!c).sort();
    const periodo =
      comps.length === 0 ? "" : comps[0] === comps[comps.length - 1] ? mesAno(comps[0]) : `${mesAno(comps[0])} a ${mesAno(comps[comps.length - 1])}`;
    itens.push({
      codigo: def.codigo,
      titulo: def.titulo,
      area: def.area,
      nivel: nivelDe(severidade),
      severidade,
      frase: maior.textoCliente ?? maior.descricao,
      valor,
      ocorrencias: lista.length,
      periodo,
      tributario: def.tributo !== null || valor.greaterThan(0),
      provado: lista.some((a) => a.confianca === "ALTA"),
    });
  }

  // Mais sério primeiro: gravidade, depois o que tem imposto em jogo (valor),
  // depois o tamanho do valor, e o provado antes do que falta confirmar.
  itens.sort(
    (x, y) =>
      PESO_SEVERIDADE[y.severidade] - PESO_SEVERIDADE[x.severidade] ||
      Number(y.valor.greaterThan(0)) - Number(x.valor.greaterThan(0)) ||
      Number(y.tributario) - Number(x.tributario) ||
      y.valor.comparedTo(x.valor) ||
      Number(y.provado) - Number(x.provado),
  );

  const grupos: DadosApresentacao["grupos"] = { GRAVE: [], MEDIO: [], BAIXO: [], OPORTUNIDADE: [] };
  for (const i of itens) {
    // Oportunidade sem valor é recomendação (ex.: planejamento), não crédito a recuperar.
    if (i.nivel === "OPORTUNIDADE" && !i.valor.greaterThan(0)) continue;
    grupos[i.nivel].push(i);
  }

  const erros = itens.filter((i) => i.nivel !== "OPORTUNIDADE");
  return {
    auditoria: {
      id: auditoria.id,
      competenciaIni: auditoria.competenciaIni,
      competenciaFim: auditoria.competenciaFim,
      executadaEm: auditoria.executadaEm,
    },
    empresa: {
      razaoSocial: auditoria.empresa.razaoSocial,
      cnpj: auditoria.empresa.cnpj,
      uf: auditoria.empresa.uf,
      municipio: auditoria.empresa.municipio,
    },
    regimes: auditoria.empresa.regimes.map((r) => ({ exercicio: r.exercicio, regime: r.regime })),
    totais: {
      apontamentos: erros.length,
      fiscal: erros.filter((i) => i.area === "FISCAL").length,
      contabil: erros.filter((i) => i.area === "CONTABIL").length,
      debitos,
      creditos,
      creditosAConfirmar,
      aConfirmar,
    },
    grupos,
    confronto,
  };
}

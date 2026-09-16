import type { AreaAchado } from "@prisma/client";
import { prisma } from "@/lib/prisma";

/**
 * Leitura da análise do Claude pelas abas da auditoria.
 *
 * Cada aba mostra os apontamentos da sua área, junto dos achados das regras:
 * quem abre a aba Fiscal quer ver os erros fiscais, venham de onde vierem. A
 * origem continua visível em cada cartão — é o que impede um apontamento a
 * confirmar de ser lido como cálculo testado.
 *
 * Vale sempre a última análise CONCLUÍDA. Enquanto uma nova roda, a anterior
 * continua na tela; uma rodada que falhou não apaga o que já havia.
 */

export async function analiseIaDaArea(auditoriaId: string, area: AreaAchado) {
  const [concluida, ultima] = await Promise.all([
    prisma.analiseIa.findFirst({
      where: { auditoriaId, status: "CONCLUIDA" },
      orderBy: { iniciadaEm: "desc" },
      include: {
        apontamentos: { where: { area }, orderBy: { ordem: "asc" } },
      },
    }),
    prisma.analiseIa.findFirst({
      where: { auditoriaId },
      orderBy: { iniciadaEm: "desc" },
      select: { status: true },
    }),
  ]);

  return {
    apontamentos: concluida?.apontamentos ?? [],
    concluidaEm: concluida?.concluidaEm ?? null,
    emAndamento: ultima?.status === "EM_ANDAMENTO",
  };
}

/** Números das abas: achados das regras + apontamentos do Claude, por área. */
export async function contagensDasAbas(
  auditoriaId: string,
): Promise<Record<string, number>> {
  const [regras, concluida] = await Promise.all([
    prisma.achado.groupBy({
      by: ["area"],
      where: { auditoriaId },
      _count: { _all: true },
    }),
    prisma.analiseIa.findFirst({
      where: { auditoriaId, status: "CONCLUIDA" },
      orderBy: { iniciadaEm: "desc" },
      select: { id: true },
    }),
  ]);

  const ia = concluida
    ? await prisma.apontamentoIa.groupBy({
        by: ["area"],
        where: { analiseId: concluida.id },
        _count: { _all: true },
      })
    : [];

  const chave = (area: AreaAchado) => (area === "FISCAL" ? "/fiscal" : "/contabil");
  const contagens: Record<string, number> = {};
  for (const r of [...regras, ...ia]) {
    contagens[chave(r.area)] = (contagens[chave(r.area)] ?? 0) + r._count._all;
  }
  return contagens;
}

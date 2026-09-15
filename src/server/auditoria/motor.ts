import { Prisma, type NivelAuditoria, type TipoDocumento } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CATALOGO, cobertura, definicaoDe } from "./catalogo";
import { avaliarPrescricao, exercicioDe } from "./prescricao";
import { competenciasDoPeriodo, type AchadoProduzido, type ContextoRegra, type Regra } from "./tipos";
import { familiaB } from "./regras/familia-b-receita";
import { familiaC } from "./regras/familia-c-credito";
import { familiaD } from "./regras/familia-d-regime";
import { familiaE } from "./regras/familia-e-icms";
import { mesAno } from "./texto";

/**
 * Motor da auditoria: roda tudo que os documentos presentes sustentam.
 *
 * A premissa é a do trabalho real — o cliente entrega o que tem, não o que a
 * norma manda. O motor aproveita cada regra que os arquivos permitem e DECLARA
 * o que ficou de fora. Auditoria que esconde a própria lacuna não serve como
 * peça técnica, e apontar como certeza o que os documentos não sustentam queima
 * a reunião com o cliente.
 */

const REGRAS: Regra[] = [familiaB, familiaC, familiaD, familiaE];

export interface ResultadoAuditoria {
  achados: number;
  porSeveridade: Record<string, number>;
  totalDebitoAberto: string;
  totalRiscoAutuacao: string;
  totalRecuperavel: string;
  nivelAlcancado: NivelAuditoria;
  lacunas: number;
  regrasAvaliadas: number;
  regrasBloqueadas: number;
  competenciasSemEscrituracao: string[];
}

export async function auditar(auditoriaId: string): Promise<ResultadoAuditoria> {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: auditoriaId },
    include: { empresa: { include: { regimes: true } } },
  });
  if (!auditoria) throw new Error("Auditoria não encontrada.");

  const fontesDisponiveis = await fontesComDadoExtraido(auditoriaId);

  const ctx: ContextoRegra = {
    auditoriaId,
    empresaCnpj: auditoria.empresa.cnpj,
    empresaUf: auditoria.empresa.uf ?? undefined,
    competenciaIni: auditoria.competenciaIni,
    competenciaFim: auditoria.competenciaFim,
    regimePorExercicio: new Map(
      auditoria.empresa.regimes.map((r) => [r.exercicio, r.regime]),
    ),
    fontesDisponiveis,
  };

  // Rodada anterior é descartada inteira: achado que deixou de existir porque o
  // cliente trouxe o documento que faltava não pode continuar no relatório.
  await prisma.$transaction([
    prisma.achado.deleteMany({ where: { auditoriaId } }),
    prisma.lacuna.deleteMany({ where: { auditoriaId } }),
  ]);

  const produzidos: AchadoProduzido[] = [];
  for (const regra of REGRAS) {
    produzidos.push(...(await regra.executar(ctx)));
  }

  await gravarAchados(auditoriaId, produzidos);

  const { avaliaveis, bloqueados } = cobertura(fontesDisponiveis);
  const competenciasSemEscrituracao = await gravarLacunas(
    auditoriaId,
    bloqueados,
    ctx,
  );

  const totais = await calcularTotais(auditoriaId);
  const nivelAlcancado = nivelDe(fontesDisponiveis);

  await prisma.auditoria.update({
    where: { id: auditoriaId },
    data: {
      status: "PRONTA",
      executadaEm: new Date(),
      nivelAlcancado,
      totalDebitoAberto: totais.debitoAberto,
      totalRiscoAutuacao: totais.riscoAutuacao,
      totalRecuperavel: totais.recuperavel,
    },
  });

  const porSeveridade = await prisma.achado.groupBy({
    by: ["severidade"],
    where: { auditoriaId },
    _count: { _all: true },
  });

  return {
    achados: produzidos.length,
    porSeveridade: Object.fromEntries(
      porSeveridade.map((s) => [s.severidade, s._count._all]),
    ),
    totalDebitoAberto: totais.debitoAberto.toFixed(2),
    totalRiscoAutuacao: totais.riscoAutuacao.toFixed(2),
    totalRecuperavel: totais.recuperavel.toFixed(2),
    nivelAlcancado,
    lacunas: bloqueados.length + competenciasSemEscrituracao.length,
    regrasAvaliadas: avaliaveis.length,
    regrasBloqueadas: bloqueados.length,
    competenciasSemEscrituracao,
  };
}

/**
 * Fontes disponíveis são as que têm dado EXTRAÍDO, não as que foram importadas.
 *
 * Um SPED importado mas que falhou no parser não sustenta achado algum; tratá-lo
 * como disponível faria a regra rodar sobre o vazio e concluir que não há nada
 * de errado — a pior forma de falso negativo.
 */
async function fontesComDadoExtraido(
  auditoriaId: string,
): Promise<Set<TipoDocumento>> {
  const docs = await prisma.documento.findMany({
    where: { auditoriaId, status: "CONCLUIDO" },
    select: { tipo: true, registrosExtraidos: true },
  });

  const fontes = new Set<TipoDocumento>();
  for (const d of docs) {
    if (d.registrosExtraidos > 0) fontes.add(d.tipo);
  }

  // Pacote .zip entra como DESCONHECIDO, mas o que ele produziu foi gravado sob
  // o próprio documento. Se houve extração, as fontes reais vêm do que existe
  // no banco — daí a conferência abaixo.
  const [temNota, temApuracaoIcms, temContrib, temSimples, temEvento] =
    await Promise.all([
      prisma.notaFiscal.count({
        where: { documento: { auditoriaId }, origem: "XML_AUTORIZADO" },
      }),
      prisma.apuracaoFiscal.count({ where: { documento: { auditoriaId } } }),
      prisma.apuracaoContribuicoes.count({ where: { documento: { auditoriaId } } }),
      prisma.apuracaoSimples.count({ where: { documento: { auditoriaId } } }),
      prisma.eventoNfe.count({ where: { documento: { auditoriaId } } }),
    ]);

  if (temNota > 0) fontes.add("NFE_XML");
  if (temApuracaoIcms > 0) fontes.add("SPED_FISCAL");
  if (temContrib > 0) fontes.add("SPED_CONTRIBUICOES");
  if (temSimples > 0) fontes.add("PGDAS");
  if (temEvento > 0) fontes.add("EVENTO_NFE");

  const escrituradas = await prisma.notaFiscal.count({
    where: { documento: { auditoriaId }, origem: "ESCRITURACAO" },
  });
  if (escrituradas > 0) fontes.add("SPED_FISCAL");

  return fontes;
}

async function gravarAchados(
  auditoriaId: string,
  produzidos: AchadoProduzido[],
): Promise<void> {
  for (const p of produzidos) {
    const definicao = definicaoDe(p.codigo);
    const competencia = p.competencia;

    const prescricao = competencia
      ? avaliarPrescricao(competencia, p.declarado)
      : undefined;

    await prisma.achado.create({
      data: {
        auditoriaId,
        codigo: p.codigo,
        titulo: definicao.titulo,
        familia: definicao.familia,
        severidade: p.severidade ?? definicao.severidade,
        confianca: p.confianca ?? "ALTA",
        tributo: definicao.tributo,
        competencia,
        exercicio: competencia ? exercicioDe(competencia) : undefined,
        descricao: p.descricao,
        textoCliente: p.textoCliente,
        recomendacao: p.recomendacao,
        valorExposicao: p.valorExposicao,
        baseLegal: definicao.baseLegal,
        situacaoPrescricional: prescricao?.situacao ?? "EXIGIVEL",
        decaiEm: prescricao?.decaiEm,
        regraDecadencia: prescricao?.regra,
        ressalva: p.ressalva,
        evidencias: {
          create: p.evidencias.map((e) => ({
            documentoId: e.documentoId,
            arquivo: e.arquivo,
            registro: e.registro,
            linha: e.linha,
            campo: e.campo,
            valor: e.valor,
            observacao: e.observacao,
          })),
        },
      },
    });
  }
}

/**
 * Declara o que NÃO foi analisado e por quê.
 *
 * Duas espécies de lacuna:
 *  - achado do catálogo cujo documento exigido não veio;
 *  - competência do período auditado sem escrituração importada, que impede
 *    qualquer conclusão sobre aquele mês.
 */
async function gravarLacunas(
  auditoriaId: string,
  bloqueados: { definicao: (typeof CATALOGO)[number]; faltando: TipoDocumento[] }[],
  ctx: ContextoRegra,
): Promise<string[]> {
  for (const b of bloqueados) {
    await prisma.lacuna.create({
      data: {
        auditoriaId,
        escopo: `${b.definicao.codigo} — ${b.definicao.titulo}`,
        documentoFaltante: b.faltando[0],
        descricao:
          `Não avaliado por falta de: ${b.faltando.join(", ")}. ` +
          b.definicao.descricao,
      },
    });
  }

  // Meses do período sem escrituração fiscal importada.
  const competencias = competenciasDoPeriodo(
    ctx.competenciaIni,
    ctx.competenciaFim,
  );

  const comApuracao = await prisma.apuracaoFiscal.findMany({
    where: { documento: { auditoriaId } },
    select: { competencia: true },
  });
  const presentes = new Set(comApuracao.map((a) => a.competencia));

  const ausentes = competencias.filter((c) => !presentes.has(c));

  // Só vale declarar mês a mês quando ao menos alguma escrituração veio. Sem
  // nenhuma, a lacuna já está dita pelos achados bloqueados — repetir 60 linhas
  // dizendo "faltou SPED" seria ruído.
  if (presentes.size > 0 && ausentes.length > 0) {
    for (const c of ausentes) {
      await prisma.lacuna.create({
        data: {
          auditoriaId,
          escopo: `Competência ${mesAno(c)} sem escrituração fiscal`,
          documentoFaltante: "SPED_FISCAL",
          competencia: c,
          descricao:
            `Não há SPED Fiscal importado para ${mesAno(c)}. Nenhuma conclusão ` +
            `sobre apuração de ICMS ou escrituração de notas foi tirada desta ` +
            `competência.`,
        },
      });
    }
  }

  return presentes.size > 0 ? ausentes : [];
}

/**
 * Totais da página 1 do relatório — os três números que ganham a reunião.
 *
 * A separação importa: débito em aberto é o que a empresa já declarou e não
 * pagou (dívida líquida e certa); risco de autuação é o que a fiscalização pode
 * constituir; recuperável é dinheiro a favor do cliente. Somar os três num
 * número só seria desonesto, porque têm naturezas opostas.
 *
 * Achado decaído fica fora de todos: não é exigível nem recuperável.
 */
async function calcularTotais(auditoriaId: string) {
  const achados = await prisma.achado.findMany({
    where: { auditoriaId, situacaoPrescricional: { not: "DECAIDO" } },
    select: {
      severidade: true,
      valorExposicao: true,
      codigo: true,
    },
  });

  let debitoAberto = new Prisma.Decimal(0);
  let riscoAutuacao = new Prisma.Decimal(0);
  let recuperavel = new Prisma.Decimal(0);

  for (const a of achados) {
    const valor = a.valorExposicao;
    if (!valor) continue;

    if (a.severidade === "OPORTUNIDADE") {
      recuperavel = recuperavel.plus(valor);
      continue;
    }

    // Família A é o débito já confessado e não pago. Tudo o mais que tem valor
    // é exposição a autuação, não dívida líquida.
    if (a.codigo.startsWith("A")) {
      debitoAberto = debitoAberto.plus(valor);
    } else {
      riscoAutuacao = riscoAutuacao.plus(valor);
    }
  }

  return { debitoAberto, riscoAutuacao, recuperavel };
}

/** Nível efetivamente alcançado, conforme o que foi entregue. */
function nivelDe(fontes: Set<TipoDocumento>): NivelAuditoria {
  const temContabil = fontes.has("ECD") || fontes.has("ECF");
  const temFiscal =
    fontes.has("SPED_FISCAL") ||
    fontes.has("SPED_CONTRIBUICOES") ||
    fontes.has("NFE_XML");

  if (temContabil && temFiscal) return "COMPLETA";
  if (temFiscal) return "FISCAL";
  return "DIAGNOSTICO_RAPIDO";
}

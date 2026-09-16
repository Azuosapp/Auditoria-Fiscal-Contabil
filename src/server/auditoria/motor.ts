import {
  Prisma,
  type NivelAuditoria,
  type RegimeTributario,
  type TipoDocumento,
} from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { CATALOGO, aplicavelAoRegime, cobertura, definicaoDe } from "./catalogo";
import { avaliarPrescricao, exercicioDe } from "./prescricao";
import { competenciasDoPeriodo, type AchadoProduzido, type ContextoRegra, type Regra } from "./tipos";
import { familiaB } from "./regras/familia-b-receita";
import { familiaC } from "./regras/familia-c-credito";
import { familiaD } from "./regras/familia-d-regime";
import { familiaE } from "./regras/familia-e-icms";
import { familiaF } from "./regras/familia-f-contabil";
import { familiaEDocumento } from "./regras/familia-e-documento";
import { familiaG } from "./regras/familia-g-obrigacoes";
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

const REGRAS: Regra[] = [familiaB, familiaC, familiaD, familiaE, familiaEDocumento, familiaF, familiaG];

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
  /** Regras descartadas por não valerem no regime da empresa. */
  regrasForaDoRegime: number;
  competenciasSemEscrituracao: string[];
  porArea: Record<string, number>;
}

export async function auditar(auditoriaId: string): Promise<ResultadoAuditoria> {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: auditoriaId },
    include: { empresa: { include: { regimes: true } } },
  });
  if (!auditoria) throw new Error("Auditoria não encontrada.");

  const fontesDisponiveis = await fontesComDadoExtraido(auditoriaId);

  // Os regimes em que a empresa esteve no período. Governam o que faz sentido
  // procurar: uma indústria do Lucro Real não tem sublimite do Simples.
  const regimes = new Set<RegimeTributario>(
    auditoria.empresa.regimes.map((r) => r.regime),
  );

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

  await gravarAchados(auditoriaId, produzidos, regimes);

  const cob = cobertura(fontesDisponiveis, regimes);
  const { bloqueados, foraDoRegime } = cob;

  // Ter os documentos não basta: sem regra programada, ninguém conferiu. Esses
  // itens são declarados como não verificados, senão o relatório diria "sem
  // apontamento" sobre algo que nunca foi olhado.
  const implementados = new Set(REGRAS.flatMap((r) => r.codigos));
  const avaliaveis = cob.avaliaveis.filter((d) => implementados.has(d.codigo));
  const naoAutomatizados = cob.avaliaveis.filter((d) => !implementados.has(d.codigo));

  const competenciasSemEscrituracao = await gravarLacunas(
    auditoriaId,
    bloqueados,
    ctx,
  );
  for (const d of naoAutomatizados) {
    await prisma.lacuna.create({
      data: {
        auditoriaId,
        escopo: `${d.codigo} — ${d.titulo}`,
        area: d.area,
        documentoFaltante: null,
        descricao:
          "Verificação ainda não automatizada no sistema. Os documentos necessários " +
          "foram entregues: a conferência depende de revisão manual ou da análise do " +
          "Claude. " +
          d.descricao,
      },
    });
  }

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

  const porArea = await prisma.achado.groupBy({
    by: ["area"],
    where: { auditoriaId },
    _count: { _all: true },
  });

  return {
    achados: produzidos.length,
    porSeveridade: Object.fromEntries(
      porSeveridade.map((s) => [s.severidade, s._count._all]),
    ),
    porArea: Object.fromEntries(porArea.map((a) => [a.area, a._count._all])),
    regrasForaDoRegime: foraDoRegime.length,
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
  const [temNota, temApuracaoIcms, temContrib, temSimples, temEvento, temConfissao, temEcf, temEcd] =
    await Promise.all([
      prisma.notaFiscal.count({
        where: { documento: { auditoriaId }, origem: "XML_AUTORIZADO" },
      }),
      prisma.apuracaoFiscal.count({ where: { documento: { auditoriaId } } }),
      prisma.apuracaoContribuicoes.count({ where: { documento: { auditoriaId } } }),
      prisma.apuracaoSimples.count({ where: { documento: { auditoriaId } } }),
      prisma.eventoNfe.count({ where: { documento: { auditoriaId } } }),
      prisma.confissao.count({ where: { documento: { auditoriaId } } }),
      prisma.apuracaoEcf.count({ where: { documento: { auditoriaId } } }),
      prisma.saldoConta.count({ where: { documento: { auditoriaId } } }),
    ]);

  if (temNota > 0) fontes.add("NFE_XML");
  if (temApuracaoIcms > 0) fontes.add("SPED_FISCAL");
  if (temContrib > 0) fontes.add("SPED_CONTRIBUICOES");
  if (temSimples > 0) fontes.add("PGDAS");
  if (temEvento > 0) fontes.add("EVENTO_NFE");
  if (temConfissao > 0) fontes.add("DCTF");
  if (temEcf > 0) fontes.add("ECF");
  if (temEcd > 0) fontes.add("ECD");

  const escrituradas = await prisma.notaFiscal.count({
    where: { documento: { auditoriaId }, origem: "ESCRITURACAO" },
  });
  if (escrituradas > 0) fontes.add("SPED_FISCAL");

  return fontes;
}

async function gravarAchados(
  auditoriaId: string,
  produzidos: AchadoProduzido[],
  regimes: Set<RegimeTributario>,
): Promise<void> {
  for (const p of produzidos) {
    const definicao = definicaoDe(p.codigo);

    // Regra que não vale no regime da empresa não vira achado, mesmo que o dado
    // exista. É a última trava: a regra já devia ter se abstido, mas o achado
    // errado numa apresentação custa mais que a verificação redundante.
    if (!aplicavelAoRegime(definicao, regimes)) continue;

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
        area: definicao.area,
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
            tipo: e.tipo ?? "CONTEXTO",
            documentoId: e.documentoId,
            arquivo: e.arquivo,
            registro: e.registro,
            linha: e.linha,
            campo: e.campo,
            valor: e.valor,
            observacao: e.observacao,
            documentoNumero: e.documentoNumero,
            chave: e.chave,
            dataDocumento: e.dataDocumento,
            participante: e.participante,
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
        area: b.definicao.area,
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
          area: "FISCAL",
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

  await declararXmlsFaltantes(auditoriaId);

  return presentes.size > 0 ? ausentes : [];
}

/**
 * Competências em que o SPED escriturou nota cujo XML não veio na coleta.
 *
 * Isto NÃO é achado: na prática significa apenas que o cliente não baixou todos
 * os XMLs, e apontar como erro mandaria o auditor procurar documento que existe
 * e está guardado em outro lugar. Mas também não pode sumir: sem o XML, a
 * comparação entre emitido e escriturado fica incompleta naquela competência, e
 * quem lê o relatório precisa saber disso antes de concluir que está tudo certo.
 *
 * Por isso vira lacuna — que é a seção onde o relatório diz o que não pôde ser
 * verificado e por quê.
 */
async function declararXmlsFaltantes(auditoriaId: string): Promise<void> {
  const [escrituradas, xmls] = await Promise.all([
    prisma.notaFiscal.findMany({
      where: {
        documento: { auditoriaId },
        origem: "ESCRITURACAO",
        situacao: "AUTORIZADA",
        chave: { not: null },
      },
      select: { chave: true, competencia: true },
    }),
    prisma.notaFiscal.findMany({
      where: {
        documento: { auditoriaId },
        origem: "XML_AUTORIZADO",
        chave: { not: null },
      },
      select: { chave: true },
    }),
  ]);

  if (escrituradas.length === 0) return;

  const comXml = new Set(xmls.map((x) => x.chave!));
  const faltandoPorCompetencia = new Map<string, number>();

  for (const n of escrituradas) {
    if (comXml.has(n.chave!)) continue;
    faltandoPorCompetencia.set(
      n.competencia,
      (faltandoPorCompetencia.get(n.competencia) ?? 0) + 1,
    );
  }

  for (const [competencia, quantidade] of faltandoPorCompetencia) {
    await prisma.lacuna.create({
      data: {
        auditoriaId,
        escopo: `Competência ${mesAno(competencia)} — ${quantidade} nota(s) sem XML`,
        area: "FISCAL",
        documentoFaltante: "NFE_XML",
        competencia,
        descricao:
          `${quantidade} nota(s) escriturada(s) no SPED Fiscal de ${mesAno(competencia)} ` +
          `não têm o documento eletrônico entre os arquivos analisados. A ` +
          `comparação entre o emitido e o escriturado fica incompleta nesta ` +
          `competência — obter os XMLs na distribuição DF-e da SEFAZ e ` +
          `reimportar amplia o alcance da auditoria.`,
      },
    });
  }
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
      confianca: true,
      valorExposicao: true,
      codigo: true,
    },
  });

  let debitoAberto = new Prisma.Decimal(0);
  let riscoAutuacao = new Prisma.Decimal(0);
  let recuperavel = new Prisma.Decimal(0);
  let aConfirmar = new Prisma.Decimal(0);

  for (const a of achados) {
    const valor = a.valorExposicao;
    if (!valor) continue;

    /**
     * Achado de confiança não-ALTA fica FORA dos três números da capa.
     *
     * É o caso do B05, por exemplo: a base de PIS/COFINS legitimamente exclui
     * receita monofásica, de alíquota zero e de exportação, e a divergência
     * pode ser inteiramente explicada por isso. Levar meio milhão desses à
     * primeira página como "risco de autuação" seria prometer um risco que
     * talvez não exista — e a reunião acaba no momento em que o contador do
     * cliente explicar a exclusão.
     *
     * Eles aparecem em número próprio, "a confirmar", que é o que são.
     */
    if (a.confianca !== "ALTA") {
      aConfirmar = aConfirmar.plus(valor);
      continue;
    }

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

  return { debitoAberto, riscoAutuacao, recuperavel, aConfirmar };
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

import { rm, writeFile } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { executarClaude } from "./cli";
import { ESQUEMA_RESPOSTA, RespostaAnalise } from "./esquema";
import { montarPacote } from "./pacote";
import { montarSystemPrompt, pastaAgentes, PROMPT_INICIAL } from "./prompt";

/**
 * Orquestra a análise do Claude sobre uma auditoria.
 *
 * Roda em segundo plano, uma de cada vez. Uma por vez porque todas consomem o
 * mesmo limite da conta do usuário — e é o mesmo limite das pesquisas que ele
 * faz no Claude.ai. Duas importações seguidas na mesma auditoria não disparam
 * duas análises: a segunda fica marcada e roda uma única vez ao fim da
 * primeira, já com todos os arquivos.
 */

function config() {
  return {
    automatica: process.env.CLAUDE_ANALISE_AUTOMATICA !== "0",
    tetoUsd: Number(process.env.CLAUDE_ANALISE_TETO_USD ?? "10"),
    modelo: process.env.CLAUDE_ANALISE_MODELO ?? "opus",
    esforco: process.env.CLAUDE_ANALISE_ESFORCO ?? "high",
    timeoutMin: Number(process.env.CLAUDE_ANALISE_TIMEOUT_MIN ?? "45"),
  };
}

/** Sobrevive ao recarregamento de módulos do Next em desenvolvimento. */
const estado = globalThis as unknown as {
  __filaAnaliseIa?: Promise<void>;
  __emAndamentoIa?: Set<string>;
  __repetirIa?: Set<string>;
};
estado.__filaAnaliseIa ??= Promise.resolve();
estado.__emAndamentoIa ??= new Set();
estado.__repetirIa ??= new Set();

export function analiseAutomaticaLigada(): boolean {
  return config().automatica;
}

/**
 * Pede uma análise. Retorna na hora: o trabalho segue em segundo plano.
 *
 * `"agendada"` — entrou na fila; `"repetira"` — já há uma rodando para esta
 * auditoria, e ela será refeita ao terminar.
 */
export async function solicitarAnaliseIa(
  auditoriaId: string,
): Promise<"agendada" | "repetira"> {
  await encerrarOrfas();

  if (estado.__emAndamentoIa!.has(auditoriaId)) {
    estado.__repetirIa!.add(auditoriaId);
    return "repetira";
  }
  estado.__emAndamentoIa!.add(auditoriaId);

  estado.__filaAnaliseIa = estado.__filaAnaliseIa!.then(async () => {
    try {
      do {
        estado.__repetirIa!.delete(auditoriaId);
        await rodarAnalise(auditoriaId);
      } while (estado.__repetirIa!.has(auditoriaId));
    } finally {
      estado.__emAndamentoIa!.delete(auditoriaId);
    }
  });

  return "agendada";
}

/**
 * Análise que ficou EM_ANDAMENTO porque o servidor caiu no meio. Sem isto a
 * tela mostraria "analisando" para sempre.
 */
async function encerrarOrfas() {
  const limite = new Date(Date.now() - (config().timeoutMin + 15) * 60_000);
  await prisma.analiseIa.updateMany({
    where: { status: "EM_ANDAMENTO", iniciadaEm: { lt: limite } },
    data: {
      status: "ERRO",
      erro: "A análise foi interrompida (o programa foi fechado ou reiniciado durante a execução).",
      concluidaEm: new Date(),
    },
  });
}

async function rodarAnalise(auditoriaId: string) {
  const cfg = config();
  const inicio = Date.now();

  const analise = await prisma.analiseIa.create({
    data: { auditoriaId, status: "EM_ANDAMENTO", modelo: cfg.modelo },
  });

  let pasta: string | undefined;
  try {
    const pacote = await montarPacote(auditoriaId, analise.id);
    pasta = pacote.pasta;

    const { texto: systemPrompt } = await montarSystemPrompt();
    const agentes = pastaAgentes();

    // Ao lado da pasta de trabalho, não dentro: as instruções não são dado do
    // cliente e não devem aparecer entre os arquivos que o Claude investiga.
    const arquivoInstrucoes = `${pacote.pasta}.instrucoes.md`;
    await writeFile(arquivoInstrucoes, systemPrompt, "utf8");

    const r = await executarClaude({
      prompt: PROMPT_INICIAL,
      systemPromptArquivo: arquivoInstrucoes,
      cwd: pacote.pasta,
      pastasExtras: agentes ? [agentes] : [],
      jsonSchema: ESQUEMA_RESPOSTA,
      modelo: cfg.modelo,
      esforco: cfg.esforco,
      tetoUsd: cfg.tetoUsd,
      timeoutMs: cfg.timeoutMin * 60_000,
    });

    const base = {
      concluidaEm: new Date(),
      duracaoSeg: Math.round((Date.now() - inicio) / 1000),
      custoUsd: r.custoUsd !== undefined ? new Prisma.Decimal(r.custoUsd.toFixed(4)) : undefined,
      modelo: r.modelos.filter((m) => !m.includes("haiku")).join(", ") || cfg.modelo,
    };

    if (r.subtype !== "success" || r.isError) {
      const teto = /budget/i.test(r.subtype);
      await prisma.analiseIa.update({
        where: { id: analise.id },
        data: {
          ...base,
          status: teto ? "LIMITE_ATINGIDO" : "ERRO",
          erro: teto
            ? `O teto de US$ ${cfg.tetoUsd.toFixed(2)} por análise foi atingido antes do fim. ` +
              `Aumente CLAUDE_ANALISE_TETO_USD para auditorias com muitos arquivos.`
            : `O Claude Code encerrou com "${r.subtype}". ${r.resultado?.slice(0, 800) ?? r.stderr.slice(0, 800)}`,
        },
      });
      return;
    }

    const validada = RespostaAnalise.safeParse(r.saidaEstruturada);
    if (!validada.success) {
      await prisma.analiseIa.update({
        where: { id: analise.id },
        data: {
          ...base,
          status: "ERRO",
          erro:
            "A resposta não veio no formato combinado: " +
            validada.error.issues
              .slice(0, 5)
              .map((i) => `${i.path.join(".")}: ${i.message}`)
              .join("; "),
        },
      });
      return;
    }

    const resposta = validada.data;
    await prisma.$transaction([
      prisma.apontamentoIa.createMany({
        data: resposta.apontamentos.map((a, ordem) => ({
          analiseId: analise.id,
          ordem,
          titulo: a.titulo,
          severidade: a.severidade,
          area: a.area,
          confianca: a.confianca,
          tributo: a.tributo || null,
          competencias: [...new Set(a.competencias)].sort(),
          valorEstimado: a.valorEstimado ? new Prisma.Decimal(a.valorEstimado) : null,
          descricao: a.descricao,
          recomendacao: a.recomendacao || null,
          baseLegal: a.baseLegal,
          evidencias: a.evidencias as unknown as Prisma.InputJsonValue,
        })),
      }),
      prisma.analiseIa.update({
        where: { id: analise.id },
        data: {
          ...base,
          status: "CONCLUIDA",
          resumo: resposta.resumo,
          documentosFaltantes: resposta.documentosFaltantes,
        },
      }),
    ]);
  } catch (e) {
    await prisma.analiseIa.update({
      where: { id: analise.id },
      data: {
        status: "ERRO",
        erro: (e as Error).message.slice(0, 2000),
        concluidaEm: new Date(),
        duracaoSeg: Math.round((Date.now() - inicio) / 1000),
      },
    });
  } finally {
    // O pacote é cópia dos arquivos do cliente: não fica no disco depois de
    // usado. Os originais continuam no armazenamento da auditoria.
    if (pasta) {
      await rm(pasta, { recursive: true, force: true }).catch(() => {});
      await rm(`${pasta}.instrucoes.md`, { force: true }).catch(() => {});
    }
  }
}

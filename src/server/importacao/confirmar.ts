import { join } from "node:path";
import type { RegimeTributario } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AnaliseLote } from "./analisar";
import { normalizarCnpj } from "@/server/extraction/identificar-empresa";

/**
 * Efetivação do lote: cria (ou reaproveita) a empresa, abre a auditoria e
 * registra os documentos para processamento.
 *
 * O usuário confirma UMA vez, com os dados já preenchidos pelo próprio arquivo.
 * Tudo aqui roda numa transação: um lote pela metade — empresa criada sem
 * auditoria, documentos órfãos — seria pior que nenhum.
 */

export interface DadosConfirmacao {
  cnpj: string;
  razaoSocial: string;
  uf?: string;
  inscricaoEstadual?: string;
  municipio?: string;
  competenciaIni: string;
  competenciaFim: string;
  titulo?: string;
  regimes?: { exercicio: number; regime: RegimeTributario; origem?: string }[];
}

export interface ResultadoConfirmacao {
  auditoriaId: string;
  empresaId: string;
  empresaCriada: boolean;
  documentosRegistrados: number;
  documentosDuplicados: number;
}

const NOME_ORGANIZACAO_PADRAO = "Analyze Auditoria e Consultoria Tributária";

/**
 * A organização é o contêiner multiempresa do sistema. Enquanto não há tela de
 * cadastro dela, a primeira importação cria a padrão — em vez de falhar por
 * uma chave estrangeira que o usuário não tem como preencher.
 */
async function organizacaoPadrao(): Promise<string> {
  const existente = await prisma.organizacao.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (existente) return existente.id;

  const criada = await prisma.organizacao.create({
    data: { nome: NOME_ORGANIZACAO_PADRAO },
  });
  return criada.id;
}

export async function confirmarLote(
  loteId: string,
  dados: DadosConfirmacao,
): Promise<ResultadoConfirmacao> {
  const lote = await prisma.loteImportacao.findUnique({ where: { id: loteId } });
  if (!lote) throw new Error("Lote de importação não encontrado.");
  if (lote.status === "CONFIRMADO") {
    throw new Error("Este lote já foi confirmado.");
  }

  const cnpj = normalizarCnpj(dados.cnpj);
  if (!cnpj) throw new Error("CNPJ inválido.");

  const analise = lote.analise as unknown as AnaliseLote | null;
  if (!analise) throw new Error("Lote sem análise gravada.");

  const organizacaoId = await organizacaoPadrao();

  const anterior = await prisma.empresa.findUnique({
    where: { organizacaoId_cnpj: { organizacaoId, cnpj } },
  });
  const empresaCriada = !anterior;

  const resultado = await prisma.$transaction(async (tx) => {
    const empresa = await tx.empresa.upsert({
      where: { organizacaoId_cnpj: { organizacaoId, cnpj } },
      create: {
        organizacaoId,
        cnpj,
        razaoSocial: dados.razaoSocial,
        uf: dados.uf,
        municipio: dados.municipio,
        inscricaoEstadual: dados.inscricaoEstadual,
      },
      // Empresa reimportada: completar o que faltava sem apagar o que já havia
      // sido preenchido à mão. `undefined` é ignorado pelo Prisma.
      update: {
        razaoSocial: dados.razaoSocial,
        uf: dados.uf ?? undefined,
        municipio: dados.municipio ?? undefined,
        inscricaoEstadual: dados.inscricaoEstadual ?? undefined,
      },
    });

    for (const r of dados.regimes ?? []) {
      await tx.regimePorExercicio.upsert({
        where: {
          empresaId_exercicio: { empresaId: empresa.id, exercicio: r.exercicio },
        },
        create: {
          empresaId: empresa.id,
          exercicio: r.exercicio,
          regime: r.regime,
          origem: r.origem ?? "detectado na importação",
        },
        // Regime já informado antes não é sobrescrito por dedução: quem
        // confirmou à mão sabe mais que o detector.
        update: {},
      });
    }

    const auditoria = await tx.auditoria.create({
      data: {
        empresaId: empresa.id,
        titulo:
          dados.titulo ??
          `Auditoria ${dados.competenciaIni.slice(0, 4)}–${dados.competenciaFim.slice(0, 4)}`,
        competenciaIni: dados.competenciaIni,
        competenciaFim: dados.competenciaFim,
        status: "IMPORTANDO",
      },
    });

    // O hash impede que o mesmo arquivo entre duas vezes — o que acontece o
    // tempo todo quando o cliente manda o pacote de novo "por garantia".
    const vistos = new Set<string>();
    let registrados = 0;
    let duplicados = 0;

    for (const arquivo of analise.arquivos) {
      if (vistos.has(arquivo.hash)) {
        duplicados += 1;
        continue;
      }
      vistos.add(arquivo.hash);

      await tx.documento.create({
        data: {
          auditoriaId: auditoria.id,
          nomeArquivo: arquivo.nome,
          tipo: arquivo.tipo,
          tamanhoBytes: arquivo.tamanhoBytes,
          hash: arquivo.hash,
          caminho: join(lote.caminho, arquivo.nome),
          status: "PENDENTE",
          metadados: {
            motivoClassificacao: arquivo.motivo,
            classificacaoSegura: arquivo.seguro,
            arquivosContidos: arquivo.contidos ?? null,
          },
        },
      });
      registrados += 1;
    }

    await tx.loteImportacao.update({
      where: { id: loteId },
      data: {
        status: "CONFIRMADO",
        auditoriaId: auditoria.id,
        confirmadoEm: new Date(),
      },
    });

    return {
      auditoriaId: auditoria.id,
      empresaId: empresa.id,
      documentosRegistrados: registrados,
      documentosDuplicados: duplicados,
    };
  });

  return { ...resultado, empresaCriada };
}

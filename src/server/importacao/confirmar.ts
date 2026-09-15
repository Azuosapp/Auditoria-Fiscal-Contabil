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
  /**
   * Id da auditoria que deve receber estes arquivos. Quando ausente, o sistema
   * reaproveita a auditoria aberta da empresa (o normal) e só cria uma nova se
   * não houver nenhuma.
   */
  auditoriaId?: string;
  /** Força auditoria nova mesmo havendo uma aberta — trabalho separado, a pedido. */
  criarNova?: boolean;
}

export interface ResultadoConfirmacao {
  auditoriaId: string;
  empresaId: string;
  empresaCriada: boolean;
  /** `false` quando os arquivos entraram numa auditoria que já existia. */
  auditoriaCriada: boolean;
  documentosRegistrados: number;
  /** Arquivos já presentes na auditoria, reconhecidos pelo hash e ignorados. */
  documentosDuplicados: number;
  /** Período depois de absorver as competências do novo lote. */
  competenciaIni: string;
  competenciaFim: string;
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

    // A auditoria da empresa é UMA. O cliente manda os arquivos em várias
    // levas — SPED numa, XMLs em outra, PDFs depois — e todas precisam desaguar
    // no mesmo trabalho: é justamente o cruzamento entre elas que produz achado.
    // Criar uma auditoria por leva separaria os dois lados do cruzamento e o
    // sistema não acharia nada.
    const existente = dados.auditoriaId
      ? await tx.auditoria.findFirst({
          where: { id: dados.auditoriaId, empresaId: empresa.id },
        })
      : dados.criarNova
        ? null
        : await tx.auditoria.findFirst({
            where: {
              empresaId: empresa.id,
              // Trabalho entregue ou arquivado não recebe arquivo novo: o que
              // foi apresentado ao cliente não pode mudar por baixo.
              status: { notIn: ["ENTREGUE", "ARQUIVADA"] },
            },
            orderBy: { createdAt: "desc" },
          });

    // O período acompanha o que chegou: importar agosto numa auditoria que ia
    // até março tem de esticar o período, senão o mês novo fica fora de toda
    // regra que percorre a competência.
    const competenciaIni =
      existente && existente.competenciaIni < dados.competenciaIni
        ? existente.competenciaIni
        : dados.competenciaIni;
    const competenciaFim =
      existente && existente.competenciaFim > dados.competenciaFim
        ? existente.competenciaFim
        : dados.competenciaFim;

    const auditoria = existente
      ? await tx.auditoria.update({
          where: { id: existente.id },
          data: { competenciaIni, competenciaFim, status: "IMPORTANDO" },
        })
      : await tx.auditoria.create({
          data: {
            empresaId: empresa.id,
            titulo:
              dados.titulo ??
              `Auditoria ${competenciaIni.slice(0, 4)}–${competenciaFim.slice(0, 4)}`,
            competenciaIni,
            competenciaFim,
            status: "IMPORTANDO",
          },
        });

    // O hash impede que o mesmo arquivo entre duas vezes — o que acontece o
    // tempo todo quando o cliente manda o pacote de novo "por garantia". A
    // conferência é contra o que JÁ existe na auditoria, não só dentro do lote.
    const jaNaAuditoria = await tx.documento.findMany({
      where: { auditoriaId: auditoria.id },
      select: { hash: true },
    });
    const vistos = new Set(jaNaAuditoria.map((d) => d.hash));

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
      auditoriaCriada: !existente,
      documentosRegistrados: registrados,
      documentosDuplicados: duplicados,
      competenciaIni,
      competenciaFim,
    };
  });

  return { ...resultado, empresaCriada };
}

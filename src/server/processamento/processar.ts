import { readFile } from "node:fs/promises";
import { Prisma, type OrigemNota, type TipoDocumento } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { parseNfeXml } from "@/server/extraction/nfe-xml";
import { parseNfseXml } from "@/server/extraction/nfse-xml";
import { parseSpedEfd } from "@/server/extraction/sped";
import {
  parseSpedContribuicoes,
  type ExtractionResultSpedContribuicoes,
} from "@/server/extraction/sped-contribuicoes";
import { parseExtratoPgdas, ehExtratoPgdas } from "@/server/extraction/pgdas-extrato";
import { parseSituacaoFiscal } from "@/server/extraction/situacao-fiscal";
import { parseApuracaoDctf } from "@/server/extraction/dctf-mit";
import { parseEcf } from "@/server/extraction/ecf";
import { paraCompetencia } from "@/server/extraction/identificar-empresa";
import { parseEcd } from "@/server/extraction/ecd";
import { pdfBufferParaTexto } from "@/server/extraction/pdf-texto";
import { decodeTextBuffer } from "@/server/extraction/encoding";
import { ehZip } from "@/server/extraction/zip";
import { classificar, classificarPdf } from "@/server/extraction/classificar";
import type { ExtractionResult } from "@/server/extraction/types";
import {
  contagemVazia,
  persistirApuracaoContribuicoes,
  persistirApuracaoIcms,
  persistirEventos,
  persistirNotas,
  persistirControleEscrituracao,
  persistirDctf,
  persistirEcd,
  persistirEcf,
  persistirPgdas,
  persistirSituacaoFiscal,
  reconciliar,
  somarContagens,
  totalDe,
  type ContagemPersistida,
} from "./persistir";

/**
 * Processamento: transforma os arquivos importados em dados consultáveis.
 *
 * Um documento com defeito NUNCA derruba os outros. Numa auditoria de 5 anos, um
 * XML corrompido no meio de 40 mil não pode custar o trabalho inteiro: ele é
 * marcado como ERRO, com a mensagem, e a fila segue.
 */

export interface ResultadoProcessamento {
  processados: number;
  comErro: number;
  ignorados: number;
  registros: ContagemPersistida;
  reconciliacao: { canceladas: number; escrituradas: number };
  erros: { documento: string; mensagem: string }[];
}

/** Tipos que ainda não têm parser. Viram IGNORADO com motivo, não erro. */
const SEM_PARSER: Partial<Record<TipoDocumento, string>> = {
  DCTFWEB: "Parser de DCTFWeb ainda não implementado.",
  COMPROVANTE_ARRECADACAO:
    "Parser de comprovante de arrecadação (DARF/DAS/DARE) ainda não implementado.",
  ESOCIAL: "Parser de eSocial ainda não implementado.",
  EFD_REINF: "Parser de EFD-Reinf ainda não implementado.",
  CARTAO_CNPJ: "Cartão CNPJ é guardado para consulta; não há extração automática.",
  CERTIDAO:
    "Certidão de débitos guardada para consulta. A leitura automática não é feita: " +
    "o que vale para a auditoria é o Relatório de Situação Fiscal, que detalha cada pendência.",
  INSCRICAO_ESTADUAL: "Documento cadastral guardado para consulta.",
  RECIBO_ENTREGA:
    "Recibo de transmissão. Comprova a entrega da escrituração, mas não traz dado fiscal.",
  CONTRATO_SOCIAL: "Contrato social é guardado para consulta; não há extração automática.",
  PLANILHA: "Planilha exige mapeamento de contas; não é processada automaticamente.",
  DESCONHECIDO: "Conteúdo não reconhecido.",
};

export interface OpcoesProcessamento {
  /**
   * Relê também os documentos já concluídos. Necessário depois de corrigir um
   * parser: sem isso, o dado errado gravado na leitura anterior continuaria lá.
   */
  reprocessarTudo?: boolean;
}

export async function processarAuditoria(
  auditoriaId: string,
  opcoes: OpcoesProcessamento = {},
): Promise<ResultadoProcessamento> {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: auditoriaId },
    include: { empresa: true },
  });
  if (!auditoria) throw new Error("Auditoria não encontrada.");

  const cnpjEmpresa = auditoria.empresa.cnpj;
  const uf = auditoria.empresa.uf ?? undefined;

  const pendentes = await prisma.documento.findMany({
    where: opcoes.reprocessarTudo
      ? { auditoriaId }
      : { auditoriaId, status: { in: ["PENDENTE", "ERRO"] } },
    orderBy: { createdAt: "asc" },
  });

  await prisma.auditoria.update({
    where: { id: auditoriaId },
    data: { status: "PROCESSANDO" },
  });

  let registros = contagemVazia();
  let processados = 0;
  let comErro = 0;
  let ignorados = 0;
  const erros: { documento: string; mensagem: string }[] = [];

  for (const doc of pendentes) {
    try {
      const buffer = await readFile(doc.caminho);

      // Pacote: o documento registrado é o .zip, mas o conteúdo é que importa.
      const ehPacote = ehZip(buffer) && doc.tipo === "DESCONHECIDO";

      // Reclassifica o que ficou como DESCONHECIDO numa importação anterior.
      // A classificação melhora com o tempo — reconhecer um novo leiaute não
      // pode obrigar o usuário a reimportar centenas de megabytes.
      if (doc.tipo === "DESCONHECIDO" && !ehPacote) {
        const novoTipo = await reclassificar(buffer, doc.nomeArquivo);
        if (novoTipo && novoTipo.tipo !== "DESCONHECIDO") {
          await prisma.documento.update({
            where: { id: doc.id },
            data: {
              tipo: novoTipo.tipo,
              metadados: {
                motivoClassificacao: novoTipo.motivo,
                classificacaoSegura: novoTipo.seguro,
                reclassificado: true,
              },
            },
          });
          doc.tipo = novoTipo.tipo;
        }
      }

      const motivoAtualizado = SEM_PARSER[doc.tipo];
      if (motivoAtualizado && !ehPacote) {
        await prisma.documento.update({
          where: { id: doc.id },
          data: {
            status: "IGNORADO",
            erros: [motivoAtualizado] as Prisma.InputJsonValue,
            processadoEm: new Date(),
          },
        });
        ignorados += 1;
        continue;
      }

      const contagem = await processarDocumento(
        doc.id,
        doc.tipo,
        doc.nomeArquivo,
        buffer,
        cnpjEmpresa,
        uf,
        ehPacote,
      );

      registros = somarContagens(registros, contagem);
      processados += 1;
    } catch (e) {
      const mensagem = (e as Error).message;
      await prisma.documento.update({
        where: { id: doc.id },
        data: {
          status: "ERRO",
          erros: [mensagem] as Prisma.InputJsonValue,
          processadoEm: new Date(),
        },
      });
      comErro += 1;
      erros.push({ documento: doc.nomeArquivo, mensagem });
    }
  }

  // Só agora, com todos os arquivos lidos, dá para cruzar evento com nota e
  // XML com escrituração: cada lado estava num documento diferente.
  const reconciliacao = await reconciliar(auditoriaId);

  await prisma.auditoria.update({
    where: { id: auditoriaId },
    data: { status: "PRONTA", executadaEm: new Date() },
  });

  return { processados, comErro, ignorados, registros, reconciliacao, erros };
}

/**
 * Nova tentativa de classificar um documento que ficou como DESCONHECIDO.
 *
 * Para PDF, extrai o texto e classifica por ele — e, quando o PDF é digitalizado
 * e não tem texto, cai na dedução pelo nome, declarada como insegura.
 */
async function reclassificar(buffer: Buffer, nomeArquivo: string) {
  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    try {
      const texto = await pdfBufferParaTexto(buffer);
      return classificarPdf(texto, nomeArquivo);
    } catch {
      // PDF ilegível continua desconhecido; o erro já aparece no documento.
      return null;
    }
  }
  return classificar(buffer, nomeArquivo);
}

async function processarDocumento(
  documentoId: string,
  tipo: TipoDocumento,
  nomeArquivo: string,
  buffer: Buffer,
  cnpjEmpresa: string,
  uf: string | undefined,
  ehPacote: boolean,
): Promise<ContagemPersistida> {
  // Idempotência: apaga o que ESTE documento produziu antes de reler.
  // Sem isso, reprocessar duplicaria notas, itens e apurações — e o
  // totalizador do relatório passaria a contar a mesma nota duas vezes.
  await limparExtracaoAnterior(documentoId);

  await prisma.documento.update({
    where: { id: documentoId },
    data: { status: "PROCESSANDO" },
  });

  const avisos: string[] = [];
  let contagem = contagemVazia();
  let parser = "";

  if (ehPacote) {
    parser = "zip";
    contagem = await processarPacote(
      documentoId,
      buffer,
      nomeArquivo,
      cnpjEmpresa,
      uf,
      avisos,
    );
  } else {
    const r = await processarUnico(documentoId, tipo, buffer, cnpjEmpresa, uf);
    parser = r.parser;
    contagem = r.contagem;
    avisos.push(...r.avisos);
  }

  await prisma.documento.update({
    where: { id: documentoId },
    data: {
      status: "CONCLUIDO",
      parser,
      registrosExtraidos: totalDe(contagem),
      erros: avisos.length > 0 ? (avisos as Prisma.InputJsonValue) : Prisma.DbNull,
      processadoEm: new Date(),
      metadados: {
        notas: contagem.notas,
        itens: contagem.itens,
        apuracoesIcms: contagem.apuracoesIcms,
        apuracoesContribuicoes: contagem.apuracoesContribuicoes,
        apuracoesSimples: contagem.apuracoesSimples,
        eventos: contagem.eventos,
        pendenciasFiscais: contagem.pendenciasFiscais,
        confissoes: contagem.confissoes,
        apuracoesEcf: contagem.apuracoesEcf,
        saldosContabeis: contagem.saldosContabeis,
        lancamentosContabeis: contagem.lancamentosContabeis,
        linhasDre: contagem.linhasDre,
      },
    },
  });

  return contagem;
}

/**
 * Remove tudo que uma leitura anterior deste documento gravou.
 *
 * Os itens de nota caem por cascade a partir de `NotaFiscal`; os demais são
 * apagados diretamente, cada um pela chave do documento.
 */
async function limparExtracaoAnterior(documentoId: string) {
  await prisma.$transaction([
    prisma.notaFiscal.deleteMany({ where: { documentoId } }),
    prisma.eventoNfe.deleteMany({ where: { documentoId } }),
    prisma.apuracaoFiscal.deleteMany({ where: { documentoId } }),
    prisma.apuracaoContribuicoes.deleteMany({ where: { documentoId } }),
    prisma.apuracaoSimples.deleteMany({ where: { documentoId } }),
    prisma.pendenciaFiscal.deleteMany({ where: { documentoId } }),
    prisma.retratoSituacaoFiscal.deleteMany({ where: { documentoId } }),
    prisma.confissao.deleteMany({ where: { documentoId } }),
    prisma.apuracaoEcf.deleteMany({ where: { documentoId } }),
    prisma.linhaEcf.deleteMany({ where: { documentoId } }),
    prisma.socioEcf.deleteMany({ where: { documentoId } }),
    prisma.contaContabil.deleteMany({ where: { documentoId } }),
    prisma.saldoConta.deleteMany({ where: { documentoId } }),
    prisma.lancamentoContabil.deleteMany({ where: { documentoId } }),
    prisma.linhaDre.deleteMany({ where: { documentoId } }),
    prisma.escrituracaoArquivo.deleteMany({ where: { documentoId } }),
    prisma.apuracaoDifal.deleteMany({ where: { documentoId } }),
    prisma.inventario.deleteMany({ where: { documentoId } }),
  ]);
}

async function processarUnico(
  documentoId: string,
  tipo: TipoDocumento,
  buffer: Buffer,
  cnpjEmpresa: string,
  uf: string | undefined,
): Promise<{ parser: string; contagem: ContagemPersistida; avisos: string[] }> {
  switch (tipo) {
    case "NFE_XML":
    case "NFCE_XML":
    case "EVENTO_NFE": {
      const r = parseNfeXml(decodeTextBuffer(buffer).text, "SAIDA", {
        cnpjEmpresa,
      });
      const contagem = await gravarExtracao(
        documentoId,
        r,
        "XML_AUTORIZADO",
        cnpjEmpresa,
        uf,
      );
      return { parser: "nfe-xml", contagem, avisos: r.warnings };
    }

    case "NFSE_XML": {
      const r = parseNfseXml(buffer, "SAIDA");
      const contagem = await gravarExtracao(
        documentoId,
        r,
        "XML_AUTORIZADO",
        cnpjEmpresa,
        uf,
      );
      return { parser: "nfse-xml", contagem, avisos: r.warnings };
    }

    case "SPED_FISCAL": {
      const r = parseSpedEfd(buffer);
      // As notas do SPED são o que a contabilidade ESCRITUROU — é contra isto
      // que os XMLs autorizados são confrontados.
      const contagem = await gravarExtracao(
        documentoId,
        r,
        "ESCRITURACAO",
        cnpjEmpresa,
        r.identification?.uf ?? uf,
      );
      return { parser: "sped", contagem, avisos: r.warnings };
    }

    case "SPED_CONTRIBUICOES": {
      const r = parseSpedContribuicoes(buffer);
      const contagem = await gravarExtracao(
        documentoId,
        r,
        "ESCRITURACAO",
        cnpjEmpresa,
        uf,
      );
      return { parser: "sped-contribuicoes", contagem, avisos: r.warnings };
    }

    case "SITUACAO_FISCAL": {
      // O relatório é sempre PDF, mas aceita texto para quem salvou a página.
      const texto =
        buffer.subarray(0, 5).toString("latin1") === "%PDF-"
          ? await pdfBufferParaTexto(buffer)
          : decodeTextBuffer(buffer).text;

      const extraida = parseSituacaoFiscal(texto);
      if (!extraida) {
        return {
          parser: "situacao-fiscal",
          contagem: contagemVazia(),
          avisos: ["O arquivo não tem a estrutura do Relatório de Situação Fiscal."],
        };
      }

      const contagem = contagemVazia();
      contagem.pendenciasFiscais = await prisma.$transaction((tx) =>
        persistirSituacaoFiscal(tx, documentoId, extraida),
      );
      // O retrato conta como registro extraído mesmo sem pendência: é ele que
      // prova que o relatório foi lido, e "empresa sem pendência" é resultado.
      if (contagem.pendenciasFiscais === 0) contagem.pendenciasFiscais = 1;

      return { parser: "situacao-fiscal", contagem, avisos: extraida.avisos };
    }

    case "ECF": {
      const ecf = parseEcf(buffer);
      if (!ecf) {
        return {
          parser: "ecf",
          contagem: contagemVazia(),
          avisos: ["O arquivo não tem a estrutura de uma ECF (registro |0000|LECF|)."],
        };
      }
      const contagem = contagemVazia();
      contagem.apuracoesEcf = await prisma.$transaction((tx) =>
        persistirEcf(tx, documentoId, ecf),
      );
      return { parser: "ecf", contagem, avisos: ecf.avisos };
    }

    case "ECD": {
      const ecd = parseEcd(buffer);
      if (!ecd) {
        return {
          parser: "ecd",
          contagem: contagemVazia(),
          avisos: ["O arquivo não tem a estrutura de uma ECD (registro |0000|LECD|)."],
        };
      }
      const contagem = { ...contagemVazia(), ...(await persistirEcd(documentoId, ecd)) };
      return { parser: "ecd", contagem, avisos: ecd.avisos };
    }

    case "DCTF": {
      const apuracao = parseApuracaoDctf(buffer);
      if (!apuracao) {
        return {
          parser: "dctf-mit",
          contagem: contagemVazia(),
          avisos: [
            "O arquivo não tem a estrutura da apuração de débitos da DCTF " +
              "(elemento ApuracaoDebitosDctf).",
          ],
        };
      }

      const contagem = contagemVazia();
      contagem.confissoes = await prisma.$transaction((tx) =>
        persistirDctf(tx, documentoId, apuracao),
      );
      return { parser: "dctf-mit", contagem, avisos: apuracao.avisos };
    }

    case "PGDAS": {
      const texto = buffer.subarray(0, 5).toString("latin1") === "%PDF-"
        ? await pdfBufferParaTexto(buffer)
        : decodeTextBuffer(buffer).text;

      if (!ehExtratoPgdas(texto)) {
        return {
          parser: "pgdas-extrato",
          contagem: contagemVazia(),
          avisos: ["O arquivo não tem a estrutura de um extrato do PGDAS-D."],
        };
      }

      const extrato = parseExtratoPgdas(texto);
      if (!extrato) {
        return {
          parser: "pgdas-extrato",
          contagem: contagemVazia(),
          avisos: ["Não foi possível extrair os valores do extrato."],
        };
      }

      const contagem = contagemVazia();
      contagem.apuracoesSimples = await prisma.$transaction((tx) =>
        persistirPgdas(tx, documentoId, extrato),
      );
      return { parser: "pgdas-extrato", contagem, avisos: extrato.avisos };
    }

    default:
      throw new Error(`Sem parser para o tipo ${tipo}.`);
  }
}

/**
 * Pacote .zip: o roteamento por conteúdo já é feito pelo `extrairDeZip`, que
 * devolve tudo consolidado num resultado só.
 *
 * O ponto delicado é a origem: um mesmo pacote pode trazer XMLs (autorizados) e
 * um SPED (escrituração). Como o resultado vem unificado, o pacote é inspecionado
 * antes para saber se contém escrituração — e, quando contém, é processado em
 * duas passadas, cada uma com sua origem. Misturar as duas origens numa só
 * inviabilizaria o cruzamento "emitida × escriturada".
 */
async function processarPacote(
  documentoId: string,
  buffer: Buffer,
  nomeArquivo: string,
  cnpjEmpresa: string,
  uf: string | undefined,
  avisos: string[],
): Promise<ContagemPersistida> {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  const entradas = Object.values(zip.files).filter((f) => !f.dir);

  let contagem = contagemVazia();

  for (const entrada of entradas) {
    let interno: Buffer;
    try {
      interno = Buffer.from(await entrada.async("nodebuffer"));
    } catch (e) {
      avisos.push(`${entrada.name}: não foi possível extrair — ${(e as Error).message}`);
      continue;
    }

    const cls = classificar(interno, entrada.name);
    if (SEM_PARSER[cls.tipo]) {
      avisos.push(`${entrada.name}: ${SEM_PARSER[cls.tipo]}`);
      continue;
    }

    try {
      const r = await processarUnico(documentoId, cls.tipo, interno, cnpjEmpresa, uf);
      contagem = somarContagens(contagem, r.contagem);
      for (const a of r.avisos) avisos.push(`${entrada.name}: ${a}`);
    } catch (e) {
      // Um arquivo ruim no meio do pacote não custa os outros.
      avisos.push(`${entrada.name}: ${(e as Error).message}`);
    }
  }

  if (entradas.length === 0) {
    avisos.push(`${nomeArquivo}: pacote vazio.`);
  }

  return contagem;
}

/** Grava notas, itens, eventos e apurações de um resultado de extração. */
async function gravarExtracao(
  documentoId: string,
  resultado: ExtractionResult,
  origem: OrigemNota,
  cnpjEmpresa: string,
  uf: string | undefined,
): Promise<ContagemPersistida> {
  const contagem = contagemVazia();

  // Timeout ampliado: um SPED mensal traz milhares de notas com seus itens, e
  // o padrão de 5 s do Prisma não cobre isso em máquina de escritório.
  await prisma.$transaction(
    async (tx) => {
      const n = await persistirNotas(tx, documentoId, resultado, origem, cnpjEmpresa);
      contagem.notas = n.notas;
      contagem.itens = n.itens;

      contagem.eventos = await persistirEventos(tx, documentoId, resultado);

      contagem.apuracoesIcms = await persistirApuracaoIcms(
        tx,
        documentoId,
        resultado.apuracoes,
        uf,
      );

      if (ehResultadoContribuicoes(resultado)) {
        contagem.apuracoesContribuicoes = await persistirApuracaoContribuicoes(
          tx,
          documentoId,
          resultado,
        );
      }

      // Controle do arquivo (prazo, atividade, Bloco K, DIFAL, inventário): só
      // para escrituração, que tem período próprio no registro 0000.
      const ident = resultado.identification;
      const contrib = ehResultadoContribuicoes(resultado)
        ? resultado.contribIdentification
        : undefined;
      const inicio = ident?.periodStart ?? contrib?.periodStart;
      if (inicio && origem === "ESCRITURACAO") {
        await persistirControleEscrituracao(
          tx,
          documentoId,
          resultado,
          paraCompetencia(inicio),
          ident?.activityIndicator,
          ident?.purposeCode,
        );
      }
    },
    { timeout: 120_000, maxWait: 30_000 },
  );

  return contagem;
}

function ehResultadoContribuicoes(
  r: ExtractionResult,
): r is ExtractionResultSpedContribuicoes {
  return "pis" in r && "cofins" in r;
}

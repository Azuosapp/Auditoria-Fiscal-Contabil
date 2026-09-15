import { createHash } from "node:crypto";
import type { TipoDocumento } from "@prisma/client";
import JSZip from "jszip";
import { classificar, classificarPdf, type Classificacao } from "@/server/extraction/classificar";
import { pdfBufferParaTexto } from "@/server/extraction/pdf-texto";
import { parseNfeXml } from "@/server/extraction/nfe-xml";
import { decodeTextBuffer } from "@/server/extraction/encoding";
import {
  ColetorIdentidade,
  lerRegistro0000,
  regimeDaEcf,
  paraCompetencia,
  type ResultadoIdentificacao,
} from "@/server/extraction/identificar-empresa";
import { parseExtratoPgdas, ehExtratoPgdas } from "@/server/extraction/pgdas-extrato";

/**
 * Análise do lote recém-recebido, ANTES de existir empresa ou auditoria.
 *
 * Responde a três perguntas, lendo só o necessário de cada arquivo:
 *   1. De quem são estes documentos?
 *   2. Que período cobrem?
 *   3. Em que regime a empresa esteve em cada exercício?
 *
 * Deliberadamente NÃO extrai notas, lançamentos nem apurações: isso é trabalho
 * do processamento, depois que a auditoria existe. Aqui o objetivo é dar ao
 * usuário, em segundos, a confirmação de que os arquivos são de quem ele pensa.
 */

export interface ArquivoRecebido {
  nome: string;
  buffer: Buffer;
}

export interface ArquivoAnalisado {
  nome: string;
  tamanhoBytes: number;
  hash: string;
  tipo: TipoDocumento;
  motivo: string;
  seguro: boolean;
  /** Quantos arquivos havia dentro, quando é pacote .zip. */
  contidos?: number;
  aviso?: string;
}

export interface ResumoTipo {
  tipo: TipoDocumento;
  quantidade: number;
}

export interface AnaliseLote {
  identificacao: ResultadoIdentificacao;
  arquivos: ArquivoAnalisado[];
  resumoPorTipo: ResumoTipo[];
  totalArquivos: number;
  totalBytes: number;
  /** Arquivos idênticos dentro do próprio envio, já descartados. */
  duplicadosNoEnvio: number;
  avisos: string[];
}

/** Teto de arquivos abertos por pacote — proteção contra zip bomb. */
const MAX_POR_ZIP = 5000;

export async function analisarLote(
  recebidos: ArquivoRecebido[],
): Promise<AnaliseLote> {
  const coletor = new ColetorIdentidade();
  const arquivos: ArquivoAnalisado[] = [];
  const avisos: string[] = [];
  const contagem = new Map<TipoDocumento, number>();

  const conta = (t: TipoDocumento, n = 1) =>
    contagem.set(t, (contagem.get(t) ?? 0) + n);

  // O mesmo arquivo costuma vir duas vezes no mesmo envio: a pasta de janeiro e
  // a de "tudo", o zip e o arquivo solto. Descartar pelo CONTEÚDO evita ler e
  // contar duas vezes — nome diferente não faz o arquivo ser outro.
  const hashesVistos = new Set<string>();
  let duplicadosNoEnvio = 0;

  for (const recebido of recebidos) {
    const hash = createHash("sha256").update(recebido.buffer).digest("hex");

    if (hashesVistos.has(hash)) {
      duplicadosNoEnvio += 1;
      continue;
    }
    hashesVistos.add(hash);

    const classificacao = classificar(recebido.buffer, recebido.nome);

    // Pacote: o conteúdo é que manda. É assim que o arquivo fiscal chega —
    // o portal entrega o mês inteiro num zip, com notas e eventos misturados.
    if (
      classificacao.tipo === "DESCONHECIDO" &&
      classificacao.motivo.startsWith("pacote ZIP")
    ) {
      const dentro = await analisarZip(recebido, coletor, conta, avisos);
      arquivos.push({
        nome: recebido.nome,
        tamanhoBytes: recebido.buffer.length,
        hash,
        tipo: "DESCONHECIDO",
        motivo: `pacote com ${dentro} arquivo(s)`,
        seguro: true,
        contidos: dentro,
      });
      continue;
    }

    const analisado = await analisarArquivo(
      recebido.nome,
      recebido.buffer,
      classificacao,
      coletor,
      avisos,
    );
    conta(analisado.tipo);
    arquivos.push({ ...analisado, hash });
  }

  const identificacao = coletor.concluir();

  if (!identificacao.empresa) {
    avisos.push(
      "Nenhum arquivo permitiu identificar a empresa. Inclua um SPED " +
        "(Fiscal, Contribuições, ECD ou ECF) ou XMLs de nota fiscal.",
    );
  }

  const resumoPorTipo = [...contagem.entries()]
    .map(([tipo, quantidade]) => ({ tipo, quantidade }))
    .sort((a, b) => b.quantidade - a.quantidade);

  if (duplicadosNoEnvio > 0) {
    avisos.push(
      `${duplicadosNoEnvio} arquivo(s) idêntico(s) no próprio envio foram ` +
        `ignorados (mesmo conteúdo, ainda que com nome diferente).`,
    );
  }

  return {
    identificacao,
    arquivos,
    resumoPorTipo,
    totalArquivos: arquivos.length,
    totalBytes: arquivos.reduce((s, a) => s + a.tamanhoBytes, 0),
    duplicadosNoEnvio,
    avisos,
  };
}

async function analisarZip(
  recebido: ArquivoRecebido,
  coletor: ColetorIdentidade,
  conta: (t: TipoDocumento, n?: number) => void,
  avisos: string[],
): Promise<number> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(recebido.buffer);
  } catch (e) {
    avisos.push(`Não foi possível abrir ${recebido.nome}: ${(e as Error).message}`);
    return 0;
  }

  const entradas = Object.values(zip.files).filter((f) => !f.dir);
  if (entradas.length > MAX_POR_ZIP) {
    avisos.push(
      `${recebido.nome} tem ${entradas.length} arquivos; foram lidos os ` +
        `primeiros ${MAX_POR_ZIP} para a identificação.`,
    );
  }

  let lidos = 0;
  for (const entrada of entradas.slice(0, MAX_POR_ZIP)) {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await entrada.async("nodebuffer"));
    } catch {
      // Um arquivo corrompido não pode custar os outros 299 do pacote.
      continue;
    }
    const cls = classificar(buffer, entrada.name);
    const res = await analisarArquivo(entrada.name, buffer, cls, coletor, avisos);
    conta(res.tipo);
    lidos += 1;
  }
  return lidos;
}

async function analisarArquivo(
  nome: string,
  buffer: Buffer,
  classificacao: Classificacao,
  coletor: ColetorIdentidade,
  avisos: string[],
): Promise<Omit<ArquivoAnalisado, "hash">> {
  let { tipo, motivo, seguro } = classificacao;
  let aviso: string | undefined;

  // PDF: o tipo só se revela no texto, e extrair texto custa um processo
  // externo — por isso só aqui, e não na classificação geral.
  if (tipo === "DESCONHECIDO" && motivo.startsWith("PDF")) {
    try {
      const texto = await pdfBufferParaTexto(buffer);
      const cls = classificarPdf(texto);
      tipo = cls.tipo;
      motivo = cls.motivo;
      seguro = cls.seguro;
      if (tipo === "PGDAS") lerPgdas(texto, coletor);
    } catch (e) {
      aviso = `Não foi possível ler o texto do PDF: ${(e as Error).message}`;
    }
  }

  switch (tipo) {
    case "SPED_FISCAL":
    case "SPED_CONTRIBUICOES":
    case "ECD":
    case "ECF": {
      const r = lerRegistro0000(buffer, tipo);
      if (r.identidade) {
        coletor.registrarEscrituracao(r.identidade);
      } else {
        aviso = "Arquivo SPED sem registro 0000 legível.";
      }
      coletor.registrarCompetencia(r.competenciaIni);
      coletor.registrarCompetencia(r.competenciaFim);

      if (tipo === "ECF") {
        const regime = regimeDaEcf(buffer);
        const exercicio = Number(r.competenciaIni?.slice(0, 4));
        if (regime && Number.isFinite(exercicio)) {
          coletor.registrarRegime({
            exercicio,
            regime,
            origem: "ECF — blocos presentes na escrituração",
          });
        }
      }
      break;
    }

    case "NFE_XML":
    case "NFCE_XML": {
      try {
        // A direção é irrelevante aqui: só interessa quem são os participantes.
        const r = parseNfeXml(decodeTextBuffer(buffer).text, "SAIDA");
        for (const inv of r.invoices) {
          coletor.registrarParticipanteNota(inv.emitCnpj, inv.emitName, inv.emitUf);
          coletor.registrarParticipanteNota(inv.destDoc, inv.destName, inv.destUf);
          coletor.registrarCompetencia(inv.issueDate);
        }
      } catch (e) {
        aviso = `XML ilegível: ${(e as Error).message}`;
      }
      break;
    }

    case "PGDAS": {
      // PGDAS em texto (não PDF) também ocorre quando o usuário salva a página.
      const texto = decodeTextBuffer(buffer).text;
      if (ehExtratoPgdas(texto)) lerPgdas(texto, coletor);
      break;
    }

    default:
      break;
  }

  if (aviso) avisos.push(`${nome}: ${aviso}`);
  return { nome, tamanhoBytes: buffer.length, tipo, motivo, seguro, aviso };
}

/**
 * Extrato do PGDAS-D prova duas coisas de uma vez: a competência e que, naquele
 * exercício, a empresa era optante do Simples Nacional.
 */
function lerPgdas(texto: string, coletor: ColetorIdentidade) {
  const extrato = parseExtratoPgdas(texto);
  if (!extrato) return;

  // O parser já devolve a competência normalizada como "AAAA-MM".
  const competencia = extrato.competencia;
  if (competencia) {
    coletor.registrarCompetencia(competencia);
    coletor.registrarRegime({
      exercicio: Number(competencia.slice(0, 4)),
      regime: "SIMPLES_NACIONAL",
      origem: "extrato do PGDAS-D",
    });
  }

  if (extrato.cnpj) {
    coletor.registrarEscrituracao({
      cnpj: extrato.cnpj,
      razaoSocial: extrato.razaoSocial,
    });
  }
}

import JSZip from "jszip";
import type { ExtractionResult, ContextoExtracao } from "./types";
import { parseNfeXml } from "./nfe-xml";
import { parseSpedEfd } from "./sped";
import { parseSpedContribuicoes } from "./sped-contribuicoes";
import { parseNfseXml } from "./nfse-xml";
import { decodeTextBuffer } from "./encoding";

/**
 * Leitor de pacote .zip.
 *
 * É como o arquivo fiscal realmente chega: o portal da SEFAZ e os sistemas de
 * escrituração entregam o mês inteiro num zip só, com dezenas de XML dentro —
 * notas e EVENTOS misturados (cancelamento, carta de correção, manifestação do
 * destinatário).
 *
 * Cada arquivo de dentro é roteado pelo PRÓPRIO conteúdo, não pela extensão
 * nem pelo nome: dentro de um zip, `12345.xml` pode ser NF-e, evento ou NFS-e.
 */

/** Assinatura ZIP: "PK\x03\x04" (ou os variantes vazio/spanned). */
export function ehZip(data: Buffer): boolean {
  return (
    data.length >= 4 &&
    data[0] === 0x50 &&
    data[1] === 0x4b &&
    (data[2] === 0x03 || data[2] === 0x05 || data[2] === 0x07)
  );
}

/** Teto de arquivos por pacote — proteção contra zip bomb, não regra de negócio. */
const MAX_ARQUIVOS = 5000;
/** Teto de bytes descomprimidos somados. */
const MAX_BYTES_DESCOMPRIMIDOS = 300 * 1024 * 1024;

interface Roteado {
  resultado: ExtractionResult;
  nome: string;
}

/**
 * Decide o parser pelo conteúdo do arquivo interno.
 * Devolve `null` para o que não se sabe ler — e isso vira alerta nomeado, não
 * silêncio.
 */
function rotear(
  nome: string,
  buffer: Buffer,
  contexto: ContextoExtracao | undefined,
): ExtractionResult | null {
  const inicio = decodeTextBuffer(buffer.subarray(0, 4096)).text;

  // XML — a raiz decide.
  if (/^\s*<\?xml|^\s*</.test(inicio)) {
    if (/<\s*(\w+:)?procEventoNFe|<\s*(\w+:)?evento[\s>]/i.test(inicio)) {
      // Evento de NF-e: o parser de NF-e reconhece e devolve em `eventos`.
      return parseNfeXml(decodeTextBuffer(buffer).text, "SAIDA", contexto);
    }
    if (/<\s*(\w+:)?(nfeProc|NFe)[\s>]/i.test(inicio)) {
      return parseNfeXml(decodeTextBuffer(buffer).text, "SAIDA", contexto);
    }
    if (/<\s*(\w+:)?(infNFSe|CompNfse|InfNfse|Nfse|infDPS)/i.test(inicio)) {
      return parseNfseXml(buffer, "SAIDA");
    }
    // XML desconhecido (inutilização, distribuição, consulta...).
    return null;
  }

  // SPED — reconhecido pelo registro de abertura.
  if (/^\|0000\|/m.test(inicio)) {
    if (/^\|(0110|M100|M200|M500|M600)\|/m.test(inicio)) {
      return parseSpedContribuicoes(buffer);
    }
    return parseSpedEfd(buffer);
  }

  return null;
}

/**
 * Abre o pacote e consolida o resultado de tudo que soube ler.
 *
 * Um arquivo ruim no meio do pacote NÃO derruba os outros: entra como alerta
 * nomeado e o restante segue. Num zip de 300 notas, uma corrompida não pode
 * custar as 299 boas.
 */
export async function extrairDeZip(
  data: Buffer,
  filename: string,
  contexto?: ContextoExtracao,
): Promise<ExtractionResult> {
  const warnings: string[] = [];
  const errors: string[] = [];

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch (e) {
    return {
      parser: "zip",
      invoices: [],
      warnings,
      errors: [`Não foi possível abrir o pacote ${filename}: ${(e as Error).message}`],
      apuracoes: [],
    };
  }

  const entradas = Object.values(zip.files).filter((f) => !f.dir);
  if (entradas.length === 0) {
    return {
      parser: "zip",
      invoices: [],
      warnings: [`O pacote ${filename} está vazio.`],
      errors: [],
      apuracoes: [],
    };
  }
  if (entradas.length > MAX_ARQUIVOS) {
    return {
      parser: "zip",
      invoices: [],
      warnings,
      errors: [
        `O pacote ${filename} tem ${entradas.length} arquivos, acima do limite ` +
          `técnico de ${MAX_ARQUIVOS}. Divida-o antes de importar.`,
      ],
      apuracoes: [],
    };
  }

  const lidos: Roteado[] = [];
  const naoReconhecidos: string[] = [];
  let bytesTotais = 0;

  for (const entrada of entradas) {
    let buffer: Buffer;
    try {
      buffer = Buffer.from(await entrada.async("nodebuffer"));
    } catch (e) {
      errors.push(`Falha ao extrair "${entrada.name}": ${(e as Error).message}`);
      continue;
    }

    bytesTotais += buffer.length;
    if (bytesTotais > MAX_BYTES_DESCOMPRIMIDOS) {
      errors.push(
        `O pacote ${filename} passou de ${Math.round(MAX_BYTES_DESCOMPRIMIDOS / 1024 / 1024)} MB ` +
          "descomprimidos e a leitura parou. Os arquivos lidos até aqui foram mantidos.",
      );
      break;
    }

    // Pacote dentro de pacote: acontece com arquivo de escritório.
    if (ehZip(buffer)) {
      const aninhado = await extrairDeZip(buffer, entrada.name, contexto);
      lidos.push({ resultado: aninhado, nome: entrada.name });
      continue;
    }

    const r = rotear(entrada.name, buffer, contexto);
    if (!r) {
      naoReconhecidos.push(entrada.name);
      continue;
    }
    lidos.push({ resultado: r, nome: entrada.name });
  }

  // Consolidação. Alerta de arquivo interno leva o nome do arquivo junto —
  // "chave de acesso ausente" sem dizer em qual dos 300 XML é inútil.
  const invoices = lidos.flatMap((l) => l.resultado.invoices);
  const apuracoes = lidos.flatMap((l) => l.resultado.apuracoes);
  const eventos = lidos.flatMap((l) => l.resultado.eventos ?? []);

  for (const l of lidos) {
    for (const w of l.resultado.warnings) warnings.push(`${l.nome}: ${w}`);
    for (const e of l.resultado.errors) errors.push(`${l.nome}: ${e}`);
  }

  if (naoReconhecidos.length > 0) {
    const amostra = naoReconhecidos.slice(0, 5).join(", ");
    warnings.push(
      `${naoReconhecidos.length} arquivo(s) do pacote não foram reconhecidos e ` +
        `NÃO entraram na apuração: ${amostra}` +
        (naoReconhecidos.length > 5 ? " …" : "") +
        ". Pedidos de inutilização e arquivos de consulta caem aqui — o que não " +
        "se sabe ler fica de fora, nomeado.",
    );
  }

  warnings.push(
    `Pacote ${filename}: ${entradas.length} arquivo(s), ${invoices.length} nota(s), ` +
      `${eventos.length} evento(s)` +
      (apuracoes.length ? `, ${apuracoes.length} apuração(ões)` : "") +
      `.`,
  );

  return {
    parser: "zip",
    invoices,
    warnings,
    errors,
    apuracoes,
    eventos,
    arquivosLidos: entradas.length,
    identification: lidos.find((l) => l.resultado.identification)?.resultado
      .identification,
  };
}

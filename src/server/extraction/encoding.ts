/**
 * Detecção/decodificação de encoding para arquivos texto de cliente.
 *
 * SPED (EFD ICMS/IPI, EFD Contribuições) costuma vir em ISO-8859-1 (Latin-1) ou
 * Windows-1252 — não em UTF-8. Ler como UTF-8 não derruba o parser (JS decodifica
 * qualquer byte), mas corrompe acento silenciosamente: "João" vira "Jo�o" ou pior,
 * um byte alto passa a compor um caractere errado sem erro nenhum. Por isso o
 * encoding é VERIFICADO — tentamos decodificar como UTF-8 estrito (`fatal: true`)
 * e só caímos para Latin-1 quando a sequência de bytes não é UTF-8 válido.
 *
 * `latin1` do Node (alias `binary`) mapeia byte-a-byte para os primeiros 256
 * code points do Unicode, que é exatamente a tabela ISO-8859-1. Não cobre
 * Windows-1252 nos bytes 0x80–0x9F (aspas curvas, travessão), mas esses bytes
 * são raríssimos em arquivo fiscal gerado por ERP — quando aparecem, o texto
 * ao redor já denuncia o problema nos warnings de quem consome o resultado.
 */

export type DetectedEncoding = "utf-8" | "latin1";

export interface DecodedText {
  text: string;
  encoding: DetectedEncoding;
  /** true quando o encoding foi informado pelo chamador, não detectado. */
  forced: boolean;
}

/**
 * Decodifica um Buffer para string, detectando UTF-8 vs. Latin-1 quando
 * `forcedEncoding` não é informado.
 */
export function decodeTextBuffer(
  buffer: Buffer,
  forcedEncoding?: DetectedEncoding,
): DecodedText {
  if (forcedEncoding) {
    return {
      text: buffer.toString(forcedEncoding === "utf-8" ? "utf8" : "latin1"),
      encoding: forcedEncoding,
      forced: true,
    };
  }

  // BOM UTF-8 explícito — decide sozinho, sem ambiguidade.
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    return {
      text: buffer.subarray(3).toString("utf8"),
      encoding: "utf-8",
      forced: false,
    };
  }

  try {
    const strict = new TextDecoder("utf-8", { fatal: true });
    return { text: strict.decode(buffer), encoding: "utf-8", forced: false };
  } catch {
    return { text: buffer.toString("latin1"), encoding: "latin1", forced: false };
  }
}

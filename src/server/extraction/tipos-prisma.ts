/**
 * Camada de compatibilidade dos parsers portados do `azuos-tax-engine`.
 *
 * Lá, estes tipos vinham dos enums do Prisma daquele schema. Aqui o schema é outro
 * (ver prisma/schema.prisma): a direção da nota é o enum `DirecaoNota` e o modelo é
 * texto livre, porque a auditoria precisa aceitar modelo que ainda não mapeamos sem
 * derrubar a importação do cliente.
 *
 * Declarar os tipos aqui mantém os parsers idênticos aos do tax-engine — o que
 * significa que correção feita lá continua aplicável aqui, sem tradução.
 */

export type InvoiceDirection = "ENTRADA" | "SAIDA";

export type InvoiceModel = "NFE" | "NFCE" | "NFSE" | "CTE" | "OUTRO";

/** Modelo do parser → coluna `NotaFiscal.modelo` (código do documento fiscal). */
export const CODIGO_MODELO: Record<InvoiceModel, string> = {
  NFE: "55",
  NFCE: "65",
  CTE: "57",
  NFSE: "SE",
  OUTRO: "00",
};

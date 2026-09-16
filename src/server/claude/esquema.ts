import { z } from "zod";

/**
 * Formato da resposta da análise.
 *
 * O esquema vai para o Claude Code (`--json-schema`), que obriga a resposta a
 * segui-lo. A validação com zod roda de novo na chegada: é a fronteira com um
 * sistema externo, e o que entra no banco não pode depender de a outra ponta
 * ter cumprido o combinado.
 *
 * Campos opcionais viajam como texto vazio em vez de null: esquemas com tipo
 * anulável são interpretados de formas diferentes, e string vazia não.
 */

const SEVERIDADES = ["CRITICO", "ALTO", "MEDIO", "BAIXO", "OPORTUNIDADE"] as const;
const AREAS = ["FISCAL", "CONTABIL"] as const;
const CONFIANCAS = ["ALTA", "MEDIA", "BAIXA"] as const;

export const ESQUEMA_RESPOSTA = {
  type: "object",
  additionalProperties: false,
  required: ["resumo", "documentosFaltantes", "apontamentos"],
  properties: {
    resumo: {
      type: "string",
      description:
        "3 a 6 frases para o dono da empresa: o quadro geral, os erros mais graves e o que falta para confirmar.",
    },
    documentosFaltantes: {
      type: "array",
      items: { type: "string" },
      description:
        "Documentos que, se entregues, confirmariam ou mudariam as conclusões. Diga o porquê de cada um.",
    },
    apontamentos: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "titulo",
          "severidade",
          "area",
          "confianca",
          "tributo",
          "competencias",
          "valorEstimado",
          "descricao",
          "recomendacao",
          "baseLegal",
          "evidencias",
        ],
        properties: {
          titulo: { type: "string" },
          severidade: { type: "string", enum: [...SEVERIDADES] },
          area: { type: "string", enum: [...AREAS] },
          confianca: { type: "string", enum: [...CONFIANCAS] },
          tributo: {
            type: "string",
            description: "ICMS, IPI, PIS/COFINS, IRPJ/CSLL, IBS/CBS... Texto vazio se transversal.",
          },
          competencias: {
            type: "array",
            items: { type: "string", pattern: "^\\d{4}-\\d{2}$" },
          },
          valorEstimado: {
            type: "string",
            pattern: "^(-?\\d+(\\.\\d{1,2})?)?$",
            description:
              "Exposição estimada em reais, ponto decimal, sem separador de milhar (ex.: 5316.00). Texto vazio se não houver valor.",
          },
          descricao: {
            type: "string",
            description:
              "O erro, a prova e a memória de cálculo do valor. Linguagem de auditor para contador.",
          },
          recomendacao: { type: "string" },
          baseLegal: { type: "array", items: { type: "string" } },
          evidencias: {
            type: "array",
            minItems: 1,
            items: {
              type: "object",
              additionalProperties: false,
              required: ["arquivo", "localizacao", "detalhe", "valor"],
              properties: {
                arquivo: { type: "string" },
                localizacao: {
                  type: "string",
                  description: "Nº e chave da nota, registro e linha do SPED, código de receita...",
                },
                detalhe: { type: "string" },
                valor: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
} as const;

const Evidencia = z.object({
  arquivo: z.string(),
  localizacao: z.string(),
  detalhe: z.string(),
  valor: z.string(),
});

const Apontamento = z.object({
  titulo: z.string().min(1),
  severidade: z.enum(SEVERIDADES),
  area: z.enum(AREAS),
  confianca: z.enum(CONFIANCAS),
  tributo: z.string(),
  competencias: z.array(z.string().regex(/^\d{4}-\d{2}$/)),
  valorEstimado: z.string().regex(/^(-?\d+(\.\d{1,2})?)?$/),
  descricao: z.string().min(1),
  recomendacao: z.string(),
  baseLegal: z.array(z.string()),
  evidencias: z.array(Evidencia).min(1),
});

export const RespostaAnalise = z.object({
  resumo: z.string(),
  documentosFaltantes: z.array(z.string()),
  apontamentos: z.array(Apontamento),
});

export type RespostaAnalise = z.infer<typeof RespostaAnalise>;

import type { Prisma, TipoDocumento } from "@prisma/client";

/**
 * Contrato entre o motor e as regras.
 *
 * Cada regra recebe o contexto da auditoria, decide sozinha se tem dado para
 * rodar e devolve achados prontos — sem tocar no banco. Isso deixa cada regra
 * testável em isolamento e impede que uma regra escreva onde não deve.
 */

export interface Evidencia {
  /**
   * EXEMPLO é o caso concreto — esta nota, esta chave, este valor. É o que
   * convence na reunião: "foi calculado" não move ninguém, "olhe a nota 3001,
   * emitida em 20/01, de R$ 625,00, que não está no SPED" move.
   *
   * CONFRONTO são os dois números comparados; CONTEXTO é apoio (totais,
   * quantidades, origem do arquivo).
   */
  tipo?: "EXEMPLO" | "CONFRONTO" | "CONTEXTO";
  documentoId?: string;
  arquivo: string;
  registro?: string;
  linha?: number;
  campo?: string;
  valor?: string;
  observacao?: string;
  /** Identificação do documento fiscal, quando o exemplo é uma nota. */
  documentoNumero?: string;
  chave?: string;
  dataDocumento?: string;
  participante?: string;
}

export interface AchadoProduzido {
  /** Código do catálogo — a definição (título, severidade, base legal) vem de lá. */
  codigo: string;
  competencia?: string;
  /** Sobrescreve a severidade do catálogo quando o caso concreto a altera. */
  severidade?: "CRITICO" | "ALTO" | "MEDIO" | "BAIXO" | "OPORTUNIDADE";
  confianca?: "ALTA" | "MEDIA" | "BAIXA";
  descricao: string;
  /** Frase pronta para a apresentação; `{valor}` e `{competencia}` já resolvidos. */
  textoCliente?: string;
  recomendacao?: string;
  valorExposicao?: Prisma.Decimal;
  /**
   * O achado nasce de valor declarado pela própria empresa? Decide a contagem
   * decadencial (art. 150, § 4º x art. 173, I). Ver prescricao.ts.
   */
  declarado: boolean;
  /** O que precisa ser conferido quando a confiança não é ALTA. */
  ressalva?: string;
  evidencias: Evidencia[];
}

export interface ContextoRegra {
  auditoriaId: string;
  empresaCnpj: string;
  empresaUf?: string;
  competenciaIni: string;
  competenciaFim: string;
  /** Regime por exercício — define qual regra se aplica a cada ano. */
  regimePorExercicio: Map<number, string>;
  /** Tipos de documento efetivamente presentes E processados nesta auditoria. */
  fontesDisponiveis: Set<TipoDocumento>;
}

export interface Regra {
  /** Códigos do catálogo que esta regra pode produzir. */
  codigos: string[];
  executar(ctx: ContextoRegra): Promise<AchadoProduzido[]>;
}

/** Competências do período auditado, em ordem. */
export function competenciasDoPeriodo(ini: string, fim: string): string[] {
  const lista: string[] = [];
  let [ano, mes] = ini.split("-").map(Number);
  const [anoFim, mesFim] = fim.split("-").map(Number);

  // Teto de segurança: período mal informado não pode virar laço infinito.
  for (let i = 0; i < 1200; i++) {
    const atual = `${ano}-${String(mes).padStart(2, "0")}`;
    lista.push(atual);
    if (ano > anoFim || (ano === anoFim && mes >= mesFim)) break;
    mes += 1;
    if (mes > 12) {
      mes = 1;
      ano += 1;
    }
  }

  return lista;
}

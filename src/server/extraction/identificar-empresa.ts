import type { RegimeTributario, TipoDocumento } from "@prisma/client";
import { decodeTextBuffer } from "./encoding";

/**
 * Descoberta de QUEM é a empresa auditada, a partir dos próprios arquivos.
 *
 * O usuário não digita CNPJ: ele joga 5 anos de documentos e o sistema deduz a
 * empresa, o período e o regime de cada exercício. Isso elimina o erro mais caro
 * da operação — importar os arquivos da empresa A dentro da auditoria da B.
 *
 * Hierarquia de confiança, do mais forte para o mais fraco:
 *
 *   1. Registro 0000 do SPED — diz explicitamente de quem é a escrituração.
 *      Inequívoco. Uma ECD basta para fechar a identificação.
 *   2. Frequência nos XMLs — a empresa é o CNPJ que aparece em quase toda nota,
 *      ora como emitente (saída), ora como destinatário (entrada). Terceiros
 *      aparecem em poucas.
 *
 * Nunca se cria empresa com base em pista fraca sem o usuário confirmar.
 */

export interface IdentidadeEmpresa {
  cnpj: string;
  razaoSocial?: string;
  uf?: string;
  inscricaoEstadual?: string;
  codigoMunicipio?: string;
  inscricaoMunicipal?: string;
}

export interface RegimeDetectado {
  exercicio: number;
  regime: RegimeTributario;
  origem: string;
}

export interface Candidato extends IdentidadeEmpresa {
  /** Em quantos documentos este CNPJ apareceu como a entidade da escrituração. */
  ocorrenciasFortes: number;
  /** Em quantas notas apareceu, em qualquer papel. */
  ocorrenciasNotas: number;
}

export interface ResultadoIdentificacao {
  empresa?: IdentidadeEmpresa;
  /** ALTA quando veio do registro 0000; MEDIA quando foi deduzida dos XMLs. */
  confianca: "ALTA" | "MEDIA" | "BAIXA";
  motivo: string;
  /** Outros CNPJs que apareceram — o usuário escolhe se a dedução errou. */
  outrosCandidatos: Candidato[];
  /** Menor e maior competência encontradas, no formato "AAAA-MM". */
  competenciaIni?: string;
  competenciaFim?: string;
  regimes: RegimeDetectado[];
}

/** Acumula o que cada arquivo revelou. Um por importação. */
export class ColetorIdentidade {
  private fortes = new Map<string, Candidato>();
  private notas = new Map<string, Candidato>();
  private competencias = new Set<string>();
  private regimes = new Map<number, RegimeDetectado>();

  /** Identificação vinda do registro 0000 de um SPED — evidência forte. */
  registrarEscrituracao(id: IdentidadeEmpresa) {
    const cnpj = normalizarCnpj(id.cnpj);
    if (!cnpj) return;
    const atual = this.fortes.get(cnpj) ?? {
      ...id,
      cnpj,
      ocorrenciasFortes: 0,
      ocorrenciasNotas: 0,
    };
    atual.ocorrenciasFortes += 1;
    // Campos chegam incompletos conforme o leiaute: a ECF não traz UF nem IE.
    // Preservar o que já se sabe em vez de sobrescrever com vazio.
    atual.razaoSocial = atual.razaoSocial ?? id.razaoSocial;
    atual.uf = atual.uf ?? id.uf;
    atual.inscricaoEstadual = atual.inscricaoEstadual ?? id.inscricaoEstadual;
    atual.codigoMunicipio = atual.codigoMunicipio ?? id.codigoMunicipio;
    this.fortes.set(cnpj, atual);
  }

  /** CNPJ visto numa nota, em qualquer papel — evidência fraca, conta frequência. */
  registrarParticipanteNota(cnpj?: string, nome?: string, uf?: string) {
    const limpo = normalizarCnpj(cnpj);
    if (!limpo) return;
    const atual = this.notas.get(limpo) ?? {
      cnpj: limpo,
      razaoSocial: nome,
      uf,
      ocorrenciasFortes: 0,
      ocorrenciasNotas: 0,
    };
    atual.ocorrenciasNotas += 1;
    atual.razaoSocial = atual.razaoSocial ?? nome;
    atual.uf = atual.uf ?? uf;
    this.notas.set(limpo, atual);
  }

  registrarCompetencia(data?: Date | string | null) {
    const c = paraCompetencia(data);
    if (c) this.competencias.add(c);
  }

  registrarRegime(r: RegimeDetectado) {
    // Evidência de escrituração (ECF) vence a de declaração (PGDAS) no mesmo ano
    // apenas se ainda não houver nada; conflito real vira alerta na tela.
    if (!this.regimes.has(r.exercicio)) this.regimes.set(r.exercicio, r);
  }

  concluir(): ResultadoIdentificacao {
    const competencias = [...this.competencias].sort();
    const base = {
      competenciaIni: competencias[0],
      competenciaFim: competencias[competencias.length - 1],
      regimes: [...this.regimes.values()].sort((a, b) => a.exercicio - b.exercicio),
    };

    const fortes = [...this.fortes.values()].sort(
      (a, b) => b.ocorrenciasFortes - a.ocorrenciasFortes,
    );

    if (fortes.length > 0) {
      const vencedor = fortes[0];
      // Duas escriturações de CNPJs diferentes no mesmo lote: provável mistura de
      // matriz e filial, ou de empresas do grupo. Não decidir sozinho.
      const conflito = fortes.length > 1;
      return {
        ...base,
        empresa: enriquecer(vencedor, this.notas.get(vencedor.cnpj)),
        confianca: conflito ? "MEDIA" : "ALTA",
        motivo: conflito
          ? `Há escrituração de ${fortes.length} CNPJs diferentes no lote. ` +
            `Assumido o mais frequente (${fortes[0].ocorrenciasFortes} arquivos).`
          : "Identificada pelo CNPJ declarado nos próprios arquivos.",
        outrosCandidatos: fortes.slice(1),
      };
    }

    const porNotas = [...this.notas.values()].sort(
      (a, b) => b.ocorrenciasNotas - a.ocorrenciasNotas,
    );

    if (porNotas.length === 0) {
      return {
        ...base,
        confianca: "BAIXA",
        motivo: "Nenhum arquivo permitiu identificar a empresa.",
        outrosCandidatos: [],
      };
    }

    const lider = porNotas[0];
    const totalNotas = porNotas.reduce((s, c) => s + c.ocorrenciasNotas, 0);
    // A empresa aparece em TODAS as notas; cada terceiro, em poucas. Num lote
    // só de saídas com muitos clientes distintos, a fatia do líder passa de
    // largo dos 40%. Abaixo disso a dedução não se sustenta.
    const fatia = lider.ocorrenciasNotas / Math.max(totalNotas, 1);

    return {
      ...base,
      empresa: lider,
      confianca: fatia >= 0.4 ? "MEDIA" : "BAIXA",
      motivo:
        `Deduzida pelos XMLs: aparece em ${lider.ocorrenciasNotas} de ` +
        `${totalNotas} participações (${(fatia * 100).toFixed(0)}%). ` +
        `Confirme antes de criar a empresa.`,
      outrosCandidatos: porNotas.slice(1, 6),
    };
  }
}

function enriquecer(a: Candidato, b?: Candidato): IdentidadeEmpresa {
  return {
    cnpj: a.cnpj,
    razaoSocial: a.razaoSocial ?? b?.razaoSocial,
    uf: a.uf ?? b?.uf,
    inscricaoEstadual: a.inscricaoEstadual,
    codigoMunicipio: a.codigoMunicipio,
    inscricaoMunicipal: a.inscricaoMunicipal,
  };
}

export function normalizarCnpj(v?: string | null): string | undefined {
  if (!v) return undefined;
  const d = v.replace(/\D/g, "");
  return d.length === 14 ? d : undefined;
}

/**
 * Data (Date, "AAAA-MM-DD" ou "DDMMAAAA" do SPED) → "AAAA-MM".
 *
 * A leitura é em UTC, e isso NÃO é detalhe. Os parsers constroem as datas com
 * `Date.UTC`, enquanto `getFullYear()`/`getMonth()` devolvem o horário local —
 * em UTC-3, o dia 1º de janeiro à meia-noite UTC é 31 de dezembro às 21h local.
 * Lido assim, todo período que começa no dia 1º (isto é, toda escrituração
 * mensal) cairia no mês anterior, e a competência é a chave de TODO cruzamento
 * da auditoria: a apuração iria parar no mês errado, silenciosamente.
 */
export function paraCompetencia(v?: Date | string | null): string | undefined {
  if (!v) return undefined;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return undefined;
    return `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const s = String(v).trim();
  if (/^\d{8}$/.test(s)) return `${s.slice(4, 8)}-${s.slice(2, 4)}`;
  const iso = /^(\d{4})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}`;
  return undefined;
}

// =====================================================================
// Leitura do registro 0000 — um leiaute por posição de campo
// =====================================================================

/**
 * Cada leiaute do SPED põe CNPJ, nome e datas em posições diferentes do mesmo
 * registro `|0000|`. Ler pela posição errada devolve IE no lugar de CNPJ, o que
 * passaria silenciosamente. Índices contados a partir de 1 = "0000".
 */
const POSICOES: Record<
  string,
  { cnpj: number; nome: number; uf?: number; ie?: number; mun?: number; dtIni?: number; dtFim?: number }
> = {
  // |0000|COD_VER|COD_FIN|DT_INI|DT_FIN|NOME|CNPJ|CPF|UF|IE|COD_MUN|...
  SPED_FISCAL: { cnpj: 7, nome: 6, uf: 9, ie: 10, mun: 11, dtIni: 4, dtFim: 5 },
  // |0000|COD_VER|TIPO_ESCRIT|IND_SIT_ESP|NUM_REC|DT_INI|DT_FIN|NOME|CNPJ|UF|COD_MUN|...
  SPED_CONTRIBUICOES: { cnpj: 9, nome: 8, uf: 10, mun: 11, dtIni: 6, dtFim: 7 },
  // |0000|LECD|DT_INI|DT_FIN|NOME|CNPJ|UF|IE|COD_MUN|IM|IND_SIT_ESP|...
  // Conferido no Manual de Orientação do Leiaute 9 da ECD (21/12/2023).
  ECD: { cnpj: 6, nome: 5, uf: 7, ie: 8, mun: 9, dtIni: 3, dtFim: 4 },
  // |0000|LECF|COD_VER|CNPJ|NOME|IND_SIT_INI_PER|SIT_ESPECIAL|PAT_REMAN_CIS|DT_SIT_ESP|DT_INI|DT_FIN|...
  //
  // Atenção ao COD_VER no campo 3: ele existe na ECF e NÃO na ECD, o que
  // desloca CNPJ, nome e datas em uma posição entre os dois leiautes. Conferido
  // no Manual de Orientação do Leiaute 12 da ECF (Anexo ao ADE Cofis nº 02/2026,
  // atualização de abril/2026), p. 61-63.
  ECF: { cnpj: 4, nome: 5, dtIni: 10, dtFim: 11 },
};

export interface Registro0000 {
  identidade?: IdentidadeEmpresa;
  competenciaIni?: string;
  competenciaFim?: string;
}

export function lerRegistro0000(
  buffer: Buffer,
  tipo: TipoDocumento,
): Registro0000 {
  const pos = POSICOES[tipo];
  if (!pos) return {};

  const texto = decodeTextBuffer(buffer.subarray(0, 8192)).text;
  const linha = /^\|0000\|.*$/m.exec(texto)?.[0];
  if (!linha) return {};

  // "|0000|a|b|" → ["", "0000", "a", "b", ""]; o índice 1 é o nome do registro.
  const campos = linha.split("|");
  const at = (i: number) => campos[i]?.trim() || undefined;

  const cnpj = normalizarCnpj(at(pos.cnpj));
  if (!cnpj) return {};

  return {
    identidade: {
      cnpj,
      razaoSocial: at(pos.nome),
      uf: pos.uf ? at(pos.uf) : undefined,
      inscricaoEstadual: pos.ie ? at(pos.ie) : undefined,
      codigoMunicipio: pos.mun ? at(pos.mun) : undefined,
    },
    competenciaIni: pos.dtIni ? paraCompetencia(at(pos.dtIni)) : undefined,
    competenciaFim: pos.dtFim ? paraCompetencia(at(pos.dtFim)) : undefined,
  };
}

/**
 * Regime do exercício deduzido da ECF pelos blocos presentes.
 *
 * O bloco P é exclusivo do Lucro Presumido; os blocos L, M e N, do Lucro Real.
 * É mais confiável que o campo de forma de tributação do registro 0010, cujos
 * códigos mudam de versão para versão do leiaute.
 */
export function regimeDaEcf(buffer: Buffer): RegimeTributario | undefined {
  const texto = decodeTextBuffer(buffer).text;

  if (/^\|P(1|2|3|5)\d{2}\|/m.test(texto)) return "LUCRO_PRESUMIDO";
  if (/^\|(L100|L200|L300|M300|M350|N500|N600|N650)\|/m.test(texto)) {
    return "LUCRO_REAL";
  }
  return undefined;
}

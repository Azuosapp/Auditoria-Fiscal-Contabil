import { Prisma } from "@prisma/client";
import { dec } from "@/server/tax/decimal";
import { decodeTextBuffer } from "./encoding";

/**
 * Parser da ECF — Escrituração Contábil Fiscal.
 *
 * Extrai o que a auditoria confronta com as outras declarações: o IRPJ e a
 * CSLL apurados em cada período e a receita bruta declarada. Não tenta ler a
 * ECF inteira — LALUR, balanço e demais blocos continuam no arquivo original,
 * disponíveis para a análise do Claude.
 *
 * Registros usados (conferidos em arquivos reais de Lucro Real trimestral e de
 * Lucro Presumido trimestral):
 *
 *   0000  |0000|LECF|COD_VER|CNPJ|NOME|...|DT_INI|DT_FIN|...
 *   0010  |0010|HASH|OPT_REFIS|FORMA_TRIB|FORMA_APUR|...  — FORMA_TRIB 1 = Real,
 *         5 = Presumido; FORMA_APUR T = trimestral, A = anual
 *   N030/P030/L030  |xxxx|DT_INI|DT_FIN|PER_APUR|  — abre cada período
 *   Lucro Real:  N630 linha 1 base, 3 alíquota 15%, 4 adicional, 26 IRPJ A PAGAR
 *                N670 linha 1 base, 4 total, 21 CSLL A PAGAR
 *                L300 linha 3.01.01.01.01 RECEITA BRUTA
 *   Presumido:   P300 linha 1 base, 3 alíquota 15%, 4 adicional, 15 IRPJ A PAGAR
 *                P500 linha 1 base, 4 total, 13 CSLL A PAGAR
 *                P150 linha 3.01.01.01.01 RECEITA BRUTA
 *
 * O código da linha é o identificador estável do leiaute; a descrição muda de
 * versão para versão e vem com acentuação quebrada conforme a codificação.
 */

export interface ApuracaoEcfExtraida {
  /** "2025-03" — mês de encerramento do período. */
  periodo: string;
  /** "T01", "A00"... como vem no arquivo. */
  periodoApuracao: string;
  tributo: "IRPJ" | "CSLL";
  receitaBruta?: Prisma.Decimal;
  baseCalculo: Prisma.Decimal;
  valorApurado: Prisma.Decimal;
  adicional?: Prisma.Decimal;
  aPagar: Prisma.Decimal;
  registroOrigem: string;
}

export interface LinhaEcfExtraida {
  periodo: string;
  dataFim: Date;
  registro: string;
  codigo: string;
  descricao: string;
  valor?: Prisma.Decimal;
  indicador?: string;
  valorInicial?: Prisma.Decimal;
  indicadorInicial?: string;
  debitos?: Prisma.Decimal;
  creditos?: Prisma.Decimal;
}

export interface SocioEcfExtraido {
  dataEntrada?: Date;
  dataSaida?: Date;
  tipoPessoa?: string;
  documentoSocio: string;
  nome: string;
  qualificacao?: string;
  percentualCapital?: Prisma.Decimal;
  percentualVotante?: Prisma.Decimal;
  remuneracaoTrabalho?: Prisma.Decimal;
  lucrosDividendos?: Prisma.Decimal;
  jurosCapital?: Prisma.Decimal;
  demaisRendimentos?: Prisma.Decimal;
  irRetido?: Prisma.Decimal;
}

export interface EcfExtraida {
  cnpj?: string;
  exercicio?: number;
  /** "LUCRO_REAL" | "LUCRO_PRESUMIDO" | outro código do 0010 */
  formaTributacao?: string;
  formaApuracao?: string;
  apuracoes: ApuracaoEcfExtraida[];
  linhas: LinhaEcfExtraida[];
  socios: SocioEcfExtraido[];
  avisos: string[];
}

const ZERO = new Prisma.Decimal(0);

function data(v: string | undefined): Date | undefined {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(v ?? "");
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) : undefined;
}

function competencia(d: Date | undefined): string | undefined {
  return d
    ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`
    : undefined;
}

const FORMA_TRIB: Record<string, string> = {
  "1": "LUCRO_REAL",
  "2": "LUCRO_REAL_ARBITRADO",
  "3": "LUCRO_PRESUMIDO_REAL",
  "4": "LUCRO_PRESUMIDO_REAL_ARBITRADO",
  "5": "LUCRO_PRESUMIDO",
  "6": "LUCRO_ARBITRADO",
  "7": "LUCRO_PRESUMIDO_ARBITRADO",
  "8": "IMUNE_IRPJ",
  "9": "ISENTA_IRPJ",
};

export function ehEcf(texto: string): boolean {
  return /^\|0000\|LECF\|/m.test(texto);
}

export function parseEcf(buffer: Buffer): EcfExtraida | null {
  const { text } = decodeTextBuffer(buffer);
  if (!ehEcf(text)) return null;

  const avisos: string[] = [];
  const resultado: EcfExtraida = { apuracoes: [], linhas: [], socios: [], avisos };
  // Período do bloco em curso (L030, M030, N030, P030) para as linhas genéricas.
  let blocoPeriodo: { per: string; fim: Date } | undefined;
  const naoVazio = (v: Prisma.Decimal | undefined) => (v && !v.isZero() ? v : undefined);

  // Valores do período corrente, por bloco. Fecham quando o próximo período abre.
  interface Periodo {
    fim?: Date;
    per: string;
    irpj: Record<string, Prisma.Decimal | undefined>;
    csll: Record<string, Prisma.Decimal | undefined>;
    registroIrpj?: string;
    registroCsll?: string;
  }
  const periodos = new Map<string, Periodo>();
  const receitas = new Map<string, Prisma.Decimal>();

  let atual: Periodo | undefined;
  let chaveReceita: string | undefined;

  const abrir = (f: string[]) => {
    const fim = data(f[3]);
    const chave = `${f[4]}|${f[3]}`;
    const existente = periodos.get(chave);
    atual = existente ?? { fim, per: f[4] ?? "", irpj: {}, csll: {} };
    periodos.set(chave, atual);
    return chave;
  };

  for (const linha of text.split(/\r?\n/)) {
    if (!linha.startsWith("|")) continue;
    const f = linha.split("|");
    const reg = f[1];

    // Abertura de período em qualquer bloco que as linhas genéricas usam.
    if (reg === "L030" || reg === "M030" || reg === "N030" || reg === "P030") {
      const fim = data(f[3]);
      blocoPeriodo = fim ? { per: f[4] ?? "", fim } : undefined;
    }
    if (blocoPeriodo) {
      const base = { periodo: blocoPeriodo.per, dataFim: blocoPeriodo.fim, registro: reg, codigo: f[2] ?? "", descricao: (f[3] ?? "").trim() };
      if (reg === "L100" || reg === "P100") {
        const valor = dec(f[12]);
        const valorInicial = dec(f[8]);
        if (naoVazio(valor) || naoVazio(valorInicial)) {
          resultado.linhas.push({
            ...base,
            valor,
            indicador: f[13] || undefined,
            valorInicial,
            indicadorInicial: f[9] || undefined,
            debitos: dec(f[10]),
            creditos: dec(f[11]),
          });
        }
      } else if (reg === "L300" || reg === "P150") {
        const valor = dec(f[8]);
        if (naoVazio(valor)) resultado.linhas.push({ ...base, valor, indicador: f[9] || undefined });
      } else if (reg === "M300" || reg === "M350") {
        const valor = dec(f[6]);
        if (naoVazio(valor)) resultado.linhas.push({ ...base, valor });
      } else if (["N500", "N630", "N650", "N670", "P300", "P500"].includes(reg)) {
        const valor = dec(f[4]);
        if (naoVazio(valor)) resultado.linhas.push({ ...base, valor });
      }
    }

    switch (reg) {
      case "Y600": {
        const documentoSocio = (f[6] ?? "").replace(/\D/g, "");
        if (!documentoSocio) break;
        resultado.socios.push({
          dataEntrada: data(f[2]),
          dataSaida: data(f[3]),
          tipoPessoa: f[5] || undefined,
          documentoSocio,
          nome: (f[7] ?? "").trim(),
          qualificacao: f[8] || undefined,
          percentualCapital: dec(f[9]),
          percentualVotante: dec(f[10]),
          remuneracaoTrabalho: dec(f[13]),
          lucrosDividendos: dec(f[14]),
          jurosCapital: dec(f[15]),
          demaisRendimentos: dec(f[16]),
          irRetido: dec(f[17]),
        });
        break;
      }
      case "0000": {
        resultado.cnpj = f[4]?.replace(/\D/g, "") || undefined;
        resultado.exercicio = data(f[10])?.getUTCFullYear();
        break;
      }
      case "0010": {
        resultado.formaTributacao = FORMA_TRIB[f[4]] ?? f[4];
        resultado.formaApuracao = f[5];
        break;
      }
      case "N030":
      case "P030":
        abrir(f);
        break;
      case "L030":
        chaveReceita = `${f[4]}|${f[3]}`;
        break;
      case "N630":
        if (atual) {
          atual.irpj[f[2]] = dec(f[4]);
          atual.registroIrpj = "N630";
        }
        break;
      case "N670":
        if (atual) {
          atual.csll[f[2]] = dec(f[4]);
          atual.registroCsll = "N670";
        }
        break;
      case "P300":
        if (atual) {
          atual.irpj[f[2]] = dec(f[4]);
          atual.registroIrpj = "P300";
        }
        break;
      case "P500":
        if (atual) {
          atual.csll[f[2]] = dec(f[4]);
          atual.registroCsll = "P500";
        }
        break;
      case "L300":
      case "P150": {
        // No Presumido o P150 vem dentro do P030; no Real o L300 dentro do L030.
        const chave = reg === "P150" ? [...periodos.keys()].pop() : chaveReceita;
        if (chave && f[2] === "3.01.01.01.01") {
          const v = dec(f[8]);
          if (v) receitas.set(chave, v);
        }
        break;
      }
    }
  }

  for (const [chave, p] of periodos) {
    const periodo = competencia(p.fim);
    if (!periodo) {
      avisos.push(`Período ${p.per} sem data final legível — ignorado.`);
      continue;
    }
    const receitaBruta = receitas.get(chave);

    if (p.registroIrpj) {
      const real = p.registroIrpj === "N630";
      const aPagar = p.irpj[real ? "26" : "15"];
      if (aPagar === undefined) {
        avisos.push(`${p.registroIrpj} do período ${p.per} sem a linha de IRPJ a pagar.`);
      } else {
        resultado.apuracoes.push({
          periodo,
          periodoApuracao: p.per,
          tributo: "IRPJ",
          receitaBruta,
          baseCalculo: p.irpj["1"] ?? ZERO,
          valorApurado: (p.irpj["3"] ?? ZERO).plus(p.irpj["4"] ?? ZERO),
          adicional: p.irpj["4"],
          aPagar,
          registroOrigem: p.registroIrpj,
        });
      }
    }

    if (p.registroCsll) {
      const real = p.registroCsll === "N670";
      const aPagar = p.csll[real ? "21" : "13"];
      if (aPagar === undefined) {
        avisos.push(`${p.registroCsll} do período ${p.per} sem a linha de CSLL a pagar.`);
      } else {
        resultado.apuracoes.push({
          periodo,
          periodoApuracao: p.per,
          tributo: "CSLL",
          receitaBruta,
          baseCalculo: p.csll["1"] ?? ZERO,
          valorApurado: p.csll["4"] ?? ZERO,
          aPagar,
          registroOrigem: p.registroCsll,
        });
      }
    }
  }

  if (resultado.apuracoes.length === 0) {
    avisos.push("Nenhuma apuração de IRPJ ou CSLL encontrada na ECF.");
  }

  return resultado;
}

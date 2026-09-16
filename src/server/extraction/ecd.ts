import { Prisma } from "@prisma/client";
import { dec } from "@/server/tax/decimal";
import { decodeTextBuffer } from "./encoding";

/**
 * Parser da ECD — Escrituração Contábil Digital (SPED Contábil).
 *
 * Extrai o que as regras contábeis confrontam: saldos mensais por conta (caixa
 * negativo, balancete que não fecha), os lançamentos (contabilidade feita por
 * lançamento global) e a DRE (receita bruta, confrontada com a ECF).
 *
 * Registros (leiaute 9, conferido em arquivo real; I051 e J150 também aceitam
 * os leiautes anteriores, que têm um campo a mais ou a menos):
 *
 *   0000  |0000|LECD|DT_INI|DT_FIN|NOME|CNPJ|UF|...
 *   I050  |I050|DT_ALT|COD_NAT|IND_CTA|NIVEL|COD_CTA|COD_CTA_SUP|CTA|
 *   I051  |I051|COD_CCUS|COD_CTA_REF|        (antes do leiaute 8: COD_ENT_REF antes)
 *   I150  |I150|DT_INI|DT_FIN|
 *   I155  |I155|COD_CTA|COD_CCUS|VL_SLD_INI|IND_DC_INI|VL_DEB|VL_CRED|VL_SLD_FIN|IND_DC_FIN|
 *   I200  |I200|NUM_LCTO|DT_LCTO|VL_LCTO|IND_LCTO|DT_LCTO_EXT|
 *   I250  |I250|COD_CTA|COD_CCUS|VL_DC|IND_DC|NUM_ARQ|COD_HIST_PAD|HIST|COD_PART|
 *   J005  |J005|DT_INI|DT_FIN|ID_DEM|CAB_DEM|
 *   J150  |J150|NU_ORDEM|COD_AGL|IND_COD_AGL|NIVEL_AGL|COD_AGL_SUP|DESCR|VL_INI|IND_INI|VL_FIN|IND_FIN|IND_GRP_DRE|NOTA|
 *
 * A classificação de caixa e banco vem do plano referencial da Receita (I051),
 * não do nome: "CAIXA ECONOMICA FEDERAL C/C" é banco, e pelo nome viraria um
 * falso caixa negativo. Sem I051, cai para o nome, com a exceção explícita.
 */

export interface SaldoContaExtraido {
  competencia: string;
  contaCodigo: string;
  contaNome?: string;
  classificacao?: string;
  saldoInicial: Prisma.Decimal;
  debitos: Prisma.Decimal;
  creditos: Prisma.Decimal;
  saldoFinal: Prisma.Decimal;
  naturezaSaldo: "D" | "C";
  linhaOrigem: number;
}

export interface LancamentoExtraido {
  data: Date;
  competencia: string;
  numeroLancamento: string;
  /** N normal, E encerramento, X extemporâneo */
  tipoLancamento?: string;
  contaCodigo: string;
  contaNome?: string;
  natureza: "D" | "C";
  valor: Prisma.Decimal;
  historico?: string;
  linhaOrigem: number;
}

export interface LinhaDreExtraida {
  dataInicio: Date;
  dataFim: Date;
  ordem: number;
  codigoAglutinacao: string;
  descricao: string;
  nivel?: number;
  tipo?: string;
  valor: Prisma.Decimal;
  natureza?: string;
}

export interface EcdExtraida {
  cnpj?: string;
  dataInicio?: Date;
  dataFim?: Date;
  saldos: SaldoContaExtraido[];
  lancamentos: LancamentoExtraido[];
  dre: LinhaDreExtraida[];
  avisos: string[];
}

const ZERO = new Prisma.Decimal(0);

function data(v: string | undefined): Date | undefined {
  const m = /^(\d{2})(\d{2})(\d{4})$/.exec(v ?? "");
  return m ? new Date(Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]))) : undefined;
}

function competencia(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Caixa e banco pelo plano referencial; sem ele, pelo nome. */
export function classificarConta(referencial?: string, nome?: string): string | undefined {
  if (referencial) {
    if (referencial.startsWith("1.01.01.01")) return "CAIXA";
    if (referencial.startsWith("1.01.01.02")) return "BANCO";
    return undefined;
  }
  const n = (nome ?? "").toUpperCase();
  if (/CAIXA\s+ECON/.test(n)) return "BANCO";
  if (/^CAIXA\b/.test(n)) return "CAIXA";
  if (/^BANCO|C\/C|CONTA MOVIMENTO/.test(n)) return "BANCO";
  return undefined;
}

export function ehEcd(texto: string): boolean {
  return /^\|0000\|LECD\|/m.test(texto);
}

export function parseEcd(buffer: Buffer): EcdExtraida | null {
  const { text } = decodeTextBuffer(buffer);
  if (!ehEcd(text)) return null;

  const r: EcdExtraida = { saldos: [], lancamentos: [], dre: [], avisos: [] };

  const nomes = new Map<string, string>();
  const referencial = new Map<string, string>();
  let ultimaConta: string | undefined;

  let fimPeriodoSaldo: Date | undefined;
  let lancamento: { numero: string; data: Date; tipo?: string } | undefined;
  let periodoDre: { inicio: Date; fim: Date } | undefined;

  const pendentesSaldos: Array<Omit<SaldoContaExtraido, "contaNome" | "classificacao">> = [];

  const linhas = text.split(/\r?\n/);
  for (let i = 0; i < linhas.length; i++) {
    const linha = linhas[i];
    if (!linha.startsWith("|")) continue;
    const f = linha.split("|");

    switch (f[1]) {
      case "0000":
        r.dataInicio = data(f[3]);
        r.dataFim = data(f[4]);
        r.cnpj = f[6]?.replace(/\D/g, "") || undefined;
        break;

      case "I050":
        ultimaConta = f[6];
        if (f[6]) nomes.set(f[6], f[8] ?? "");
        break;

      case "I051": {
        // O código referencial é sempre o último campo preenchido.
        const campos = f.slice(2, -1).filter((c) => c !== "");
        const ref = campos[campos.length - 1];
        if (ultimaConta && ref && !referencial.has(ultimaConta)) referencial.set(ultimaConta, ref);
        break;
      }

      case "I150":
        fimPeriodoSaldo = data(f[3]);
        break;

      case "I155": {
        if (!fimPeriodoSaldo) break;
        const fin = dec(f[8]) ?? ZERO;
        pendentesSaldos.push({
          competencia: competencia(fimPeriodoSaldo),
          contaCodigo: f[2],
          saldoInicial: dec(f[4]) ?? ZERO,
          debitos: dec(f[6]) ?? ZERO,
          creditos: dec(f[7]) ?? ZERO,
          saldoFinal: fin,
          naturezaSaldo: f[9] === "C" ? "C" : "D",
          linhaOrigem: i + 1,
        });
        break;
      }

      case "I200": {
        const d = data(f[3]);
        lancamento = d ? { numero: f[2], data: d, tipo: f[5] || undefined } : undefined;
        if (!d) r.avisos.push(`Linha ${i + 1}: lançamento ${f[2]} sem data legível — partidas ignoradas.`);
        break;
      }

      case "I250": {
        if (!lancamento) break;
        const valor = dec(f[4]);
        if (!valor) break;
        r.lancamentos.push({
          data: lancamento.data,
          competencia: competencia(lancamento.data),
          numeroLancamento: lancamento.numero,
          tipoLancamento: lancamento.tipo,
          contaCodigo: f[2],
          natureza: f[5] === "C" ? "C" : "D",
          valor,
          historico: f[8] || undefined,
          linhaOrigem: i + 1,
        });
        break;
      }

      case "J005": {
        const inicio = data(f[2]);
        const fim = data(f[3]);
        periodoDre = inicio && fim ? { inicio, fim } : undefined;
        break;
      }

      case "J150": {
        if (!periodoDre) break;
        // Leiaute 9 tem VL_CTA_FIN no campo 10; os antigos, VL_CTA no campo 5.
        const novo = f.length >= 13;
        const valor = dec(novo ? f[10] : f[5]);
        if (valor === undefined) break;
        r.dre.push({
          dataInicio: periodoDre.inicio,
          dataFim: periodoDre.fim,
          ordem: Number(novo ? f[2] : r.dre.length + 1),
          codigoAglutinacao: novo ? f[3] : f[2],
          descricao: novo ? f[7] : f[4],
          nivel: Number(novo ? f[5] : f[3]) || undefined,
          tipo: novo ? f[4] || undefined : undefined,
          valor,
          natureza: (novo ? f[11] : f[6]) || undefined,
        });
        break;
      }
    }
  }

  for (const s of pendentesSaldos) {
    const nome = nomes.get(s.contaCodigo);
    r.saldos.push({
      ...s,
      contaNome: nome,
      classificacao: classificarConta(referencial.get(s.contaCodigo), nome),
    });
  }
  for (const l of r.lancamentos) l.contaNome = nomes.get(l.contaCodigo);

  if (r.saldos.length === 0) r.avisos.push("ECD sem saldos periódicos (I155).");
  return r;
}

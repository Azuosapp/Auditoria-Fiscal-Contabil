import { Prisma } from "@prisma/client";
import { type Money, ZERO } from "@/server/tax/decimal";

/**
 * Leitor do Extrato do Simples Nacional (PGDAS-D).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE PARSER EXISTE
 *
 * O RBT12 não pode ser deduzido das notas quando a empresa tem histórico
 * anterior ao que foi importado. Nesse caso o valor apurado sai pequeno, a faixa
 * cai e a alíquota efetiva fica menor que a devida — sem erro nenhum na fórmula.
 * O extrato traz o RBT12 correto de cada competência, e é dele que ele deve vir.
 *
 * COMO O TEXTO É LIDO
 *
 * O PDF é convertido por `pdftotext -enc UTF-8 -layout`. O `-layout` preserva a
 * posição horizontal, o que permite casar rótulo e valor na mesma linha. Ainda
 * assim o PGDAS-D quebra algumas linhas de forma imprevisível — por isso cada
 * campo tem uma âncora própria, e o total do DAS é CONFERIDO pela soma dos
 * tributos antes de ser aceito.
 * ─────────────────────────────────────────────────────────────────────────────
 */

const D = (v: string) => new Prisma.Decimal(v);

export class ExtratoPgdasError extends Error {}

export interface TributosExtrato {
  irpj: Money;
  csll: Money;
  cofins: Money;
  pis: Money;
  cpp: Money;
  icms: Money;
  ipi: Money;
  iss: Money;
}

export interface ExtratoPgdas {
  /** "AAAA-MM". */
  competencia: string;
  cnpj?: string;
  razaoSocial?: string;
  /** Receita bruta do período de apuração. */
  receitaPa: Money;
  /** Receita bruta dos 12 meses anteriores — o que define a faixa. */
  rbt12: Money;
  /**
   * O extrato menciona RBT12 proporcionalizado (início de atividade)? O VALOR
   * não é extraído — ver a explicação no corpo do parser.
   */
  mencionaProporcionalizacao?: boolean;
  /** Receita acumulada no ano-calendário corrente. */
  rba?: Money;
  /** Total do débito exigível — o DAS da competência. */
  dasTotal?: Money;
  tributos?: TributosExtrato;
  /** "Impedido de recolher ICMS/ISS no DAS" — o sublimite, dito pelo próprio Fisco. */
  impedidoIcmsIssNoDas?: boolean;
  fatorR?: Money;
  /** Data em que a apuração foi transmitida. */
  apuradoEm?: string;
  avisos: string[];
}

/** Converte "138.733,04" em Decimal. */
function valorBr(texto: string): Money {
  return D(texto.replace(/\./g, "").replace(",", "."));
}

const NUMERO_BR = /\d{1,3}(?:\.\d{3})*,\d{2}/g;

/** Todos os valores monetários de um trecho, na ordem em que aparecem. */
function numerosDe(trecho: string): Money[] {
  return (trecho.match(NUMERO_BR) ?? []).map(valorBr);
}

/** Primeira linha que casa com a âncora, e o primeiro valor dela. */
function valorNaLinha(linhas: string[], ancora: RegExp): Money | undefined {
  for (const linha of linhas) {
    if (ancora.test(linha)) {
      const n = numerosDe(linha);
      if (n.length > 0) return n[0];
    }
  }
  return undefined;
}

/**
 * Total do DAS a partir da seção "Total do Débito Exigível".
 *
 * O PGDAS-D embaralha as colunas quando quebra a linha, então não dá para casar
 * cada tributo pela posição. O que se sabe com certeza é que UM dos valores é a
 * soma dos demais. O candidato é o maior — e a função só o aceita se a soma dos
 * outros bater com ele. Não batendo, devolve `undefined`: melhor não ter o
 * número do que ter um número errado servindo de referência para acusar
 * divergência de declaração.
 */
function totalDoDebito(trecho: string): { total?: Money; avisos: string[] } {
  const avisos: string[] = [];
  const numeros = numerosDe(trecho).filter((n) => n.greaterThan(0));
  if (numeros.length === 0) return { avisos };

  const maior = numeros.reduce((a, b) => (b.greaterThan(a) ? b : a));
  const demais = numeros.filter((n) => !n.equals(maior));
  const soma = demais.reduce((a, b) => a.add(b), ZERO);

  // Tolerância de um centavo por parcela, para o arredondamento do próprio extrato.
  const tolerancia = D(String(demais.length)).mul("0.01");
  if (soma.sub(maior).abs().lessThanOrEqualTo(tolerancia)) {
    return { total: maior, avisos };
  }

  avisos.push(
    `Não consegui confirmar o total do DAS no extrato: o maior valor da seção ` +
      `(${maior.toFixed(2)}) não bate com a soma dos demais (${soma.toFixed(2)}). ` +
      "O valor NÃO foi extraído — confira no PDF e informe à mão.",
  );
  return { avisos };
}

/**
 * Interpreta o texto de um extrato do PGDAS-D já convertido para texto.
 *
 * Devolve `null` quando o texto não é um extrato — o mesmo pacote costuma trazer
 * cartão de CNPJ e outros PDFs, e confundi-los produziria competência inventada.
 */
export function parseExtratoPgdas(texto: string): ExtratoPgdas | null {
  if (!/Extrato do Simples Nacional/i.test(texto)) return null;

  const linhas = texto.split(/\r?\n/);
  const avisos: string[] = [];

  const mPa = texto.match(/Per[ií]odo de Apura[çc][ãa]o \(PA\):\s*(\d{2})\/(\d{4})/i);
  if (!mPa) {
    throw new ExtratoPgdasError(
      "É um extrato do Simples, mas não encontrei o Período de Apuração. " +
        "O leiaute pode ter mudado — confira o PDF.",
    );
  }
  const competencia = `${mPa[2]}-${mPa[1]}`;

  const receitaPa = valorNaLinha(linhas, /Total de Receitas Brutas/i);
  if (receitaPa === undefined) {
    throw new ExtratoPgdasError(
      `Extrato de ${competencia}: não encontrei o total de receitas brutas.`,
    );
  }

  // A PRIMEIRA ocorrência da âncora é o RBT12; a linha seguinte, quando traz
  // "proporcionalizada", é o RBT12p. Conferido nos seis extratos da CJ Roupas.
  const iRbt12 = linhas.findIndex((l) => /doze meses anteriores ao PA/i.test(l));
  const rbt12 = iRbt12 >= 0 ? numerosDe(linhas[iRbt12])[0] : undefined;
  if (rbt12 === undefined) {
    throw new ExtratoPgdasError(
      `Extrato de ${competencia}: não encontrei o RBT12 — que é justamente o dado ` +
        "que o extrato existe para fornecer.",
    );
  }

  // RBT12 PROPORCIONALIZADO (início de atividade, art. 18, § 2º).
  //
  // Deliberadamente NÃO extraído. O PGDAS-D quebra essas linhas de forma
  // instável: nos extratos conferidos, o valor que aparece ao lado do rótulo
  // "proporcionalizada (RBT12p)" ora era a receita do período, ora o RBAA. Um
  // RBT12 errado é pior que um RBT12 ausente — ele muda a faixa em silêncio.
  // Quando o extrato menciona proporcionalização, o parser avisa e pede
  // conferência humana.
  // A menção é registrada na FLAG, não num aviso por extrato: o PGDAS-D imprime
  // essa linha em toda apuração de empresa em início de atividade, e um aviso
  // por competência enchia a tela com seis mensagens idênticas. Quem consolida
  // os extratos emite uma só (ver `lerExtratosDoProjeto`).
  const mencionaProporcional = /RBT12p|proporcionaliz/i.test(texto);

  const rba = valorNaLinha(linhas, /ano-calend[áa]rio corrente/i);

  const mCnpj = texto.match(/CNPJ\s+(?:B[áa]sico|Estabelecimento):\s*([\d./-]+)/i);
  const mNome = texto.match(/Nome Empresarial:\s*(.+?)(?:\s{2,}|$)/im);
  const mApurado = texto.match(/Apurado em\s+([\d/]+\s[\d:]+)/i);

  const impedido = /Impedido de recolher ICMS\/ISS no DAS:\s*Sim/i.test(texto)
    ? true
    : /Impedido de recolher ICMS\/ISS no DAS:\s*N[ãa]o/i.test(texto)
      ? false
      : undefined;

  const mFatorR = texto.match(/Fator r\s*=\s*([\d.,]+)/i);
  const fatorR = mFatorR ? valorBr(mFatorR[1].includes(",") ? mFatorR[1] : `${mFatorR[1]},00`) : undefined;

  // Seção 4 — Total Geral da Empresa, bloco do débito exigível.
  const iTotalGeral = texto.search(/4\)\s*Total Geral da Empresa/i);
  let dasTotal: Money | undefined;
  if (iTotalGeral >= 0) {
    const depois = texto.slice(iTotalGeral);
    const iExigivel = depois.search(/Total do D[ée]bito Exig[íi]vel/i);
    let trecho = "";
    if (iExigivel >= 0) {
      // Corta na PRÓXIMA seção numerada, não num número fixo de caracteres.
      // Com corte fixo o trecho invadia a seção seguinte, que repete os mesmos
      // tributos — os valores vinham em dobro e a conferência pela soma falhava.
      const resto = depois.slice(iExigivel);
      const mProximaSecao = resto.slice(30).match(/\n\s*\d\)\s/);
      trecho = mProximaSecao?.index
        ? resto.slice(0, 30 + mProximaSecao.index)
        : resto.slice(0, 900);
    }
    const r = totalDoDebito(trecho);
    dasTotal = r.total;
    avisos.push(...r.avisos);
  } else {
    avisos.push(
      `Extrato de ${competencia}: seção "Total Geral da Empresa" não localizada; ` +
        "o DAS declarado não foi extraído.",
    );
  }

  return {
    competencia,
    cnpj: mCnpj?.[1]?.replace(/\D/g, ""),
    razaoSocial: mNome?.[1]?.trim(),
    receitaPa,
    rbt12,
    mencionaProporcionalizacao: mencionaProporcional,
    rba,
    dasTotal,
    impedidoIcmsIssNoDas: impedido,
    fatorR,
    apuradoEm: mApurado?.[1],
    avisos,
  };
}

/** O arquivo parece ser um extrato do PGDAS-D? Decide pelo conteúdo, não pelo nome. */
export function ehExtratoPgdas(texto: string): boolean {
  return (
    /Extrato do Simples Nacional/i.test(texto) &&
    /Per[ií]odo de Apura[çc][ãa]o/i.test(texto)
  );
}

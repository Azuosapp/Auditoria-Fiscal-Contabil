import ExcelJS from "exceljs";
import { dec, sum, type Money } from "@/server/tax/decimal";
import { decodeTextBuffer, type DetectedEncoding } from "./encoding";
import type { ExtractionResult } from "./types";

/**
 * Leitor de planilha (DRE, balancete, relatório de despesas, folha de pagamento)
 * em Excel (.xlsx) ou CSV.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ESTE MÓDULO NÃO "ADIVINHA"
 *
 * Não existe layout padrão de DRE — cada escritório contábil manda a planilha
 * de um jeito. Em vez de tentar mapear célula-a-célula um layout fixo, este
 * módulo:
 *
 *   1. Converte XLSX e CSV para uma grade comum (`string[][]`, 1 linha = 1
 *      linha da planilha) — assim toda a lógica de detecção de cabeçalho,
 *      classificação de coluna e de linha é uma só, testada uma vez só.
 *   2. Procura a linha de cabeçalho por palavra-chave (não assume que é a
 *      linha 1 — pode estar na linha 5, na 7, em qualquer lugar dentro da
 *      janela de busca).
 *   3. Classifica cada LINHA (descrição de conta) contra um dicionário de
 *      sinônimos em português — `DICIONARIO_CONTAS`, exportado e editável.
 *   4. Linha que não bate com nada do dicionário é devolvida como está, no
 *      texto original, na lista `pendencias` — nunca é descartada, nunca é
 *      chutada numa conta por aproximação.
 *   5. Sinal (positivo/negativo) nunca é invertido por conta própria: se a
 *      mesma conta aparece com sinais diferentes em linhas diferentes, isso
 *      vira aviso (`warnings`), não normalização silenciosa.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// =============================================================================
// Conversão de célula em texto — a base de tudo (ver nota sobre precisão abaixo)
// =============================================================================

/**
 * NOTA IMPORTANTE — verificada lendo o código-fonte do exceljs (lib/doc/cell.js),
 * não suposta:
 *
 * O getter `cell.text` do exceljs NÃO aplica o `numFmt` da célula. Para uma
 * célula numérica, `NumberValue.toString()` é literalmente
 * `this.model.value.toString()` — ou seja, é o `Number.prototype.toString()`
 * do JavaScript sobre o float já parseado, exatamente como `String(cell.value)`.
 * O `numFmt` (ex.: "R$ #.##0,00") não entra nessa conversão em nenhuma versão
 * atual do exceljs (4.4.0). Portanto "ler pela string formatada da célula" não
 * pode significar "aplicar a máscara de exibição do Excel" nesta biblioteca —
 * isso exigiria reimplementar o SSF (formatador de número do Excel), fora do
 * escopo desta tarefa.
 *
 * O que ESTE módulo faz, e por que isso ainda protege contra perda de centavo:
 * o algoritmo `Number.prototype.toString()` do ECMA-262 devolve a menor
 * representação decimal que, ao ser reconvertida para float, produz o MESMO
 * float — ou seja, para um valor digitado diretamente na planilha como
 * "1234.56", `Number("1234.56").toString()` volta a ser exatamente "1234.56"
 * (não "1234.5600000000001"). O problema clássico de ponto flutuante
 * (0.1 + 0.2 !== 0.3) é de ARITMÉTICA, não de round-trip parse→toString de um
 * único literal. Por isso a célula sempre passa pela conversão para STRING
 * antes de virar `Money` — nunca `new Prisma.Decimal(cell.value)` direto sobre
 * o número. Quando a célula vem de uma fórmula com cadeia de cálculo anterior
 * (ex.: "=A1-A2" resultando em "33.360000000000003" por erro de ponto
 * flutuante acumulado em OUTRA planilha, já dentro do arquivo .xlsx recebido),
 * esse ruído é do arquivo de origem, não desta leitura — e fica registrado
 * como está, sem arredondamento forçado, porque forçar 2 casas por conta
 * própria seria "corrigir dado do cliente por conta própria" (proibido).
 * Notação científica (ex.: "1.23e+21") é rejeitada explicitamente, com aviso,
 * por não ser um formato monetário plausível.
 */
function cellToText(cell: ExcelJS.Cell): string {
  switch (cell.type) {
    case ExcelJS.ValueType.Null:
    case ExcelJS.ValueType.Merge:
      return "";
    case ExcelJS.ValueType.Date: {
      const v = cell.value;
      return v instanceof Date ? v.toISOString().slice(0, 10) : "";
    }
    case ExcelJS.ValueType.Formula: {
      const result = cell.result;
      if (result instanceof Date) return result.toISOString().slice(0, 10);
      if (typeof result === "number") return String(result);
      if (typeof result === "string") return result;
      return ""; // erro de fórmula (#DIV/0! etc.) ou resultado ausente
    }
    default:
      return (cell.text ?? "").toString().trim();
  }
}

// =============================================================================
// Normalização de texto — usada tanto para cabeçalho quanto para descrição
// =============================================================================

/**
 * Maiúsculas, sem acento, sem pontuação (vira espaço), espaços colapsados.
 * "Pró-labore" e "PRÓ LABORE" e "pro-labore" viram todos "PRO LABORE".
 */
export function normalizarTexto(s: string | undefined | null): string {
  if (!s) return "";
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

// =============================================================================
// Conversão de texto de célula em valor monetário (Money)
// =============================================================================

export interface ResultadoValorMonetario {
  valor?: Money;
  aviso?: string;
}

const RE_CIENTIFICA = /^[+-]?\d+(\.\d+)?[eE][+-]?\d+$/;
const RE_PREFIXO_MOEDA = /^(R\$|US\$|\$)\s*/i;
const RE_SOMENTE_NUMERICO = /^[0-9.,]+$/;

/**
 * Converte o texto de uma célula (já extraído via `cellToText`, ou vindo de
 * um campo de CSV) em `Money`. Trata:
 *  - `R$`/`US$`/`$` como prefixo de moeda (removido);
 *  - parênteses contábeis "(1.234,56)" como negativo;
 *  - sinal de menos no início OU no final ("1.234,56-", comum em export de ERP);
 *  - formato BR "1.234,56" (ponto = milhar, vírgula = decimal);
 *  - formato US "1,234.56" (vírgula = milhar, ponto = decimal);
 *  - separador único ambíguo ("1.234" ou "1,234"): se o único separador é
 *    seguido de exatamente 3 dígitos, é tratado como milhar SEM casas
 *    decimais (convenção contábil BR de valor fechado em reais) — é uma
 *    decisão documentada, não uma certeza; ver aviso quando aplicável.
 *
 * Célula vazia devolve `{}` (ausente, não zero — nunca inventa valor).
 * Texto não numérico devolve `{ aviso }`, nunca lança exceção e nunca é
 * convertido para zero.
 */
export function parseValorMonetario(rawInput: string | undefined): ResultadoValorMonetario {
  if (rawInput === undefined) return {};
  const original = rawInput;
  let raw = rawInput.trim();
  if (raw === "") return {};

  if (RE_CIENTIFICA.test(raw)) {
    return {
      aviso: `Valor "${original}" em notação científica não é suportado como valor monetário — confira a célula de origem.`,
    };
  }

  let negativo = false;

  const parenteses = /^\((.*)\)$/.exec(raw);
  if (parenteses) {
    negativo = true;
    raw = parenteses[1].trim();
  }
  if (raw.endsWith("-")) {
    negativo = true;
    raw = raw.slice(0, -1).trim();
  }
  if (raw.startsWith("-")) {
    negativo = true;
    raw = raw.slice(1).trim();
  } else if (raw.startsWith("+")) {
    raw = raw.slice(1).trim();
  }

  raw = raw.replace(RE_PREFIXO_MOEDA, "").trim();
  raw = raw.replace(/\s+/g, "");
  if (raw === "") return {};

  if (!RE_SOMENTE_NUMERICO.test(raw)) {
    return {
      aviso: `Valor "${original}" tem caractere não numérico além de separador de milhar/decimal — não reconhecido como valor monetário.`,
    };
  }

  const temPonto = raw.includes(".");
  const temVirgula = raw.includes(",");
  let normalizado: string;
  let ambiguidadeAvisada = false;

  if (temPonto && temVirgula) {
    const ultimoPonto = raw.lastIndexOf(".");
    const ultimaVirgula = raw.lastIndexOf(",");
    if (ultimaVirgula > ultimoPonto) {
      // formato BR: "1.234,56" → ponto é milhar, vírgula é decimal
      normalizado = raw.replace(/\./g, "").replace(",", ".");
    } else {
      // formato US: "1,234.56" → vírgula é milhar, ponto é decimal
      normalizado = raw.replace(/,/g, "");
    }
  } else if (temVirgula) {
    const partes = raw.split(",");
    const ultima = partes[partes.length - 1];
    if (partes.length === 2 && ultima.length !== 3) {
      normalizado = partes.join("."); // decimal: "1234,56" ou "1234,5"
    } else {
      normalizado = partes.join(""); // milhar sem decimais: "1,234" ou "1.234.567"-like
      ambiguidadeAvisada = partes.length === 2;
    }
  } else if (temPonto) {
    const partes = raw.split(".");
    const ultima = partes[partes.length - 1];
    if (partes.length === 2 && ultima.length !== 3) {
      normalizado = partes.join("."); // decimal: "1234.56"
    } else {
      normalizado = partes.join(""); // milhar sem decimais: "1.234" ou "1.234.567"
      ambiguidadeAvisada = partes.length === 2;
    }
  } else {
    normalizado = raw;
  }

  const valor = dec(normalizado);
  if (valor === undefined) {
    return { aviso: `Valor "${original}" não pôde ser convertido para número.` };
  }

  const resultado: ResultadoValorMonetario = { valor: negativo ? valor.negated() : valor };
  if (ambiguidadeAvisada) {
    resultado.aviso =
      `Valor "${original}" tem um único separador seguido de 3 dígitos — interpretado como ` +
      `milhar sem casas decimais (ex.: "1.234" = 1234,00). Se era decimal, confira manualmente.`;
  }
  return resultado;
}

// =============================================================================
// Dicionário de contas — DADO exportado e editável, não escondido no código
// =============================================================================

export type ContaCanonica =
  | "RECEITA_BRUTA"
  | "DEVOLUCOES_VENDAS"
  | "IMPOSTOS_SOBRE_VENDAS"
  | "DEDUCOES_RECEITA"
  | "RECEITA_LIQUIDA"
  | "CMV_CPV"
  | "LUCRO_BRUTO"
  | "SALARIO_PROVENTOS"
  | "PRO_LABORE"
  | "INSS_PATRONAL"
  | "FGTS"
  | "DESPESA_PESSOAL"
  | "DESPESA_COMERCIAL"
  | "DESPESA_ADMINISTRATIVA"
  | "DESPESA_OPERACIONAL"
  | "DESPESA_FINANCEIRA"
  | "RECEITA_FINANCEIRA"
  | "DEPRECIACAO_AMORTIZACAO"
  | "OUTRAS_RECEITAS_OPERACIONAIS"
  | "OUTRAS_DESPESAS_OPERACIONAIS"
  | "RESULTADO_OPERACIONAL"
  | "EBITDA"
  | "RESULTADO_ANTES_IR"
  | "PROVISAO_IRPJ_CSLL"
  | "LUCRO_LIQUIDO";

export interface SinonimoConta {
  conta: ContaCanonica;
  /** Rótulo legível em pt-BR, para exibição em relatório/UI. */
  rotulo: string;
  /**
   * Padrões testados contra o texto já normalizado (`normalizarTexto`):
   * maiúsculo, sem acento, pontuação virada espaço. Escreva os padrões já
   * nesse formato (ex.: "PRO LABORE", não "pró-labore").
   */
  padroes: RegExp[];
}

/**
 * Dicionário de sinônimos de conta contábil, em português.
 *
 * EDITÁVEL: é um array de dados comuns, sem lógica escondida. Para corrigir
 * uma classificação errada ou ensinar um sinônimo novo, adicione um padrão
 * (RegExp) na conta certa — ou crie uma conta nova em `ContaCanonica` (union
 * type) e uma entrada aqui. A ORDEM importa: `classificarConta` devolve o
 * PRIMEIRO item cujo padrão bate, então entradas mais específicas devem vir
 * antes de entradas mais genéricas (ex.: "Devoluções de Vendas" antes de
 * "Deduções da Receita", que é o item genérico "pega o resto").
 */
export const DICIONARIO_CONTAS: SinonimoConta[] = [
  {
    conta: "RECEITA_BRUTA",
    rotulo: "Receita Bruta",
    padroes: [/RECEITA BRUTA/, /^RECEITA(S)? DE VENDAS/, /FATURAMENTO BRUTO/, /^VENDAS BRUTAS/],
  },
  {
    conta: "DEVOLUCOES_VENDAS",
    rotulo: "Devoluções de Vendas",
    padroes: [/DEVOLU(CAO|COES)/, /^ABATIMENTOS?( SOBRE VENDAS)?$/],
  },
  {
    conta: "IMPOSTOS_SOBRE_VENDAS",
    rotulo: "Impostos sobre Vendas",
    padroes: [
      /IMPOSTOS? SOBRE (AS )?VENDAS/,
      /IMPOSTOS? SOBRE (A )?RECEITA/,
      /TRIBUTOS? SOBRE (A )?RECEITA/,
      /^ICMS SOBRE VENDAS/,
      /\bPIS COFINS\b/,
      /^PIS( E COFINS)?$/,
      /^COFINS$/,
      /^ISS SOBRE VENDAS/,
    ],
  },
  {
    conta: "DEDUCOES_RECEITA",
    rotulo: "Deduções da Receita Bruta",
    padroes: [/DEDU(CAO|COES)( DA)?( RECEITA)?( BRUTA)?/],
  },
  {
    conta: "RECEITA_LIQUIDA",
    rotulo: "Receita Líquida",
    padroes: [/RECEITA LIQUIDA/],
  },
  {
    conta: "CMV_CPV",
    rotulo: "CMV/CPV/CSP",
    padroes: [
      /^CMV\b/,
      /^CPV\b/,
      /^CSP\b/,
      /CUSTO(S)? DA(S)? MERCADORIA(S)? VENDIDA(S)?/,
      /CUSTO(S)? DO(S)? PRODUTO(S)? VENDIDO(S)?/,
      /CUSTO(S)? DO(S)? SERVICO(S)? PRESTADO(S)?/,
    ],
  },
  {
    conta: "LUCRO_BRUTO",
    rotulo: "Lucro Bruto",
    padroes: [/LUCRO BRUTO/],
  },
  {
    conta: "SALARIO_PROVENTOS",
    rotulo: "Salários/Proventos",
    padroes: [
      /^SALARIOS?$/,
      /^VENCIMENTOS?$/,
      /^ORDENADOS?$/,
      /^REMUNERACAO$/,
      /SALARIO BRUTO/,
      /TOTAL DE PROVENTOS/,
      /^PROVENTOS$/,
      /^13 SALARIO$/,
      /DECIMO TERCEIRO/,
      /^FERIAS$/,
      /HORAS EXTRAS/,
    ],
  },
  {
    conta: "PRO_LABORE",
    rotulo: "Pró-labore",
    padroes: [/PRO ?LABORE/],
  },
  {
    conta: "INSS_PATRONAL",
    rotulo: "INSS Patronal (CPP)",
    padroes: [/INSS PATRONAL/, /\bCPP\b/, /INSS (DA )?EMPRESA/, /ENCARGOS? PATRONA(L|IS)/],
  },
  {
    conta: "FGTS",
    rotulo: "FGTS",
    padroes: [/\bFGTS\b/],
  },
  {
    conta: "DESPESA_PESSOAL",
    rotulo: "Despesas com Pessoal",
    padroes: [/DESPESAS? COM PESSOAL/, /FOLHA DE PAGAMENTO/, /DESPESAS? COM (SALARIOS|FUNCIONARIOS)/],
  },
  {
    conta: "DESPESA_COMERCIAL",
    rotulo: "Despesas Comerciais/Vendas",
    padroes: [/DESPESAS? (COM )?VENDAS?/, /DESPESAS? COMERCIA(L|IS)/],
  },
  {
    conta: "DESPESA_ADMINISTRATIVA",
    rotulo: "Despesas Administrativas",
    padroes: [/DESPESAS? ADMINISTRATIVA(S)?/],
  },
  {
    conta: "DESPESA_FINANCEIRA",
    rotulo: "Despesas Financeiras",
    padroes: [/DESPESAS? FINANCEIRA(S)?/, /JUROS PASSIVOS?/, /\bIOF\b/, /TARIFAS? BANCARIA(S)?/],
  },
  {
    conta: "RECEITA_FINANCEIRA",
    rotulo: "Receitas Financeiras",
    padroes: [/RECEITAS? FINANCEIRA(S)?/, /JUROS ATIVOS?/, /RENDIMENTOS? (DE )?APLICA/],
  },
  {
    conta: "DEPRECIACAO_AMORTIZACAO",
    rotulo: "Depreciação/Amortização",
    padroes: [/DEPRECIACAO/, /AMORTIZACAO/],
  },
  {
    conta: "OUTRAS_RECEITAS_OPERACIONAIS",
    rotulo: "Outras Receitas Operacionais",
    padroes: [/OUTRAS? RECEITAS? OPERACIONA(L|IS)/, /^OUTRAS? RECEITAS?$/],
  },
  {
    conta: "OUTRAS_DESPESAS_OPERACIONAIS",
    rotulo: "Outras Despesas Operacionais",
    padroes: [/OUTRAS? DESPESAS? OPERACIONA(L|IS)/, /^OUTRAS? DESPESAS?$/],
  },
  {
    conta: "DESPESA_OPERACIONAL",
    rotulo: "Despesas Operacionais",
    padroes: [/DESPESAS? OPERACIONA(L|IS)/],
  },
  {
    conta: "EBITDA",
    rotulo: "EBITDA",
    padroes: [/\bEBITDA\b/],
  },
  {
    conta: "RESULTADO_OPERACIONAL",
    rotulo: "Resultado Operacional",
    padroes: [/RESULTADO OPERACIONAL/, /\bEBIT\b/],
  },
  {
    conta: "RESULTADO_ANTES_IR",
    rotulo: "Resultado Antes do IR/CSLL",
    padroes: [/RESULTADO ANTES (DO |DOS )?(IR|IMPOSTO)/, /\bLAIR\b/, /LUCRO ANTES (DO )?IR/],
  },
  {
    conta: "PROVISAO_IRPJ_CSLL",
    rotulo: "Provisão IRPJ/CSLL",
    padroes: [/PROVISAO (DE |PARA )?IRPJ/, /IRPJ.{0,4}CSLL/, /^CSLL$/, /^IRPJ$/],
  },
  {
    conta: "LUCRO_LIQUIDO",
    rotulo: "Lucro/Resultado Líquido",
    padroes: [/LUCRO LIQUIDO/, /RESULTADO LIQUIDO/, /PREJUIZO (DO )?EXERCICIO/],
  },
];

/** Devolve o primeiro item do dicionário cujo padrão bate — ou `undefined`. */
export function classificarConta(textoNormalizado: string): SinonimoConta | undefined {
  if (!textoNormalizado) return undefined;
  return DICIONARIO_CONTAS.find((item) => item.padroes.some((p) => p.test(textoNormalizado)));
}

/** Contas que compõem o núcleo de folha de pagamento — usadas no Fator R. */
const CONTAS_FOLHA: ReadonlySet<ContaCanonica> = new Set([
  "SALARIO_PROVENTOS",
  "PRO_LABORE",
  "INSS_PATRONAL",
  "FGTS",
  "DESPESA_PESSOAL",
]);

/**
 * Contas cujo sinal esperado é "redutor" (despesa/dedução) — usadas só para
 * detectar INCONSISTÊNCIA de sinal dentro do mesmo arquivo, nunca para
 * inverter sinal por conta própria.
 */
const CONTAS_REDUTORAS: ReadonlySet<ContaCanonica> = new Set([
  "DEVOLUCOES_VENDAS",
  "IMPOSTOS_SOBRE_VENDAS",
  "DEDUCOES_RECEITA",
  "CMV_CPV",
  "SALARIO_PROVENTOS",
  "PRO_LABORE",
  "INSS_PATRONAL",
  "FGTS",
  "DESPESA_PESSOAL",
  "DESPESA_COMERCIAL",
  "DESPESA_ADMINISTRATIVA",
  "DESPESA_OPERACIONAL",
  "DESPESA_FINANCEIRA",
  "DEPRECIACAO_AMORTIZACAO",
  "OUTRAS_DESPESAS_OPERACIONAIS",
  "PROVISAO_IRPJ_CSLL",
]);

// =============================================================================
// Grade comum (string[][]) — XLSX e CSV convergem aqui
// =============================================================================

interface Grade {
  linhas: string[][];
  /** Nome da aba, só para XLSX. */
  nomeAba?: string;
}

// --- CSV --------------------------------------------------------------------

/**
 * Parser de CSV escrito à mão (RFC 4180-ish): respeita aspas (inclusive
 * delimitador e quebra de linha DENTRO de campo entre aspas) e aspas
 * duplicadas como escape (`""` dentro de campo vira `"`). Não usa expressão
 * regular sobre o texto inteiro — texto de cliente é entrada hostil e um
 * regex mal desenhado sobre CSV é caminho conhecido para ReDoS.
 */
export function parseCsvTexto(texto: string, delimitador: string): string[][] {
  const linhas: string[][] = [];
  let linhaAtual: string[] = [];
  let campo = "";
  let dentroDeAspas = false;
  let i = 0;
  const n = texto.length;

  while (i < n) {
    const c = texto[i];
    if (dentroDeAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i += 2;
          continue;
        }
        dentroDeAspas = false;
        i += 1;
        continue;
      }
      campo += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      dentroDeAspas = true;
      i += 1;
      continue;
    }
    if (c === delimitador) {
      linhaAtual.push(campo);
      campo = "";
      i += 1;
      continue;
    }
    if (c === "\r") {
      i += 1;
      continue;
    }
    if (c === "\n") {
      linhaAtual.push(campo);
      linhas.push(linhaAtual);
      linhaAtual = [];
      campo = "";
      i += 1;
      continue;
    }
    campo += c;
    i += 1;
  }
  if (campo !== "" || linhaAtual.length > 0) {
    linhaAtual.push(campo);
    linhas.push(linhaAtual);
  }
  return linhas;
}

/**
 * Conta ocorrências de um caractere delimitador candidato FORA de aspas, numa
 * linha de amostra — para não confundir vírgula decimal (dentro de um campo)
 * com vírgula delimitadora.
 */
function contarDelimitadorForaDeAspas(linha: string, delimitador: string): number {
  let count = 0;
  let dentroDeAspas = false;
  for (const c of linha) {
    if (c === '"') dentroDeAspas = !dentroDeAspas;
    else if (c === delimitador && !dentroDeAspas) count++;
  }
  return count;
}

/**
 * Detecta o delimitador entre `;`, `,` e tab, pela consistência da contagem
 * nas primeiras linhas não vazias. Prefere `;` em empate — é a convenção do
 * Excel em pt-BR ("Salvar como CSV" com localidade Brasil usa `;`, porque a
 * vírgula já é o separador decimal).
 */
export function detectarDelimitadorCsv(amostraDeLinhas: string[]): string {
  const candidatos = [";", ",", "\t"];
  let melhor = ";";
  let melhorPontuacao = -1;
  for (const cand of candidatos) {
    const contagens = amostraDeLinhas
      .filter((l) => l.trim() !== "")
      .map((l) => contarDelimitadorForaDeAspas(l, cand));
    if (contagens.length === 0) continue;
    const minimo = Math.min(...contagens);
    // exige presença em TODAS as linhas amostradas (minimo > 0) para contar
    // como candidato consistente; pontuação = quantas colunas isso implica.
    const pontuacao = minimo > 0 ? minimo : -1;
    if (pontuacao > melhorPontuacao) {
      melhorPontuacao = pontuacao;
      melhor = cand;
    }
  }
  return melhor;
}

function csvParaGrade(buffer: Buffer): { grade: Grade; encoding: DetectedEncoding; delimitador: string } {
  const { text, encoding } = decodeTextBuffer(buffer);
  const amostra = text.split(/\r\n|\r|\n/).slice(0, 20);
  const delimitador = detectarDelimitadorCsv(amostra);
  const linhas = parseCsvTexto(text, delimitador);
  return { grade: { linhas }, encoding, delimitador };
}

// --- XLSX ---------------------------------------------------------------------

const MAX_COLUNAS_POR_LINHA_XLSX = 500;

/**
 * NOTA — por que NÃO é `ExcelJS.stream.xlsx.WorkbookReader` (leitura em streaming):
 *
 * A primeira versão deste módulo usava o leitor em streaming, exatamente pelo
 * motivo apontado na tarefa (planilha grande não pode estourar memória). Ao
 * testar com um arquivo REAL (inclusive um arquivo escrito pelo próprio
 * exceljs, round-trip), o leitor em streaming quebrou de forma reprodutível:
 *
 *   TypeError: Cannot read properties of undefined (reading 'sheets')
 *     at WorkbookReader._parseWorksheet (.../stream/xlsx/workbook-reader.js:303)
 *
 * Causa raiz confirmada inspecionando o .xlsx gerado (`unzip -l`): a entrada
 * `xl/worksheets/sheet1.xml` aparece ANTES de `xl/workbook.xml` dentro do
 * ZIP. O leitor em streaming processa as entradas na ordem em que chegam e
 * depende de `xl/workbook.xml` já ter sido parseado (`this.model.sheets`)
 * antes de qualquer aba — não é robusto à ordem em que o gerador (Excel,
 * LibreOffice, Google Sheets, ou o próprio exceljs) grava as entradas no ZIP.
 * Reproduzido tanto lendo de um Buffer quanto de um arquivo em disco — não é
 * peculiaridade da conversão Buffer→stream deste módulo. Como não é possível
 * confiar que todo arquivo de cliente terá `workbook.xml` antes das abas no
 * ZIP, usar o leitor em streaming arriscaria quebrar em produção com arquivo
 * real — inaceitável ("nada de fachada": não entrego um leitor que já sei,
 * por teste, que quebra).
 *
 * Por isso este módulo usa `workbook.xlsx.load(buffer)` (carga completa,
 * bem testada, é o caminho principal do exceljs) e protege memória por
 * OUTRA via: teto de bytes do arquivo (`maxBytes`, checado ANTES de
 * carregar) + teto de linhas levadas para as estruturas devolvidas
 * (`maxLinhas`). Isso NÃO evita que o `load()` materialize o workbook
 * inteiro em memória antes desses tetos entrarem em ação — é uma limitação
 * conhecida e documentada, não escondida (ver relatório de importação).
 * Uma leitura verdadeiramente incremental exigiria trocar de biblioteca ou
 * corrigir o bug do exceljs — fora do escopo desta tarefa.
 */
async function xlsxParaGrade(
  buffer: Buffer,
  maxLinhas: number,
): Promise<{ grade: Grade; parou: boolean; totalAbasComDados: number }> {
  const workbook = new ExcelJS.Workbook();
  // Cast documentado, não gambiarra silenciosa: o repositório tem DOIS
  // `@types/node` incompatíveis instalados (`@types/node@20.x` na raiz,
  // `openai` trava `@types/node@^18.11.18` e por isso mantém sua própria
  // cópia em node_modules/openai/node_modules/@types/node — versões maiores
  // não fecham o range do openai, então o npm não conseguiu deduplicar). O
  // `.d.ts` do exceljs referencia o `Buffer` global, e o TypeScript enxerga
  // as DUAS declarações de `Buffer` do projeto (pré-existente, não causado
  // por este módulo) — o `Buffer<ArrayBufferLike>` (versão nova, com
  // `resizable`/`detached` etc.) deixa de bater estruturalmente com a
  // assinatura mais antiga que `exceljs` importa. Verificado: os dois
  // pacotes de tipos coexistem em `node_modules/@types/node` (20.19.43) e
  // `node_modules/openai/node_modules/@types/node` (18.19.130) — não é
  // suposição. Correção definitiva seria unificar a versão via `overrides`
  // no `package.json` na raiz do projeto, fora do escopo autorizado desta
  // tarefa (só posso alterar `package.json` para A DEPENDÊNCIA de xlsx) —
  // reportado no relatório de importação como pendência.
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);

  const abasComDados = workbook.worksheets.filter((ws) => ws.actualRowCount > 0);
  const totalAbasComDados = abasComDados.length;
  const aba = abasComDados[0];

  if (!aba) {
    return { grade: { linhas: [], nomeAba: undefined }, parou: false, totalAbasComDados: 0 };
  }

  const linhas: string[][] = [];
  let parou = false;

  aba.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    if (linhas.length >= maxLinhas) {
      parou = true;
      return;
    }
    while (linhas.length < rowNumber - 1) linhas.push([]);
    const celulas: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      if (colNumber > MAX_COLUNAS_POR_LINHA_XLSX) return;
      celulas[colNumber - 1] = cellToText(cell);
    });
    linhas[rowNumber - 1] = celulas;
  });

  return { grade: { linhas, nomeAba: aba.name }, parou, totalAbasComDados };
}

// =============================================================================
// Estrutura reconhecida: cabeçalho, coluna de descrição, colunas de valor
// =============================================================================

const PADROES_CABECALHO_DESCRICAO = [
  /^DESCRICAO/,
  /^CONTA$/,
  /^CONTAS$/,
  /^HISTORICO/,
  /^DISCRIMINACAO/,
  /^ITEM$/,
  /^RUBRICA/,
  /^CLASSIFICACAO/,
  /^GRUPO$/,
  /^NATUREZA/,
];
const PADROES_CABECALHO_PESSOA = [/^NOME/, /FUNCIONARIO/, /COLABORADOR/, /EMPREGADO/];
const PADROES_CABECALHO_PERIODO = [/COMPETENCIA/, /^PERIODO/, /^MES$/, /^MES ANO/, /^DATA/];
const PADROES_CABECALHO_VALOR = [/^VALOR/, /^TOTAL/, /^SALDO/, /^MONTANTE/];
const PREFIXOS_MES = ["JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"];

function ehCabecalhoMes(normalizado: string): boolean {
  return PREFIXOS_MES.some((p) => normalizado.startsWith(p));
}

type TipoColuna = "DESCRICAO" | "PESSOA" | "PERIODO" | "VALOR" | "IGNORADA";

interface ColunaDetectada {
  indice: number; // 0-based, posição na grade
  rotulo: string; // texto original do cabeçalho
  tipo: TipoColuna;
}

interface CabecalhoDetectado {
  linhaIndice: number; // 0-based
  colunas: ColunaDetectada[];
  confirmadoPorPalavraChave: boolean;
}

function detectarCabecalho(grade: string[][], maxLinhasVarredura: number): CabecalhoDetectado | undefined {
  const limite = Math.min(grade.length, maxLinhasVarredura);

  const avaliar = (linhaIdx: number): CabecalhoDetectado | undefined => {
    const linha = grade[linhaIdx];
    if (!linha) return undefined;
    const naoVazias = linha.filter((c) => c && c.trim() !== "");
    if (naoVazias.length < 2) return undefined;

    let temPalavraChave = false;
    let colunaDescricaoIdx: number | undefined;
    const colunas: ColunaDetectada[] = [];

    linha.forEach((rotuloOriginal, idx) => {
      const rotulo = (rotuloOriginal ?? "").trim();
      if (rotulo === "") return;
      const norm = normalizarTexto(rotulo);

      if (colunaDescricaoIdx === undefined && PADROES_CABECALHO_PESSOA.some((p) => p.test(norm))) {
        colunas.push({ indice: idx, rotulo, tipo: "PESSOA" });
        colunaDescricaoIdx = idx;
        temPalavraChave = true;
        return;
      }
      if (colunaDescricaoIdx === undefined && PADROES_CABECALHO_DESCRICAO.some((p) => p.test(norm))) {
        colunas.push({ indice: idx, rotulo, tipo: "DESCRICAO" });
        colunaDescricaoIdx = idx;
        temPalavraChave = true;
        return;
      }
      if (PADROES_CABECALHO_PERIODO.some((p) => p.test(norm))) {
        colunas.push({ indice: idx, rotulo, tipo: "PERIODO" });
        temPalavraChave = true;
        return;
      }
      if (ehCabecalhoMes(norm)) {
        colunas.push({ indice: idx, rotulo, tipo: "VALOR" });
        temPalavraChave = true;
        return;
      }
      if (
        PADROES_CABECALHO_VALOR.some((p) => p.test(norm)) ||
        /R\$/.test(rotulo) ||
        // Cabeçalho que já bate com o dicionário de contas (ex.: "Salário",
        // "INSS Patronal", "FGTS", "Pró-labore") também é coluna de valor —
        // é o caso da folha detalhada, em que quem carrega a classificação
        // contábil é a COLUNA, não a descrição da linha (que é o nome da
        // pessoa). Ver uso em `parsePlanilha`, modo FOLHA_DETALHADA.
        classificarConta(norm) !== undefined
      ) {
        colunas.push({ indice: idx, rotulo, tipo: "VALOR" });
        temPalavraChave = true;
        return;
      }
      colunas.push({ indice: idx, rotulo, tipo: "IGNORADA" });
    });

    if (!temPalavraChave) return undefined;
    return { linhaIndice: linhaIdx, colunas, confirmadoPorPalavraChave: true };
  };

  for (let i = 0; i < limite; i++) {
    const r = avaliar(i);
    if (r) return r;
  }

  // Fallback: primeira linha com >= 2 células não vazias, sem confirmação.
  for (let i = 0; i < limite; i++) {
    const linha = grade[i];
    if (!linha) continue;
    const naoVazias = linha.filter((c) => c && c.trim() !== "");
    if (naoVazias.length >= 2) {
      const colunas: ColunaDetectada[] = linha.map((rotuloOriginal, idx) => ({
        indice: idx,
        rotulo: (rotuloOriginal ?? "").trim(),
        tipo: idx === 0 ? "DESCRICAO" : "VALOR",
      }));
      return { linhaIndice: i, colunas, confirmadoPorPalavraChave: false };
    }
  }
  return undefined;
}

/**
 * Segunda passada: se nenhuma coluna de valor foi encontrada por palavra-chave,
 * tenta achar colunas cujo conteúdo (nas primeiras linhas de dado) é
 * majoritariamente numérico — fallback explícito e avisado, nunca silencioso.
 */
function reclassificarColunasIgnoradasComoValor(
  cabecalho: CabecalhoDetectado,
  grade: string[][],
  linhaDadosInicio: number,
): { aplicado: boolean } {
  const jaTemValor = cabecalho.colunas.some((c) => c.tipo === "VALOR");
  if (jaTemValor) return { aplicado: false };

  const amostraFim = Math.min(grade.length, linhaDadosInicio + 15);
  let aplicado = false;
  for (const col of cabecalho.colunas) {
    if (col.tipo !== "IGNORADA") continue;
    let total = 0;
    let numericos = 0;
    for (let i = linhaDadosInicio; i < amostraFim; i++) {
      const texto = grade[i]?.[col.indice];
      if (!texto || texto.trim() === "") continue;
      total++;
      if (parseValorMonetario(texto).valor !== undefined) numericos++;
    }
    if (total > 0 && numericos / total >= 0.6) {
      col.tipo = "VALOR";
      aplicado = true;
    }
  }
  return { aplicado };
}

// =============================================================================
// Linha classificada — tipo devolvido ao chamador
// =============================================================================

export interface LinhaPlanilha {
  /** Número da linha na planilha/CSV original (1-based, como no Excel). */
  linha: number;
  descricaoOriginal: string;
  conta?: ContaCanonica;
  rotuloConta?: string;
  /** Texto original da coluna de competência/período, quando existe. */
  competencia?: string;
  /** Rótulo da coluna (mês, "Valor" etc.) → valor monetário daquela coluna nesta linha. */
  valores: Record<string, Money>;
  /** true quando a descrição bate com um padrão de linha de total/subtotal. */
  linhaDeTotal?: boolean;
}

export interface FolhaDetalhadaResumo {
  numeroEmpregados: number;
  totalProventos?: Money;
  inssPatronal?: Money;
  fgts?: Money;
  proLabore?: Money;
  /** Funcionários cujo valor não pôde ser lido em nenhuma coluna reconhecida. */
  linhasComPendencia: number;
}

export type TipoPlanilha = "DRE_OU_DESPESAS" | "FOLHA_RESUMO" | "FOLHA_DETALHADA" | "NAO_IDENTIFICADO";

export interface ParsedPlanilha {
  formato: "XLSX" | "CSV";
  tipo: TipoPlanilha;
  encoding?: DetectedEncoding;
  delimitadorCsv?: string;
  nomeAba?: string;
  linhaCabecalho?: number; // 1-based, para exibir ao usuário
  cabecalhoConfirmadoPorPalavraChave: boolean;
  colunaDescricao?: string;
  colunaPeriodo?: string;
  colunasValor: string[];
  linhas: LinhaPlanilha[];
  pendencias: LinhaPlanilha[];
  totaisPorConta: Partial<Record<ContaCanonica, Money>>;
  folha?: FolhaDetalhadaResumo;
}

export interface PlanilhaExtractionResult extends ExtractionResult {
  planilha: ParsedPlanilha;
}

export interface ParsePlanilhaOptions {
  /** Limite técnico de linhas processadas (proteção de memória, não regra de negócio). */
  maxLinhas?: number;
  /** Limite técnico de tamanho de arquivo em bytes. */
  maxBytes?: number;
  /** Janela de varredura (em linhas) para localizar o cabeçalho. */
  maxLinhasVarreduraCabecalho?: number;
}

const PADRAO_LINHA_TOTAL = /^TOTAL/;

const DEFAULT_MAX_LINHAS = 50_000;
const DEFAULT_MAX_BYTES = 60 * 1024 * 1024; // 60 MB — teto técnico, não de negócio
const DEFAULT_MAX_VARREDURA_CABECALHO = 40;

function resultadoVazio(
  parser: string,
  formato: "XLSX" | "CSV",
  errors: string[],
  warnings: string[],
): PlanilhaExtractionResult {
  return {
    parser,
    invoices: [],
    apuracoes: [],
    warnings,
    errors,
    planilha: {
      formato,
      tipo: "NAO_IDENTIFICADO",
      cabecalhoConfirmadoPorPalavraChave: false,
      colunasValor: [],
      linhas: [],
      pendencias: [],
      totaisPorConta: {},
    },
  };
}

/**
 * Ponto de entrada. Detecta XLSX vs CSV pelos bytes (assinatura ZIP `PK`),
 * não pela extensão do nome do arquivo — a extensão é só usada em avisos.
 */
export async function parsePlanilha(
  buffer: Buffer,
  filename: string,
  options: ParsePlanilhaOptions = {},
): Promise<PlanilhaExtractionResult> {
  const maxLinhas = options.maxLinhas ?? DEFAULT_MAX_LINHAS;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxVarredura = options.maxLinhasVarreduraCabecalho ?? DEFAULT_MAX_VARREDURA_CABECALHO;

  const ehXlsx = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const formato: "XLSX" | "CSV" = ehXlsx ? "XLSX" : "CSV";

  if (buffer.length === 0) {
    return resultadoVazio("planilha", formato, ["Arquivo vazio (0 bytes)."], []);
  }

  if (buffer.length > maxBytes) {
    return resultadoVazio(
      "planilha",
      formato,
      [
        `Arquivo "${filename}" tem ${buffer.length} bytes, acima do limite técnico de ${maxBytes} ` +
          "bytes deste leitor (proteção de memória, não é limite de negócio). Divida o arquivo em " +
          "blocos menores (ex.: por trimestre) e reenvie.",
      ],
      [],
    );
  }

  const warnings: string[] = [];
  const errors: string[] = [];
  let grade: Grade;
  let encoding: DetectedEncoding | undefined;
  let delimitadorCsv: string | undefined;

  if (ehXlsx) {
    let resultado;
    try {
      resultado = await xlsxParaGrade(buffer, maxLinhas);
    } catch (e) {
      return resultadoVazio("planilha", formato, [
        `Falha ao ler o arquivo XLSX "${filename}": ${(e as Error).message}`,
      ], []);
    }
    grade = resultado.grade;
    if (resultado.parou) {
      errors.push(
        `Planilha excede o limite técnico de ${maxLinhas} linhas processadas. Os dados abaixo são ` +
          `PARCIAIS (só até a linha ${maxLinhas}). Divida o arquivo em blocos e reenvie o restante — ` +
          "nunca truncamos silenciosamente.",
      );
    }
    if (resultado.totalAbasComDados > 1) {
      warnings.push(
        `Arquivo tem ${resultado.totalAbasComDados} abas com dados — só a primeira aba não vazia ` +
          `("${grade.nomeAba ?? "?"}") foi processada. As demais foram ignoradas nesta versão.`,
      );
    }
  } else {
    const resultado = csvParaGrade(buffer);
    grade = resultado.grade;
    encoding = resultado.encoding;
    delimitadorCsv = resultado.delimitador;
    warnings.push(`Codificação detectada: ${encoding}. Delimitador detectado: "${delimitadorCsv}".`);
    if (grade.linhas.length > maxLinhas) {
      errors.push(
        `CSV excede o limite técnico de ${maxLinhas} linhas processadas (arquivo tem ${grade.linhas.length}). ` +
          `Os dados abaixo são PARCIAIS (só até a linha ${maxLinhas}). Divida o arquivo em blocos.`,
      );
      grade.linhas = grade.linhas.slice(0, maxLinhas);
    }
  }

  if (grade.linhas.every((l) => l.every((c) => !c || c.trim() === ""))) {
    warnings.push("Planilha sem nenhuma célula preenchida — nada para extrair.");
    const vazio = resultadoVazio("planilha", formato, errors, warnings);
    vazio.planilha.encoding = encoding;
    vazio.planilha.delimitadorCsv = delimitadorCsv;
    vazio.planilha.nomeAba = grade.nomeAba;
    return vazio;
  }

  const cabecalho = detectarCabecalho(grade.linhas, maxVarredura);
  if (!cabecalho) {
    errors.push("Não foi possível localizar uma linha de cabeçalho com dados reconhecíveis.");
    const vazio = resultadoVazio("planilha", formato, errors, warnings);
    vazio.planilha.encoding = encoding;
    vazio.planilha.delimitadorCsv = delimitadorCsv;
    vazio.planilha.nomeAba = grade.nomeAba;
    return vazio;
  }
  if (!cabecalho.confirmadoPorPalavraChave) {
    warnings.push(
      `Cabeçalho não confirmado por palavra-chave conhecida (nenhuma coluna bateu com "descrição", ` +
        `"valor", nome de mês etc.) — assumida a linha ${cabecalho.linhaIndice + 1} como cabeçalho, e a ` +
        "primeira coluna como descrição. Revise a classificação de colunas.",
    );
  }

  const linhaDadosInicio = cabecalho.linhaIndice + 1;
  const { aplicado: fallbackValor } = reclassificarColunasIgnoradasComoValor(
    cabecalho,
    grade.linhas,
    linhaDadosInicio,
  );
  if (fallbackValor) {
    warnings.push(
      "Nenhuma coluna de valor foi identificada pelo cabeçalho — colunas com conteúdo majoritariamente " +
        "numérico nas primeiras linhas foram assumidas como coluna de valor. Revise.",
    );
  }

  let colunaDescricao = cabecalho.colunas.find((c) => c.tipo === "DESCRICAO" || c.tipo === "PESSOA");
  const ehPessoa = colunaDescricao?.tipo === "PESSOA";
  if (!colunaDescricao) {
    // Fallback: coluna com mais texto não numérico nas primeiras linhas.
    const candidatas = cabecalho.colunas.filter((c) => c.tipo !== "PERIODO" && c.tipo !== "VALOR");
    let melhor: ColunaDetectada | undefined;
    let melhorScore = -1;
    const amostraFim = Math.min(grade.linhas.length, linhaDadosInicio + 15);
    for (const col of candidatas) {
      let score = 0;
      for (let i = linhaDadosInicio; i < amostraFim; i++) {
        const texto = grade.linhas[i]?.[col.indice];
        if (texto && texto.trim() !== "" && parseValorMonetario(texto).valor === undefined) score++;
      }
      if (score > melhorScore) {
        melhorScore = score;
        melhor = col;
      }
    }
    if (melhor) {
      colunaDescricao = melhor;
      warnings.push(
        `Coluna de descrição não identificada pelo cabeçalho — assumida a coluna "${melhor.rotulo}" ` +
          "por ter mais texto não numérico. Revise.",
      );
    }
  }

  const colunaPeriodo = cabecalho.colunas.find((c) => c.tipo === "PERIODO");
  const colunasValor = cabecalho.colunas.filter((c) => c.tipo === "VALOR");

  if (!colunaDescricao) {
    errors.push("Não foi possível identificar a coluna de descrição/conta.");
  }
  if (colunasValor.length === 0) {
    warnings.push("Nenhuma coluna de valor foi identificada — as linhas serão devolvidas sem valores.");
  }

  const linhasClassificadas: LinhaPlanilha[] = [];
  let folhaHits = 0;
  let dreHits = 0;

  for (let i = linhaDadosInicio; i < grade.linhas.length; i++) {
    const linhaCrua = grade.linhas[i] ?? [];
    const todasVazias = linhaCrua.every((c) => !c || c.trim() === "");
    if (todasVazias) continue; // linha em branco no meio — pulada, não é erro

    const descricaoOriginal = colunaDescricao ? (linhaCrua[colunaDescricao.indice] ?? "").trim() : "";
    if (descricaoOriginal === "") continue; // sem descrição não há o que classificar

    const numeroLinha = i + 1;
    const normalizado = normalizarTexto(descricaoOriginal);
    const linhaDeTotal = PADRAO_LINHA_TOTAL.test(normalizado);

    const sinonimo = ehPessoa ? undefined : classificarConta(normalizado);
    if (sinonimo) {
      if (CONTAS_FOLHA.has(sinonimo.conta)) folhaHits++;
      else dreHits++;
    }

    const valores: Record<string, Money> = {};
    for (const col of colunasValor) {
      const textoCelula = linhaCrua[col.indice];
      if (!textoCelula || textoCelula.trim() === "") continue; // ausente, não zero
      const { valor, aviso } = parseValorMonetario(textoCelula);
      if (valor !== undefined) {
        valores[col.rotulo] = valor;
      } else if (aviso) {
        warnings.push(`Linha ${numeroLinha}, coluna "${col.rotulo}": ${aviso}`);
      }
    }

    linhasClassificadas.push({
      linha: numeroLinha,
      descricaoOriginal,
      conta: sinonimo?.conta,
      rotuloConta: sinonimo?.rotulo,
      competencia: colunaPeriodo ? (linhaCrua[colunaPeriodo.indice] ?? "").trim() || undefined : undefined,
      valores,
      linhaDeTotal: linhaDeTotal || undefined,
    });
  }

  // Sinal: nunca inferido — só detectamos e avisamos inconsistência.
  const sinaisPorConta = new Map<ContaCanonica, { positivo: boolean; negativo: boolean }>();
  for (const l of linhasClassificadas) {
    if (!l.conta || !CONTAS_REDUTORAS.has(l.conta)) continue;
    for (const v of Object.values(l.valores)) {
      if (v.isZero()) continue;
      const estado = sinaisPorConta.get(l.conta) ?? { positivo: false, negativo: false };
      if (v.isNegative()) estado.negativo = true;
      else estado.positivo = true;
      sinaisPorConta.set(l.conta, estado);
    }
  }
  for (const [conta, estado] of sinaisPorConta) {
    if (estado.positivo && estado.negativo) {
      const rotulo = DICIONARIO_CONTAS.find((d) => d.conta === conta)?.rotulo ?? conta;
      warnings.push(
        `Conta "${rotulo}" aparece com valores positivos E negativos na mesma planilha — sinal NÃO foi ` +
          "normalizado (não corrigimos dado do cliente por conta própria). Confira manualmente.",
      );
    }
  }

  const totaisPorConta: Partial<Record<ContaCanonica, Money>> = {};
  for (const l of linhasClassificadas) {
    if (!l.conta || l.linhaDeTotal) continue;
    const existentes = Object.values(l.valores);
    if (existentes.length === 0) continue;
    totaisPorConta[l.conta] = sum(totaisPorConta[l.conta], ...existentes);
  }

  let tipo: TipoPlanilha;
  let folha: FolhaDetalhadaResumo | undefined;
  let pendencias: LinhaPlanilha[];

  if (ehPessoa && colunasValor.length > 0) {
    tipo = "FOLHA_DETALHADA";
    // No modo detalhado, quem é classificado é o CABEÇALHO da coluna de
    // valor (ex.: "Salário", "INSS Patronal", "FGTS"), não a descrição da
    // linha — a descrição da linha é o nome da pessoa.
    let totalProventos: Money | undefined;
    let inssPatronal: Money | undefined;
    let fgts: Money | undefined;
    let proLabore: Money | undefined;

    for (const col of colunasValor) {
      const sinonimoColuna = classificarConta(normalizarTexto(col.rotulo));
      if (!sinonimoColuna) continue;
      const valoresColuna = linhasClassificadas
        .filter((l) => !l.linhaDeTotal)
        .map((l) => l.valores[col.rotulo])
        .filter((v): v is Money => v !== undefined);
      if (valoresColuna.length === 0) continue;
      const total = sum(...valoresColuna);
      switch (sinonimoColuna.conta) {
        case "SALARIO_PROVENTOS":
          totalProventos = sum(totalProventos, total);
          break;
        case "INSS_PATRONAL":
          inssPatronal = sum(inssPatronal, total);
          break;
        case "FGTS":
          fgts = sum(fgts, total);
          break;
        case "PRO_LABORE":
          proLabore = sum(proLabore, total);
          break;
        default:
          break;
      }
    }

    const linhasFuncionarios = linhasClassificadas.filter((l) => !l.linhaDeTotal);
    const semNenhumValor = linhasFuncionarios.filter((l) => Object.keys(l.valores).length === 0);

    folha = {
      numeroEmpregados: linhasFuncionarios.length,
      totalProventos,
      inssPatronal,
      fgts,
      proLabore,
      linhasComPendencia: semNenhumValor.length,
    };

    // No modo detalhado, "pendência" é o funcionário sem NENHUM valor legível
    // em nenhuma coluna — não faz sentido usar `!l.conta` aqui, porque a
    // linha (pessoa) nunca é classificada individualmente neste modo.
    pendencias = semNenhumValor;

    for (const l of semNenhumValor) {
      warnings.push(
        `Linha ${l.linha}: funcionário "${l.descricaoOriginal}" sem nenhum valor reconhecido em ` +
          "nenhuma coluna — confira manualmente.",
      );
    }
  } else if (folhaHits > 0 && folhaHits >= dreHits) {
    tipo = "FOLHA_RESUMO";
    pendencias = linhasClassificadas.filter((l) => !l.conta);
  } else if (dreHits > 0 || folhaHits > 0) {
    tipo = "DRE_OU_DESPESAS";
    pendencias = linhasClassificadas.filter((l) => !l.conta);
  } else if (linhasClassificadas.length > 0) {
    tipo = "DRE_OU_DESPESAS"; // há dados, mas nada bateu no dicionário — tudo em pendências
    pendencias = linhasClassificadas.filter((l) => !l.conta);
  } else {
    tipo = "NAO_IDENTIFICADO";
    pendencias = [];
  }

  if (pendencias.length > 0 && tipo !== "FOLHA_DETALHADA") {
    warnings.push(
      `${pendencias.length} linha(s) com descrição não reconhecida pelo dicionário de contas — ` +
        "ver `pendencias`. Nenhuma foi descartada nem classificada por aproximação.",
    );
  }

  const planilha: ParsedPlanilha = {
    formato,
    tipo,
    encoding,
    delimitadorCsv,
    nomeAba: grade.nomeAba,
    linhaCabecalho: cabecalho.linhaIndice + 1,
    cabecalhoConfirmadoPorPalavraChave: cabecalho.confirmadoPorPalavraChave,
    colunaDescricao: colunaDescricao?.rotulo,
    colunaPeriodo: colunaPeriodo?.rotulo,
    colunasValor: colunasValor.map((c) => c.rotulo),
    linhas: linhasClassificadas,
    pendencias,
    totaisPorConta,
    folha,
  };

  return {
    parser: "planilha",
    invoices: [],
    apuracoes: [],
    warnings,
    errors,
    planilha,
  };
}

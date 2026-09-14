import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import {
  parsePlanilha,
  parseValorMonetario,
  detectarDelimitadorCsv,
  parseCsvTexto,
  normalizarTexto,
  classificarConta,
} from "./planilha";

const D = (v: string) => new Prisma.Decimal(v);

async function buildXlsxBuffer(rows: (string | number | null)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Plan1");
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// =============================================================================
// parseValorMonetario — casos exigidos pela tarefa, valores medidos por execução
// =============================================================================

describe("parseValorMonetario", () => {
  it("formato BR (ponto milhar, vírgula decimal)", () => {
    expect(parseValorMonetario("1.234,56").valor?.equals(D("1234.56"))).toBe(true);
  });

  it("formato US (vírgula milhar, ponto decimal)", () => {
    expect(parseValorMonetario("1,234.56").valor?.equals(D("1234.56"))).toBe(true);
  });

  it("parênteses contábeis viram negativo", () => {
    expect(parseValorMonetario("(1.234,56)").valor?.equals(D("-1234.56"))).toBe(true);
  });

  it("prefixo R$ é removido", () => {
    expect(parseValorMonetario("R$ 1.234,56").valor?.equals(D("1234.56"))).toBe(true);
  });

  it("sinal de menos ao final (export de ERP)", () => {
    expect(parseValorMonetario("1.234,56-").valor?.equals(D("-1234.56"))).toBe(true);
  });

  it("número puro (string de cell.value do exceljs) é aceito sem alteração", () => {
    expect(parseValorMonetario("1234.56").valor?.equals(D("1234.56"))).toBe(true);
    expect(parseValorMonetario("-1234.56").valor?.equals(D("-1234.56"))).toBe(true);
  });

  it("separador único seguido de 3 dígitos é tratado como milhar sem decimais, com aviso", () => {
    const r1 = parseValorMonetario("1.234");
    expect(r1.valor?.equals(D("1234"))).toBe(true);
    expect(r1.aviso).toMatch(/milhar sem casas decimais/);

    const r2 = parseValorMonetario("1,234");
    expect(r2.valor?.equals(D("1234"))).toBe(true);
    expect(r2.aviso).toMatch(/milhar sem casas decimais/);
  });

  it("célula vazia é ausente (undefined), não zero", () => {
    expect(parseValorMonetario("")).toEqual({});
    expect(parseValorMonetario(undefined)).toEqual({});
  });

  it("texto não numérico gera aviso, nunca lança exceção nem vira zero", () => {
    const r = parseValorMonetario("abc");
    expect(r.valor).toBeUndefined();
    expect(r.aviso).toMatch(/não reconhecido como valor monetário/);
  });

  it("notação científica é rejeitada explicitamente", () => {
    const r = parseValorMonetario("1.23e+21");
    expect(r.valor).toBeUndefined();
    expect(r.aviso).toMatch(/notação científica/);
  });
});

// =============================================================================
// Utilidades de texto e CSV
// =============================================================================

describe("normalizarTexto", () => {
  it("remove acento, maiúsculiza e vira pontuação em espaço", () => {
    expect(normalizarTexto("Pró-labore")).toBe("PRO LABORE");
    expect(normalizarTexto("  Despesas   Administrativas ")).toBe("DESPESAS ADMINISTRATIVAS");
    expect(normalizarTexto(undefined)).toBe("");
  });
});

describe("classificarConta", () => {
  it("reconhece sinônimo do dicionário", () => {
    expect(classificarConta(normalizarTexto("Receita Bruta de Vendas"))?.conta).toBe("RECEITA_BRUTA");
    expect(classificarConta(normalizarTexto("(-) CMV"))?.conta).toBe("CMV_CPV");
    expect(classificarConta(normalizarTexto("FGTS"))?.conta).toBe("FGTS");
  });

  it("devolve undefined para texto sem sinônimo — nunca chuta", () => {
    expect(classificarConta(normalizarTexto("Linha Totalmente Esquisita"))).toBeUndefined();
  });
});

describe("detectarDelimitadorCsv", () => {
  it("detecta ; quando é o delimitador consistente", () => {
    expect(detectarDelimitadorCsv(["A;B;C", "1;2;3"])).toBe(";");
  });

  it("detecta , quando é o delimitador consistente", () => {
    expect(detectarDelimitadorCsv(["A,B,C", "1,2,3"])).toBe(",");
  });
});

describe("parseCsvTexto", () => {
  it("respeita aspas com delimitador e quebra de linha dentro do campo", () => {
    const texto = 'Descricao;Valor;Obs\r\n"Receita; Bruta de Vendas";1000,00;"linha\ncom quebra"\r\n';
    const linhas = parseCsvTexto(texto, ";");
    expect(linhas[0]).toEqual(["Descricao", "Valor", "Obs"]);
    expect(linhas[1]).toEqual(["Receita; Bruta de Vendas", "1000,00", "linha\ncom quebra"]);
  });
});

// =============================================================================
// parsePlanilha — XLSX: DRE mensal em colunas, cabeçalho na linha 5,
// linha em branco no meio, valor negativo entre parênteses, linha não
// classificada.
// =============================================================================

describe("parsePlanilha — XLSX, DRE mensal em colunas com cabeçalho na linha 5", () => {
  const xlsxRows: (string | number | null)[][] = [
    ["DRE - Empresa Exemplo Ltda"],
    ["CNPJ: 12.345.678/0001-99"],
    [],
    [],
    ["Descrição", "Jan/25", "Fev/25", "Mar/25"],
    ["Receita Bruta de Vendas", 100000, 110000, 120000],
    ["(-) Devoluções de Vendas", -1000, -1200, -900],
    [],
    ["(-) CMV", "(40000)", "(42000)", "(45000)"],
    ["(-) Despesas Administrativas", 15000, 15000, 16000],
    ["Linha Totalmente Esquisita Sem Classificação", 500, 500, 500],
  ];

  it("acha o cabeçalho na linha 5, mesmo com título e linhas em branco antes", async () => {
    const buf = await buildXlsxBuffer(xlsxRows);
    const r = await parsePlanilha(buf, "dre-mensal.xlsx");
    expect(r.errors).toEqual([]);
    expect(r.planilha.formato).toBe("XLSX");
    expect(r.planilha.linhaCabecalho).toBe(5);
    expect(r.planilha.cabecalhoConfirmadoPorPalavraChave).toBe(true);
    expect(r.planilha.colunaDescricao).toBe("Descrição");
    expect(r.planilha.colunasValor).toEqual(["Jan/25", "Fev/25", "Mar/25"]);
    expect(r.planilha.tipo).toBe("DRE_OU_DESPESAS");
  });

  it("pula a linha em branco no meio sem quebrar a numeração das linhas seguintes", async () => {
    const buf = await buildXlsxBuffer(xlsxRows);
    const r = await parsePlanilha(buf, "dre-mensal.xlsx");
    const linhasNumeros = r.planilha.linhas.map((l) => l.linha);
    // linha 8 (em branco, entre "Devoluções" na 7 e "CMV" na 9) não aparece.
    expect(linhasNumeros).toEqual([6, 7, 9, 10, 11]);
  });

  it("classifica as contas reconhecidas e soma os 3 meses em totaisPorConta", async () => {
    const buf = await buildXlsxBuffer(xlsxRows);
    const r = await parsePlanilha(buf, "dre-mensal.xlsx");
    expect(r.planilha.totaisPorConta.RECEITA_BRUTA?.equals(D("330000"))).toBe(true);
    expect(r.planilha.totaisPorConta.DEVOLUCOES_VENDAS?.equals(D("-3100"))).toBe(true);
    expect(r.planilha.totaisPorConta.DESPESA_ADMINISTRATIVA?.equals(D("46000"))).toBe(true);
  });

  it("valor negativo entre parênteses (célula de texto '(40000)') vira -40000, não 40000", async () => {
    const buf = await buildXlsxBuffer(xlsxRows);
    const r = await parsePlanilha(buf, "dre-mensal.xlsx");
    const cmv = r.planilha.linhas.find((l) => l.conta === "CMV_CPV");
    expect(cmv?.valores["Jan/25"]?.equals(D("-40000"))).toBe(true);
    expect(r.planilha.totaisPorConta.CMV_CPV?.equals(D("-127000"))).toBe(true);
  });

  it("linha sem sinônimo no dicionário vai para pendências com o texto original, sem sumir", async () => {
    const buf = await buildXlsxBuffer(xlsxRows);
    const r = await parsePlanilha(buf, "dre-mensal.xlsx");
    expect(r.planilha.pendencias).toHaveLength(1);
    expect(r.planilha.pendencias[0].descricaoOriginal).toBe(
      "Linha Totalmente Esquisita Sem Classificação",
    );
    expect(r.planilha.pendencias[0].conta).toBeUndefined();
    // a linha aparece também em `linhas` — nunca é descartada.
    expect(r.planilha.linhas.some((l) => l.descricaoOriginal === "Linha Totalmente Esquisita Sem Classificação")).toBe(
      true,
    );
    expect(r.warnings.some((w) => w.includes("1 linha(s) com descrição não reconhecida"))).toBe(true);
  });
});

// =============================================================================
// parsePlanilha — CSV com coluna de competência, delimitador ";"
// =============================================================================

describe("parsePlanilha — CSV ';' com coluna de competência", () => {
  const csv = [
    "Descrição;Competência;Valor",
    "Receita Bruta de Vendas;01/2026;150000,00",
    "Receita Bruta de Vendas;02/2026;160000,00",
    "(-) Despesas Comerciais;01/2026;(8000,00)",
    "Linha Não Reconhecida;01/2026;321,00",
  ].join("\r\n");

  it("detecta ; como delimitador e reconhece a coluna de competência", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "dre-competencia.csv");
    expect(r.errors).toEqual([]);
    expect(r.planilha.delimitadorCsv).toBe(";");
    expect(r.planilha.encoding).toBe("utf-8");
    expect(r.planilha.colunaPeriodo).toBe("Competência");
  });

  it("mantém uma linha por competência (formato longo), com o valor certo em cada uma", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "dre-competencia.csv");
    const receitas = r.planilha.linhas.filter((l) => l.conta === "RECEITA_BRUTA");
    expect(receitas).toHaveLength(2);
    expect(receitas[0].competencia).toBe("01/2026");
    expect(receitas[0].valores["Valor"]?.equals(D("150000"))).toBe(true);
    expect(receitas[1].competencia).toBe("02/2026");
    expect(receitas[1].valores["Valor"]?.equals(D("160000"))).toBe(true);
  });

  it("valor negativo entre parênteses no CSV também vira negativo", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "dre-competencia.csv");
    const despComercial = r.planilha.linhas.find((l) => l.conta === "DESPESA_COMERCIAL");
    expect(despComercial?.valores["Valor"]?.equals(D("-8000"))).toBe(true);
  });

  it("linha não reconhecida vai para pendências", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "dre-competencia.csv");
    expect(r.planilha.pendencias.map((l) => l.descricaoOriginal)).toEqual(["Linha Não Reconhecida"]);
  });
});

// =============================================================================
// parsePlanilha — CSV com delimitador ","
// =============================================================================

describe("parsePlanilha — CSV ',' (despesas)", () => {
  const csv = ["Descricao,Valor", "Receita Bruta,1234.56", "(-) CMV,(500.00)"].join("\n");

  it("detecta , como delimitador", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "despesas.csv");
    expect(r.planilha.delimitadorCsv).toBe(",");
  });

  it("interpreta 1234.56 (ponto decimal, sem milhar) corretamente", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "despesas.csv");
    const receita = r.planilha.linhas.find((l) => l.conta === "RECEITA_BRUTA");
    expect(receita?.valores["Valor"]?.equals(D("1234.56"))).toBe(true);
  });

  it("(-) CMV,(500.00) vira -500", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "despesas.csv");
    const cmv = r.planilha.linhas.find((l) => l.conta === "CMV_CPV");
    expect(cmv?.valores["Valor"]?.equals(D("-500"))).toBe(true);
  });
});

// =============================================================================
// Sinal nunca inferido — inconsistência vira warning
// =============================================================================

describe("parsePlanilha — sinal não é normalizado por conta própria", () => {
  it("mesma conta com sinais diferentes gera warning, mas mantém os dois valores como vieram", async () => {
    const csv = [
      "Descricao;Valor",
      "(-) Despesas Administrativas;1000,00",
      "(-) Despesas Administrativas;-500,00",
    ].join("\r\n");
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "sinal.csv");
    expect(
      r.warnings.some((w) => w.includes('Conta "Despesas Administrativas"') && w.includes("positivos E negativos")),
    ).toBe(true);
    const linhas = r.planilha.linhas.filter((l) => l.conta === "DESPESA_ADMINISTRATIVA");
    expect(linhas[0].valores["Valor"]?.equals(D("1000"))).toBe(true);
    expect(linhas[1].valores["Valor"]?.equals(D("-500"))).toBe(true);
  });
});

// =============================================================================
// Planilha vazia
// =============================================================================

describe("parsePlanilha — planilha vazia", () => {
  it("arquivo de 0 bytes vira erro claro, sem lançar exceção", async () => {
    const r = await parsePlanilha(Buffer.from("", "utf8"), "vazio.csv");
    expect(r.errors).toEqual(["Arquivo vazio (0 bytes)."]);
    expect(r.planilha.tipo).toBe("NAO_IDENTIFICADO");
    expect(r.planilha.linhas).toEqual([]);
  });

  it("arquivo só com linhas em branco não quebra e avisa que não há nada para extrair", async () => {
    const r = await parsePlanilha(Buffer.from("\n\n\n", "utf8"), "vazio2.csv");
    expect(r.errors).toEqual([]);
    expect(r.warnings).toContain("Planilha sem nenhuma célula preenchida — nada para extrair.");
    expect(r.planilha.linhas).toEqual([]);
  });
});

// =============================================================================
// Folha de pagamento — detalhada (uma linha por funcionário) e resumo (rubricas)
// =============================================================================

describe("parsePlanilha — folha detalhada (uma linha por funcionário)", () => {
  const csv = [
    "Nome do Funcionário;Salário;INSS Patronal;FGTS;Pró-labore",
    "João da Silva;3000,00;660,00;240,00;0",
    "Maria Souza;4000,00;880,00;320,00;0",
    "Total;7000,00;1540,00;560,00;0",
    "Carlos Sem Valor;;;;",
  ].join("\r\n");

  it("classifica como FOLHA_DETALHADA e reconhece as 4 colunas pelo cabeçalho", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "folha.csv");
    expect(r.planilha.tipo).toBe("FOLHA_DETALHADA");
    expect(r.planilha.colunaDescricao).toBe("Nome do Funcionário");
    expect(r.planilha.colunasValor).toEqual(["Salário", "INSS Patronal", "FGTS", "Pró-labore"]);
  });

  it("exclui a linha 'Total' da contagem de empregados e soma só os funcionários", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "folha.csv");
    expect(r.planilha.folha?.numeroEmpregados).toBe(3); // João, Maria, Carlos — não o "Total"
    expect(r.planilha.folha?.totalProventos?.equals(D("7000"))).toBe(true); // 3000 + 4000, sem duplicar o Total
    expect(r.planilha.folha?.inssPatronal?.equals(D("1540"))).toBe(true);
    expect(r.planilha.folha?.fgts?.equals(D("560"))).toBe(true);
  });

  it("funcionário sem nenhum valor legível vira pendência, não é descartado nem vira zero", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "folha.csv");
    expect(r.planilha.folha?.linhasComPendencia).toBe(1);
    expect(r.planilha.pendencias).toHaveLength(1);
    expect(r.planilha.pendencias[0].descricaoOriginal).toBe("Carlos Sem Valor");
    expect(r.planilha.pendencias[0].valores).toEqual({});
  });
});

describe("parsePlanilha — folha resumo (rubricas em linha, mesmo motor do DRE)", () => {
  const csv = [
    "Rubrica;Valor",
    "Salários;7000,00",
    "INSS Patronal;1540,00",
    "FGTS;560,00",
    "Pró-labore;5000,00",
  ].join("\r\n");

  it("classifica como FOLHA_RESUMO e reconhece as 4 rubricas do Fator R", async () => {
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "folha-resumo.csv");
    expect(r.planilha.tipo).toBe("FOLHA_RESUMO");
    expect(r.planilha.totaisPorConta.SALARIO_PROVENTOS?.equals(D("7000"))).toBe(true);
    expect(r.planilha.totaisPorConta.INSS_PATRONAL?.equals(D("1540"))).toBe(true);
    expect(r.planilha.totaisPorConta.FGTS?.equals(D("560"))).toBe(true);
    expect(r.planilha.totaisPorConta.PRO_LABORE?.equals(D("5000"))).toBe(true);
    expect(r.planilha.pendencias).toEqual([]);
  });
});

// =============================================================================
// Limites técnicos — nunca truncar em silêncio
// =============================================================================

describe("parsePlanilha — limites técnicos de memória", () => {
  it("acima de maxBytes: erro claro, nada processado", async () => {
    const buf = Buffer.alloc(10, 0x41);
    const r = await parsePlanilha(buf, "pequeno.csv", { maxBytes: 5 });
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/10 bytes.*limite técnico de 5 bytes/);
  });

  it("acima de maxLinhas: erro claro e dados parciais marcados como tal, não escondidos", async () => {
    const csv = [
      "Descricao;Valor",
      "Receita Bruta;100,00",
      "(-) CMV;-10,00",
      "(-) Despesas Administrativas;-20,00",
      "(-) Despesas Comerciais;-5,00",
    ].join("\r\n");
    const r = await parsePlanilha(Buffer.from(csv, "utf8"), "limite.csv", { maxLinhas: 3 });
    expect(r.errors.some((e) => e.includes("limite técnico de 3 linhas") && e.includes("PARCIAIS"))).toBe(true);
    expect(r.planilha.linhas).toHaveLength(2);
  });
});

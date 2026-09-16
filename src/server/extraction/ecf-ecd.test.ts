import { describe, it, expect } from "vitest";
import { parseEcf } from "./ecf";
import { classificarConta, parseEcd } from "./ecd";
import { competenciaDoDebito } from "./dctf-mit";

const buf = (linhas: string[]) => Buffer.from(linhas.join("\r\n") + "\r\n", "latin1");

describe("DCTF — período dos códigos trimestrais", () => {
  it("lê o paDebito do IRPJ/CSLL trimestral como número do trimestre", () => {
    expect(competenciaDoDebito("012025", "337301")).toBe("2025-03");
    expect(competenciaDoDebito("042025", "601201")).toBe("2025-12");
    expect(competenciaDoDebito("022025", "208901")).toBe("2025-06");
  });
  it("mantém o mês nos códigos mensais", () => {
    expect(competenciaDoDebito("042025", "691201")).toBe("2025-04");
  });
  it("recusa trimestre inexistente", () => {
    expect(competenciaDoDebito("052025", "337301")).toBeUndefined();
  });
});

describe("parseEcf — Lucro Real trimestral", () => {
  const r = parseEcf(
    buf([
      "|0000|LECF|0012|12345678000199|EMPRESA TESTE LTDA|0|0|||01012025|31122025|N||0||",
      "|0010|HASH|N|1|T|01|RRRR|||||||",
      "|L030|01012025|31032025|T01|",
      "|L300|3.01.01.01.01|RECEITA BRUTA|S|5|04|3.01.01.01|100000,00|C|",
      "|N030|01012025|31032025|T01|",
      "|N630|1|BASE DE CALCULO DO IRPJ|10000,00|",
      "|N630|3|Aliquota de 15%|1500,00|",
      "|N630|4|Adicional|0,00|",
      "|N630|26|IMPOSTO DE RENDA A PAGAR|1500,00|",
      "|N670|1|BASE DE CALCULO DA CSLL|10000,00|",
      "|N670|4|TOTAL DA CSLL|900,00|",
      "|N670|21|CSLL A PAGAR|900,00|",
    ]),
  )!;

  it("identifica exercício e forma de tributação", () => {
    expect(r.cnpj).toBe("12345678000199");
    expect(r.exercicio).toBe(2025);
    expect(r.formaTributacao).toBe("LUCRO_REAL");
    expect(r.formaApuracao).toBe("T");
  });

  it("extrai IRPJ e CSLL a pagar pela linha do leiaute, com a receita do período", () => {
    const irpj = r.apuracoes.find((a) => a.tributo === "IRPJ")!;
    const csll = r.apuracoes.find((a) => a.tributo === "CSLL")!;
    expect(irpj.periodo).toBe("2025-03");
    expect(irpj.aPagar.toFixed(2)).toBe("1500.00");
    expect(irpj.baseCalculo.toFixed(2)).toBe("10000.00");
    expect(irpj.receitaBruta?.toFixed(2)).toBe("100000.00");
    expect(csll.aPagar.toFixed(2)).toBe("900.00");
  });
});

describe("parseEcf — Lucro Presumido", () => {
  const r = parseEcf(
    buf([
      "|0000|LECF|0012|12345678000199|EMPRESA TESTE LTDA|0|0|||01012025|31122025|N||0||",
      "|0010|HASH|N|5|T|01|PPPP||L||||2|",
      "|P030|01042025|30062025|T02|",
      "|P150|3.01.01.01.01|RECEITA BRUTA|S|5|04|3.01.01.01|50000,00|C|",
      "|P300|1|BASE DE CALCULO|4000,00|",
      "|P300|15|IMPOSTO DE RENDA A PAGAR|600,00|",
      "|P500|1|BASE DE CALCULO DA CSLL|6000,00|",
      "|P500|13|CSLL A PAGAR|540,00|",
    ]),
  )!;

  it("usa os registros P300 e P500", () => {
    expect(r.formaTributacao).toBe("LUCRO_PRESUMIDO");
    expect(r.apuracoes.map((a) => `${a.periodo} ${a.tributo} ${a.aPagar.toFixed(2)}`)).toEqual([
      "2025-06 IRPJ 600.00",
      "2025-06 CSLL 540.00",
    ]);
    expect(r.apuracoes[0].receitaBruta?.toFixed(2)).toBe("50000.00");
  });
});

describe("classificarConta", () => {
  it("usa o plano referencial quando existe", () => {
    expect(classificarConta("1.01.01.01.01", "QUALQUER NOME")).toBe("CAIXA");
    expect(classificarConta("1.01.01.02.01", "CAIXA ECONOMICA FEDERAL")).toBe("BANCO");
  });
  it("sem referencial, não confunde a Caixa Econômica com caixa", () => {
    expect(classificarConta(undefined, "CAIXA ECONOMICA FEDERAL C/C 1234")).toBe("BANCO");
    expect(classificarConta(undefined, "CAIXA GERAL")).toBe("CAIXA");
  });
});

describe("parseEcd", () => {
  const r = parseEcd(
    buf([
      "|0000|LECD|01012025|31122025|EMPRESA TESTE LTDA|12345678000199|GO|||",
      "|I050|01012025|01|A|6|1111|111|CAIXA|",
      "|I051||1.01.01.01.01|",
      "|I050|01012025|01|A|6|1112|111|CAIXA ECONOMICA FEDERAL|",
      "|I051||1.01.01.02.01|",
      "|I150|01012025|31012025|",
      "|I155|1111||100,00|D|50,00|400,00|250,00|C|",
      "|I155|1112||0|D|400,00|50,00|350,00|D|",
      "|I200|1|15012025|400,00|N||",
      "|I250|1112||400,00|D||||",
      "|I250|1111||400,00|C||||",
      "|J005|01012025|31032025|1||",
      "|J150|1|GRP.001|T|2|IND.001|RECEITA OPERACIONAL BRUTA|0|C|90000,00|C|R||",
    ]),
  )!;

  it("lê saldos com a classificação pelo referencial", () => {
    const caixa = r.saldos.find((s) => s.contaCodigo === "1111")!;
    const banco = r.saldos.find((s) => s.contaCodigo === "1112")!;
    expect(caixa.classificacao).toBe("CAIXA");
    expect(caixa.naturezaSaldo).toBe("C");
    expect(caixa.saldoFinal.toFixed(2)).toBe("250.00");
    expect(caixa.competencia).toBe("2025-01");
    expect(banco.classificacao).toBe("BANCO");
  });

  it("lê as partidas do lançamento", () => {
    expect(r.lancamentos).toHaveLength(2);
    expect(r.lancamentos[0]).toMatchObject({ numeroLancamento: "1", competencia: "2025-01", natureza: "D", contaCodigo: "1112" });
  });

  it("lê a DRE do leiaute 9 pelo valor do período", () => {
    expect(r.dre[0].descricao).toBe("RECEITA OPERACIONAL BRUTA");
    expect(r.dre[0].valor.toFixed(2)).toBe("90000.00");
    expect(r.dre[0].dataFim.toISOString().slice(0, 10)).toBe("2025-03-31");
  });
});

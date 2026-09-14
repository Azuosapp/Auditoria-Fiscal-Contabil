import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  apurarBaseCredito,
  classificarItem,
  type ItemParaCredito,
} from "./creditos-pis-cofins";

const D = (v: string) => new Prisma.Decimal(v);

function item(
  totalValue: string,
  cstPis?: string,
  extra: Partial<ItemParaCredito> = {},
): ItemParaCredito {
  return {
    totalValue: D(totalValue),
    cstPis,
    cstCofins: cstPis,
    ...extra,
  };
}

describe("classificação pelo CST do fornecedor", () => {
  it("tributado na origem gera crédito", () => {
    for (const cst of ["01", "02", "03"]) {
      expect(classificarItem(item("100", cst)).classificacao).toBe("CREDITAVEL");
    }
  });

  it("monofásico NÃO gera crédito — é o caso que mais distorce o Lucro Real", () => {
    const r = classificarItem(item("1000", "04"));
    expect(r.classificacao).toBe("NAO_CREDITAVEL");
    expect(r.motivo).toContain("monofásico");
  });

  it("alíquota zero, isenta, sem incidência e suspensão não geram crédito", () => {
    for (const cst of ["06", "07", "08", "09"]) {
      expect(classificarItem(item("100", cst)).classificacao).toBe("NAO_CREDITAVEL");
    }
  });

  it("substituição tributária não gera crédito de PIS/Cofins", () => {
    expect(classificarItem(item("100", "05")).classificacao).toBe("NAO_CREDITAVEL");
  });

  it('"outras operações" cai em verificar, não em creditável', () => {
    expect(classificarItem(item("100", "49")).classificacao).toBe("VERIFICAR");
    expect(classificarItem(item("100", "99")).classificacao).toBe("VERIFICAR");
  });

  it("CST de aquisição com direito a crédito (50 a 56) credita", () => {
    expect(classificarItem(item("100", "50")).classificacao).toBe("CREDITAVEL");
    expect(classificarItem(item("100", "56")).classificacao).toBe("CREDITAVEL");
  });

  it("item sem CST nenhum não é presumido creditável", () => {
    const r = classificarItem({ totalValue: D("100") });
    expect(r.classificacao).toBe("VERIFICAR");
  });

  it("fornecedor do Simples é sinalizado, não expurgado nem creditado", () => {
    const r = classificarItem({ totalValue: D("100"), cstCsosn: "102" });
    expect(r.classificacao).toBe("VERIFICAR");
    expect(r.motivo).toContain("Simples Nacional");
  });

  it("CST divergente entre PIS e Cofins vira alerta, não silêncio", () => {
    const r = classificarItem({
      totalValue: D("100"),
      cstPis: "01",
      cstCofins: "04",
    });
    expect(r.classificacao).toBe("VERIFICAR");
    expect(r.motivo).toContain("divergente");
  });

  it("CST com um dígito é normalizado", () => {
    expect(classificarItem(item("100", "1")).classificacao).toBe("CREDITAVEL");
    expect(classificarItem(item("100", "4")).classificacao).toBe("NAO_CREDITAVEL");
  });
});

describe("apuração da base de crédito", () => {
  it("separa creditável de não creditável e não soma o que não credita", () => {
    const r = apurarBaseCredito([
      item("10000", "01"), // tributado
      item("5000", "04"), // monofásico
      item("2000", "06"), // alíquota zero
      item("3000", "01"), // tributado
    ]);

    expect(r.creditavel.toString()).toBe("13000");
    expect(r.naoCreditavel.toString()).toBe("7000");
    expect(r.total.toString()).toBe("20000");
    expect(r.itensCreditaveis).toBe(2);
    expect(r.itensNaoCreditaveis).toBe(2);
  });

  it("o que exige verificação fica FORA do creditável — conservador de propósito", () => {
    const r = apurarBaseCredito([
      item("10000", "01"),
      { totalValue: D("4000"), cstCsosn: "102" },
    ]);

    expect(r.creditavel.toString()).toBe("10000");
    expect(r.verificar.toString()).toBe("4000");
    expect(r.alertas.some((a) => a.includes("conservador"))).toBe(true);
  });

  it("usar o total das entradas superestimaria o crédito em 35%", () => {
    // Exatamente o cenário que o campo manual do painel produzia.
    const itens = [
      item("13000", "01"),
      item("7000", "04"),
    ];
    const r = apurarBaseCredito(itens);
    const totalIngenuo = D("20000");

    expect(r.creditavel.toString()).toBe("13000");
    const diferenca = totalIngenuo.minus(r.creditavel).div(r.creditavel).mul(100);
    expect(diferenca.toFixed(0)).toBe("54"); // 7.000 sobre 13.000
  });

  it("proporção alta de não creditável vira alerta", () => {
    const r = apurarBaseCredito([item("3000", "01"), item("7000", "04")]);
    expect(r.alertas.some((a) => a.includes("monofásico"))).toBe(true);
  });

  it("motivos vêm ordenados do que mais pesa para o que menos pesa", () => {
    const r = apurarBaseCredito([
      item("1000", "01"),
      item("9000", "04"),
      item("5000", "06"),
    ]);
    expect(r.motivos[0].valor.toString()).toBe("9000");
    expect(r.motivos[0].motivo).toContain("monofásico");
    expect(r.motivos[1].valor.toString()).toBe("5000");
  });

  it("lista vazia não quebra", () => {
    const r = apurarBaseCredito([]);
    expect(r.creditavel.toString()).toBe("0");
    expect(r.alertas).toEqual([]);
  });

  it("item sem valor conta como zero, sem virar NaN", () => {
    const r = apurarBaseCredito([{ cstPis: "01" }, item("100", "01")]);
    expect(r.creditavel.toString()).toBe("100");
    expect(r.itensCreditaveis).toBe(2);
  });
});

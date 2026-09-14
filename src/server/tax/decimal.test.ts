import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { dec, sum, toCents, pctOf, effectiveLoadPct, ZERO } from "./decimal";

const D = (v: string) => new Prisma.Decimal(v);

describe("dec() — conversão sem passar por float", () => {
  it("converte string do XML preservando as casas decimais", () => {
    expect(dec("50.000000")?.toString()).toBe("50");
    expect(dec("1234.56")?.toString()).toBe("1234.56");
    expect(dec("0.0000001")?.toString()).toBe("1e-7");
  });

  it("aceita vírgula como separador decimal", () => {
    expect(dec("1234,56")?.equals(D("1234.56"))).toBe(true);
  });

  it("distingue ausência de zero", () => {
    expect(dec(undefined)).toBeUndefined();
    expect(dec(null)).toBeUndefined();
    expect(dec("")).toBeUndefined();
    expect(dec("   ")).toBeUndefined();
    expect(dec("abc")).toBeUndefined();
    // zero explícito é valor, não ausência
    expect(dec("0")?.isZero()).toBe(true);
  });
});

describe("o erro que a migração elimina", () => {
  it("float erra 0.1 + 0.2; Decimal não", () => {
    // Comportamento do `number`, que era o tipo usado antes:
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(0.1 + 0.2).toBeCloseTo(0.30000000000000004);

    // Com Decimal:
    expect(sum(D("0.1"), D("0.2")).equals(D("0.3"))).toBe(true);
  });

  it("soma 1.000 parcelas de R$ 0,01 e fecha exatamente em R$ 10,00", () => {
    const parcelas = Array.from({ length: 1000 }, () => D("0.01"));

    // Com float, o acumulado desvia do valor exato:
    const comFloat = parcelas.reduce((a, p) => a + Number(p.toString()), 0);
    expect(comFloat).not.toBe(10);

    // Com Decimal, fecha no centavo:
    expect(sum(...parcelas).equals(D("10"))).toBe(true);
  });

  it("preserva o centavo em valor de nota realista", () => {
    // Itens com centavos que, somados em float, produzem dízima binária.
    const itens = [D("1234.57"), D("89.13"), D("0.07"), D("4321.09")];
    expect(sum(...itens).toString()).toBe("5644.86");
  });
});

describe("toCents() — arredondamento HALF_UP da legislação", () => {
  it("arredonda meio para cima", () => {
    expect(toCents(D("1.005")).toString()).toBe("1.01");
    expect(toCents(D("2.675")).toString()).toBe("2.68");
    expect(toCents(D("1.004")).toString()).toBe("1");
  });

  it("float perde o centavo onde o Decimal acerta", () => {
    // Valores medidos em Node: v*100 cai abaixo do meio por dízima binária,
    // e Math.round arredonda para baixo — um centavo a menos por linha.
    // 1.005 * 100 === 100.49999999999999  → 1.00
    expect(Math.round(1.005 * 100) / 100).toBe(1);
    expect(toCents(D("1.005")).toString()).toBe("1.01");

    // 8.575 * 100 === 857.4999999999999   → 8.57
    expect(Math.round(8.575 * 100) / 100).toBe(8.57);
    expect(toCents(D("8.575")).toString()).toBe("8.58");

    // 1.015 * 100 === 101.49999999999999  → 1.01
    expect(Math.round(1.015 * 100) / 100).toBe(1.01);
    expect(toCents(D("1.015")).toString()).toBe("1.02");
  });
});

describe("pctOf() — percentual sobre base", () => {
  it("calcula ICMS interno de Goiás a 19%", () => {
    // Alíquota interna vigente desde 01.04.2024 (CTE art. 27, I).
    expect(pctOf(D("1000"), 19).toString()).toBe("190");
    expect(pctOf(D("1234.56"), 19).toString()).toBe("234.5664");
  });

  it("calcula PROTEGE do PROGOIÁS sobre o benefício (10/8/6)", () => {
    // Lei 20.787/2020, art. 11, I; Decreto 9.724/2020, art. 10, I.
    const beneficio = D("10000");
    expect(pctOf(beneficio, 10).toString()).toBe("1000"); // até o 12º mês
    expect(pctOf(beneficio, 8).toString()).toBe("800"); //  13º ao 24º
    expect(pctOf(beneficio, 6).toString()).toBe("600"); //  a partir do 25º
  });

  it("não arredonda no meio do caminho", () => {
    // 1/3 de 100 seguido de ×3 volta a 100 se não houver arredondamento intermediário.
    const terco = pctOf(D("100"), "33.333333333333333333333333");
    expect(toCents(terco.mul(3)).toString()).toBe("100");
  });
});

describe("effectiveLoadPct() — carga efetiva", () => {
  it("calcula pontos percentuais sobre a receita", () => {
    expect(effectiveLoadPct(D("190"), D("1000")).toString()).toBe("19");
  });

  it("devolve zero para receita zero ou negativa, sem dividir por zero", () => {
    expect(effectiveLoadPct(D("190"), ZERO).isZero()).toBe(true);
    expect(effectiveLoadPct(D("190"), D("-5")).isZero()).toBe(true);
  });
});

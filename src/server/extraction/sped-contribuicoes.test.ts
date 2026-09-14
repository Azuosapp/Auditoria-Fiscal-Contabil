import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { parseSpedContribuicoes } from "./sped-contribuicoes";

const D = (v: string) => new Prisma.Decimal(v);

/** Monta um "arquivo" SPED a partir de linhas já com os pipes de borda. */
function crlf(lines: string[]): Buffer {
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf8");
}

const FIXTURE_PATH = fileURLToPath(
  new URL("./fixtures/sped-contribuicoes-exemplo.txt", import.meta.url),
);

describe("parseSpedContribuicoes — arquivo bem formado (fixtures/sped-contribuicoes-exemplo.txt)", () => {
  const buffer = readFileSync(FIXTURE_PATH);
  const result = parseSpedContribuicoes(buffer);

  it("não gera erro nem warning além da codificação (a fixture só usa registros cobertos e fecha M200/M600)", () => {
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(["Codificação detectada: utf-8."]);
  });

  it("extrai a identificação do registro 0000", () => {
    expect(result.contribIdentification?.cnpj).toBe("12345678000199");
    expect(result.contribIdentification?.name).toBe("COMERCIO EXEMPLO LTDA");
    expect(result.contribIdentification?.uf).toBe("GO");
    expect(result.contribIdentification?.periodStart?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(result.contribIdentification?.periodEnd?.toISOString()).toBe(
      "2026-01-31T00:00:00.000Z",
    );
    expect(result.contribIdentification?.legalNatureCode).toBe("00");
    expect(result.contribIdentification?.legalNatureLabel).toBe(
      "Pessoa jurídica em geral (não participante de SCP como sócia ostensiva)",
    );
    expect(result.contribIdentification?.activityLabel).toBe("Atividade de comércio");
  });

  it("extrai o regime de apuração do registro 0110 (exclusivamente não-cumulativo, apropriação direta)", () => {
    expect(result.regimeApuracao?.incidenceCode).toBe("1");
    expect(result.regimeApuracao?.incidenceLabel).toBe(
      "Exclusivamente regime não-cumulativo",
    );
    expect(result.regimeApuracao?.creditMethodLabel).toBe(
      "Método de Apropriação Direta",
    );
    expect(result.regimeApuracao?.contributionTypeLabel).toBe(
      "Apuração da contribuição exclusivamente à alíquota básica",
    );
  });

  it("extrai o crédito de PIS (M100) com o detalhamento (M105) em Decimal", () => {
    expect(result.pis.credits).toHaveLength(1);
    const credito = result.pis.credits[0];
    expect(credito.creditCode).toBe("101");
    expect(credito.originLabel).toBe("Operações próprias");
    expect(credito.baseValue?.equals(D("1000"))).toBe(true);
    expect(credito.rate?.equals(D("1.65"))).toBe(true);
    expect(credito.creditValue?.equals(D("16.50"))).toBe(true);
    expect(credito.discountedCredit?.equals(D("16.50"))).toBe(true);
    expect(credito.balanceToCarry?.equals(D("0"))).toBe(true);

    expect(credito.details).toHaveLength(1);
    expect(credito.details[0].cst).toBe("50");
    expect(credito.details[0].description).toBe("Aquisicao de mercadoria para revenda");
    expect(credito.details[0].baseValue?.equals(D("1000"))).toBe(true);
  });

  it("extrai a consolidação de PIS (M200) com o detalhamento por código de contribuição (M210)", () => {
    const cons = result.pis.consolidation;
    expect(cons?.nonCumulativeContribution?.equals(D("82.50"))).toBe(true);
    expect(cons?.creditDiscountedCurrentPeriod?.equals(D("16.50"))).toBe(true);
    expect(cons?.nonCumulativeContributionDue?.equals(D("66.00"))).toBe(true);
    expect(cons?.nonCumulativeContributionToPay?.equals(D("66.00"))).toBe(true);
    expect(cons?.totalContributionToPay?.equals(D("66.00"))).toBe(true);

    expect(cons?.details).toHaveLength(1);
    expect(cons?.details[0].contributionCode).toBe("01");
    expect(cons?.details[0].contributionLabel).toBe(
      "Contribuição não-cumulativa apurada a alíquota básica",
    );
    expect(cons?.details[0].grossRevenue?.equals(D("5000"))).toBe(true);
    expect(cons?.details[0].contributionAssessed?.equals(D("82.50"))).toBe(true);
    expect(cons?.details[0].periodContribution?.equals(D("82.50"))).toBe(true);
  });

  it("extrai o crédito de Cofins (M500/M505) e a consolidação (M600/M610) simetricamente ao PIS", () => {
    expect(result.cofins.credits).toHaveLength(1);
    const credito = result.cofins.credits[0];
    expect(credito.baseValue?.equals(D("1000"))).toBe(true);
    expect(credito.rate?.equals(D("7.60"))).toBe(true);
    expect(credito.creditValue?.equals(D("76.00"))).toBe(true);

    const cons = result.cofins.consolidation;
    expect(cons?.nonCumulativeContribution?.equals(D("380.00"))).toBe(true);
    expect(cons?.nonCumulativeContributionDue?.equals(D("304.00"))).toBe(true);
    expect(cons?.totalContributionToPay?.equals(D("304.00"))).toBe(true);
    expect(cons?.details[0].periodContribution?.equals(D("380.00"))).toBe(true);
  });
});

describe("parseSpedContribuicoes — linha malformada, registro fora de escopo e M200 que não fecha com M210", () => {
  const buffer = crlf([
    "|0000|017|0|0||01012026|31012026|EMPRESA TESTE|11111111000191|GO|5208707||00|2|",
    "|0110|1|1|1||",
    "LINHA TOTALMENTE FORA DO PADRAO SEM PIPES",
    "|0111|1000,00|0,00|0,00|0,00|0,00|0,00|0,00|1000,00|",
    "|M200|100,00|0,00|0,00|100,00|0,00|0,00|100,00|0,00|0,00|0,00|0,00|100,00|",
    "|M210|01|3000,00|3000,00|0,00|0,00|3000,00|1,65|||50,00|0,00|0,00|0,00|0,00|50,00|",
  ]);

  const result = parseSpedContribuicoes(buffer);

  it("registra a linha malformada em warnings com o número da linha, sem gerar erro fatal", () => {
    expect(result.errors).toEqual([]);
    const warning = result.warnings.find((w) => w.startsWith("Linha 3:"));
    expect(warning).toBeDefined();
    expect(warning).toContain("ignorada");
  });

  it("resume em warnings o registro 0111 (fora do escopo deste parser), sem impedir a extração", () => {
    const resumo = result.warnings.find((w) => w.includes("0111"));
    expect(resumo).toBeDefined();
    expect(resumo).toContain("1 linha(s)");
  });

  it("aponta em warning quando a soma de VL_CONT_PER dos M210 não fecha com M200 (campos 02+09)", () => {
    const warning = result.warnings.find((w) => w.startsWith("Registro M200:"));
    expect(warning).toBeDefined();
    expect(warning).toContain("50.00");
    expect(warning).toContain("100.00");
    expect(warning).toContain("divergência de 50.00");
  });
});

describe("parseSpedContribuicoes — registros filho sem o pai aberto não derrubam o arquivo", () => {
  it("M105 sem M100 aberto antes vira warning, não erro", () => {
    const buffer = crlf([
      "|0000|017|0|0||01012026|31012026|EMPRESA TESTE|11111111000191|GO|5208707||00|2|",
      "|M105|01|50|1000,00|0,00|1000,00|1000,00|||Descricao|",
    ]);
    const result = parseSpedContribuicoes(buffer);
    expect(result.errors).toEqual([]);
    const warning = result.warnings.find((w) => w.includes("registro M105"));
    expect(warning).toBeDefined();
    expect(warning).toContain("M105 sem M100 aberto antes");
    expect(result.pis.credits).toEqual([]);
  });

  it("M210 sem M200 aberto antes vira warning, não erro", () => {
    const buffer = crlf([
      "|0000|017|0|0||01012026|31012026|EMPRESA TESTE|11111111000191|GO|5208707||00|2|",
      "|M210|01|3000,00|3000,00|0,00|0,00|3000,00|1,65|||50,00|0,00|0,00|0,00|0,00|50,00|",
    ]);
    const result = parseSpedContribuicoes(buffer);
    expect(result.errors).toEqual([]);
    const warning = result.warnings.find((w) => w.includes("registro M210"));
    expect(warning).toContain("M210 sem M200 aberto antes");
    expect(result.pis.consolidation).toBeUndefined();
  });
});

describe("parseSpedContribuicoes — linha truncada não derruba o arquivo, campo ausente vira undefined (nunca zero)", () => {
  it("M100 com poucos campos preenche só o que veio, sem lançar exceção", () => {
    const buffer = crlf([
      "|0000|017|0|0||01012026|31012026|EMPRESA TESTE|11111111000191|GO|5208707||00|2|",
      "|M100|101|0|1000,00|",
    ]);
    const result = parseSpedContribuicoes(buffer);
    expect(result.errors).toEqual([]);
    expect(result.pis.credits).toHaveLength(1);
    const credito = result.pis.credits[0];
    expect(credito.baseValue?.equals(D("1000"))).toBe(true);
    // Campos além da posição truncada: ausentes, não zero.
    expect(credito.rate).toBeUndefined();
    expect(credito.creditValue).toBeUndefined();
    expect(credito.balanceToCarry).toBeUndefined();
  });
});

describe("parseSpedContribuicoes — arquivo vazio", () => {
  it("gera erro explícito e não quebra", () => {
    const result = parseSpedContribuicoes(Buffer.from("", "utf8"));
    expect(result.errors).toEqual(["Arquivo vazio ou sem conteúdo legível."]);
    expect(result.pis.credits).toEqual([]);
    expect(result.cofins.credits).toEqual([]);
  });
});

describe("parseSpedContribuicoes — período/identificação ausente (sem registro 0000/0110)", () => {
  it("processa o restante do arquivo e avisa da ausência, sem erro fatal", () => {
    const buffer = crlf([
      "|M100|101|0|1000,00|1,65|||16,50|0,00|0,00|0,00|16,50|0|16,50|0,00|",
    ]);
    const result = parseSpedContribuicoes(buffer);
    expect(result.errors).toEqual([]);
    expect(
      result.warnings.some((w) => w.startsWith("Registro 0000 não encontrado")),
    ).toBe(true);
    expect(
      result.warnings.some((w) => w.startsWith("Registro 0110 não encontrado")),
    ).toBe(true);
    expect(result.pis.credits).toHaveLength(1);
  });
});

describe("parseSpedContribuicoes — CNPJ fora do padrão de 14 dígitos", () => {
  it("mantém o CNPJ como veio e registra warning, sem corrigir por conta própria", () => {
    const buffer = crlf([
      "|0000|017|0|0||01012026|31012026|EMPRESA TESTE|1111111000191|GO|5208707||00|2|",
    ]);
    const result = parseSpedContribuicoes(buffer);
    expect(result.contribIdentification?.cnpj).toBe("1111111000191");
    const warning = result.warnings.find((w) => w.includes("CNPJ do registro 0000"));
    expect(warning).toContain("13 dígitos");
  });
});

describe("parseSpedContribuicoes — campo decimal com vírgula", () => {
  it("converte '1000,00'-style (vírgula) direto para Decimal, sem passar por float", () => {
    const buffer = crlf([
      "|0000|017|0|0||01012026|31012026|EMPRESA VIRGULA|33333333000106|GO|5208707||00|2|",
      "|M500|101|0|1234,56|7,60|||93,82|0,00|0,00|0,00|93,82|0|93,82|0,00|",
    ]);
    const result = parseSpedContribuicoes(buffer);
    expect(result.cofins.credits[0].baseValue?.equals(D("1234.56"))).toBe(true);
    expect(result.cofins.credits[0].creditValue?.equals(D("93.82"))).toBe(true);
  });
});

describe("parseSpedContribuicoes — encoding ISO-8859-1/Windows-1252 com acento", () => {
  it("detecta Latin-1 automaticamente e preserva o acento do nome da empresa", () => {
    const nome = "JOSÉ COMÉRCIO E INDÚSTRIA LTDA";
    const line = `|0000|017|0|0||01012026|31012026|${nome}|44444444000107|GO|5208707||00|2|`;
    const buffer = Buffer.from(`${line}\r\n`, "latin1");

    // Confere que o texto realmente não é UTF-8 válido (senão o teste não provaria nada).
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(buffer)).toThrow();

    const result = parseSpedContribuicoes(buffer);
    expect(result.warnings[0]).toBe("Codificação detectada: latin1.");
    expect(result.contribIdentification?.name).toBe(nome);
  });
});

describe("parseSpedContribuicoes — registros fora do escopo são contados, não travam o arquivo", () => {
  it("resume em warnings os tipos de registro não implementados (ex.: C100/A100, fora de escopo nesta rodada)", () => {
    const buffer = crlf([
      "|0000|017|0|0||01012026|31012026|EMPRESA COM REGISTROS FORA DE ESCOPO|55555555000108|GO|5208707||00|2|",
      "|C100|0|0|||55|00|1|1001||01012026|01012026|100,00|0|0,00|0,00|100,00|0|",
      "|C100|1|0|||55|00|1|1002||02012026|02012026|200,00|0|0,00|0,00|200,00|0|",
    ]);
    const result = parseSpedContribuicoes(buffer);
    expect(result.invoices).toEqual([]);
    const resumo = result.warnings.find((w) => w.includes("C100"));
    expect(resumo).toBeDefined();
    expect(resumo).toContain("2 linha(s)");
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Prisma } from "@prisma/client";
import { parseSpedEfd } from "./sped";
import { isValidAccessKey, computeAccessKeyCheckDigit } from "./access-key";
import { decodeTextBuffer } from "./encoding";

const D = (v: string) => new Prisma.Decimal(v);

/** Monta um "arquivo" SPED a partir de linhas já com os pipes de borda. */
function crlf(lines: string[]): Buffer {
  return Buffer.from(lines.join("\r\n") + "\r\n", "utf8");
}

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../fixtures/sped-exemplo.txt", import.meta.url),
);

describe("parseSpedEfd — arquivo bem formado (fixtures/sped-exemplo.txt)", () => {
  const buffer = readFileSync(FIXTURE_PATH);
  const result = parseSpedEfd(buffer);

  it("não gera erro nem aponta registro fora de escopo (a fixture só usa registros cobertos)", () => {
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual(["Codificação detectada: utf-8."]);
  });

  it("extrai a identificação do registro 0000", () => {
    expect(result.identification?.cnpj).toBe("12345678000199");
    expect(result.identification?.name).toBe("MERCADO CENTRAL LTDA");
    expect(result.identification?.uf).toBe("GO");
    expect(result.identification?.periodStart?.toISOString()).toBe(
      "2026-01-01T00:00:00.000Z",
    );
    expect(result.identification?.periodEnd?.toISOString()).toBe(
      "2026-01-31T00:00:00.000Z",
    );
  });

  it("extrai as duas notas (C100) com direção, participante e valores em Decimal", () => {
    expect(result.invoices).toHaveLength(2);
    const [entrada, saida] = result.invoices;

    expect(entrada.direction).toBe("ENTRADA");
    expect(entrada.model).toBe("NFE");
    expect(entrada.accessKey).toBe(
      "52260198765432000188550010000010011123456788",
    );
    expect(entrada.emitCnpj).toBe("98765432000188"); // participante FORN001 (0150)
    expect(entrada.destDoc).toBe("12345678000199"); // a própria empresa (0000)
    expect(entrada.destUf).toBe("GO");
    expect(entrada.totalIcms?.equals(D("190"))).toBe(true);
    expect(entrada.situationCode).toBe("00");
    expect(entrada.situationLabel).toBe("Documento regular");

    expect(saida.direction).toBe("SAIDA");
    expect(saida.emitCnpj).toBe("12345678000199"); // emissão própria
    expect(saida.emitUf).toBe("GO");
    expect(saida.destDoc).toBe("11222333000144"); // participante CLI001
    expect(saida.totalIcms?.equals(D("285"))).toBe(true);
  });

  it("valida a chave de acesso (DV) das duas notas", () => {
    expect(isValidAccessKey(result.invoices[0].accessKey)).toBe(true);
    expect(isValidAccessKey(result.invoices[1].accessKey)).toBe(true);
  });

  it("enriquece o item (C170) com NCM e descrição vindos do 0200 pelo COD_ITEM", () => {
    const item = result.invoices[0].items[0];
    expect(item.ncm).toBe("73181500");
    expect(item.description).toBe("PARAFUSO SEXTAVADO M8");
    expect(item.cfop).toBe("1102");
    expect(item.quantity?.equals(D("100"))).toBe(true);
    expect(item.totalValue?.equals(D("1000"))).toBe(true);
    expect(item.icmsValue?.equals(D("190"))).toBe(true);
    expect(item.pisValue?.equals(D("16.5"))).toBe(true);
    expect(item.cofinsValue?.equals(D("76"))).toBe(true);
  });

  it("propaga a UF conhecida (da própria empresa) para o item", () => {
    // Entrada: UF do fornecedor é desconhecida (0150 não traz UF) — só o destino é certo.
    expect(result.invoices[0].items[0].ufOrigin).toBeUndefined();
    expect(result.invoices[0].items[0].ufDestination).toBe("GO");
    // Saída: a origem é a própria empresa.
    expect(result.invoices[1].items[0].ufOrigin).toBe("GO");
  });

  it("extrai o analítico C190 associado à nota de saída", () => {
    const [, saida] = result.invoices;
    expect(saida.analytics).toHaveLength(1);
    expect(saida.analytics?.[0].cfop).toBe("5102");
    expect(saida.analytics?.[0].icmsValue?.equals(D("285"))).toBe(true);
  });

  it("extrai a apuração (E100/E110) com o campo 11 (VL_SLD_APURADO) em destaque", () => {
    expect(result.apuracoes).toHaveLength(1);
    const apuracao = result.apuracoes[0];
    expect(apuracao.periodStart?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(apuracao.periodEnd?.toISOString()).toBe("2026-01-31T00:00:00.000Z");
    expect(apuracao.totalDebits?.equals(D("285"))).toBe(true);
    expect(apuracao.totalCredits?.equals(D("190"))).toBe(true);
    // Campo 11 — origem da média do PROGOIÁS (Decreto 9.724/2020, art. 9º).
    expect(apuracao.assessedBalance?.equals(D("95"))).toBe(true);
    expect(apuracao.icmsToPay?.equals(D("95"))).toBe(true);
  });

  it("extrai ajustes (E111) e informações adicionais (E115) da apuração", () => {
    const apuracao = result.apuracoes[0];
    expect(apuracao.adjustments).toHaveLength(1);
    expect(apuracao.adjustments[0]).toMatchObject({
      code: "GO020158",
      complementaryDescription: "Credito outorgado PROGOIAS",
    });
    expect(apuracao.adjustments[0].value?.equals(D("64.60"))).toBe(true);

    expect(apuracao.additionalInfo).toHaveLength(2);
    expect(apuracao.additionalInfo[0].code).toBe("GO100002"); // ICMS saídas incentivadas
    expect(apuracao.additionalInfo[1].code).toBe("GO100003"); // ICMS entradas incentivadas
    expect(apuracao.additionalInfo[0].value?.equals(D("285"))).toBe(true);
  });
});

describe("parseSpedEfd — linha malformada não derruba o arquivo", () => {
  const buffer = crlf([
    "|0000|015|0|01012026|31012026|EMPRESA TESTE|11111111000191||GO|101234567|5208707|||A|0|",
    "LINHA TOTALMENTE FORA DO PADRAO SEM PIPES",
    "|C100|1|0||55|00|1|3001||15012026|15012026|500,00|0|0,00|0,00|500,00|9|0,00|0,00|0,00|500,00|95,00|0,00|0,00|0,00|8,25|38,00|0,00|0,00|",
    "|C170|1|PROD001||10,0000|UN|500,00|0,00|0|00|5102||500,00|19,00|95,00|0,00|0,00|0,00|0|||0,00|0,00|0,00|01|500,00|1,65||0,00|8,25|01|500,00|7,60||0,00|38,00||0,00|",
  ]);

  const result = parseSpedEfd(buffer);

  it("registra a linha malformada em warnings com o número da linha, sem gerar erro fatal", () => {
    expect(result.errors).toEqual([]);
    const warning = result.warnings.find((w) => w.startsWith("Linha 2:"));
    expect(warning).toBeDefined();
    expect(warning).toContain("ignorada");
  });

  it("continua processando o restante do arquivo após a linha ruim", () => {
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].items).toHaveLength(1);
    expect(result.invoices[0].totalIcms?.equals(D("95"))).toBe(true);
  });
});

describe("parseSpedEfd — arquivo sem Bloco E (sem apuração)", () => {
  const buffer = crlf([
    "|0000|015|0|01012026|31012026|EMPRESA SEM BLOCO E|22222222000105||GO|101234567|5208707|||A|0|",
    "|C100|1|0||55|00|1|4001||20012026|20012026|100,00|0|0,00|0,00|100,00|9|0,00|0,00|0,00|100,00|19,00|0,00|0,00|0,00|1,65|7,60|0,00|0,00|",
  ]);

  const result = parseSpedEfd(buffer);

  it("processa normalmente e devolve apuracoes vazio, sem erro", () => {
    expect(result.errors).toEqual([]);
    expect(result.apuracoes).toEqual([]);
    expect(result.invoices).toHaveLength(1);
  });
});

describe("parseSpedEfd — campo decimal com vírgula", () => {
  it("converte '1.234,56'-style (vírgula) direto para Decimal, sem passar por float", () => {
    const buffer = crlf([
      "|0000|015|0|01012026|31012026|EMPRESA VIRGULA|33333333000106||GO|101234567|5208707|||A|0|",
      "|C100|1|0||55|00|1|5001||25012026|25012026|1234,56|0|0,00|0,00|1234,56|9|0,00|0,00|0,00|1234,56|234,5664|0,00|0,00|0,00|20,37|93,82|0,00|0,00|",
    ]);
    const result = parseSpedEfd(buffer);
    expect(result.invoices[0].totalInvoice?.equals(D("1234.56"))).toBe(true);
    expect(result.invoices[0].totalIcms?.equals(D("234.5664"))).toBe(true);
  });
});

describe("parseSpedEfd — encoding ISO-8859-1/Windows-1252 com acento", () => {
  it("detecta Latin-1 automaticamente e preserva o acento do nome da empresa", () => {
    const nome = "JOSÉ COMÉRCIO E INDÚSTRIA LTDA";
    const line =
      `|0000|015|0|01012026|31012026|${nome}|44444444000107||GO|101234567|5208707|||A|0|`;
    const buffer = Buffer.from(`${line}\r\n`, "latin1");

    // Confere que o texto realmente não é UTF-8 válido (senão o teste não provaria nada).
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(buffer)).toThrow();

    const result = parseSpedEfd(buffer);
    expect(result.warnings[0]).toBe("Codificação detectada: latin1.");
    expect(result.identification?.name).toBe(nome);
  });

  it("decodeTextBuffer(): detecta utf-8 e latin1 corretamente", () => {
    const acentuado = "AÇÃO ÉÐÑ";
    const utf8 = decodeTextBuffer(Buffer.from(acentuado, "utf8"));
    expect(utf8.encoding).toBe("utf-8");
    expect(utf8.text).toBe(acentuado);

    const latin1Buffer = Buffer.from(acentuado, "latin1");
    const latin1 = decodeTextBuffer(latin1Buffer);
    expect(latin1.encoding).toBe("latin1");
    expect(latin1.text).toBe(acentuado);
  });

  it("respeita o encoding informado (forced), sem tentar detectar", () => {
    const buffer = Buffer.from("café", "latin1");
    const decoded = decodeTextBuffer(buffer, "latin1");
    expect(decoded.forced).toBe(true);
    expect(decoded.text).toBe("café");
  });
});

describe("parseSpedEfd — registros fora do escopo são contados, não travam o arquivo", () => {
  it("resume em warnings os tipos de registro não implementados, sem impedir a extração", () => {
    const buffer = crlf([
      "|0000|015|0|01012026|31012026|EMPRESA COM REGISTROS FORA DE ESCOPO|55555555000108||GO|101234567|5208707|||A|0|",
      "|0190|UN|UNIDADE|",
      "|0190|KG|QUILOGRAMA|",
      "|C100|1|0||55|00|1|6001||28012026|28012026|10,00|0|0,00|0,00|10,00|9|0,00|0,00|0,00|10,00|1,90|0,00|0,00|0,00|0,17|0,76|0,00|0,00|",
    ]);
    const result = parseSpedEfd(buffer);
    expect(result.invoices).toHaveLength(1);
    const resumo = result.warnings.find((w) => w.includes("0190"));
    expect(resumo).toBeDefined();
    expect(resumo).toContain("2 linha(s)");
  });
});

describe("access-key — dígito verificador (módulo 11)", () => {
  it("calcula o DV da chave usada na fixture e confere com o dígito real", () => {
    const chave = "52260198765432000188550010000010011123456788";
    expect(computeAccessKeyCheckDigit(chave.slice(0, 43))).toBe(
      Number(chave[43]),
    );
    expect(isValidAccessKey(chave)).toBe(true);
  });

  it("rejeita chave com DV alterado", () => {
    const chave = "52260198765432000188550010000010011123456780"; // último dígito trocado
    expect(isValidAccessKey(chave)).toBe(false);
  });

  it("rejeita chave fora do formato (não numérica ou tamanho errado)", () => {
    expect(isValidAccessKey("123")).toBe(false);
    expect(isValidAccessKey("ABCD1234567890123456789012345678901234567890")).toBe(
      false,
    );
    expect(isValidAccessKey(undefined)).toBe(false);
  });
});

/**
 * Regressão de 15/09/2026: o C170 era lido sem os CST de PIS e COFINS.
 *
 * O parser pegava os VALORES (campos 30 e 36) mas não os CST (campos 25 e 31).
 * Sem eles, não há como saber se a entrada dá direito a crédito — CST 04
 * (monofásico), 05 (ST), 06 (alíquota zero), 07, 08 e 09 não geram crédito
 * algum. A regra de crédito indevido nunca disparava sobre dados de SPED, e o
 * falso negativo só apareceu quando alguém pediu um exemplo que o sistema
 * deveria ter encontrado.
 *
 * Linha conferida campo a campo contra um SPED real.
 */
describe("C170 — CST de PIS e COFINS", () => {
  const SPED =
    "|0000|015|0|01012026|31012026|INDUSTRIA X|12345678000199||GO|1234|5208707|||A|0|\n" +
    "|0200|575|CT 03 150X1945|||UN|00|73181500||||\n" +
    "|C100|0|1|F1|55|00|1|1001|52260112345678000199550010000010011|05012026|05012026|809,16|\n" +
    "|C170|1|575|CT 03 150X1945 IDEAL|613|UN|809,16|0|0|020|1101|1102|425,87|19|80,92|0|0|0|1|00||809,16|15|121,37|50|728,24|1,65|0|0|12,02|50|728,24|7,6|0|0|55,35|100000|0|\n" +
    "|C170|2|576|PRODUTO MONOFASICO|10|UN|500,00|0|0|040|1101|1102|0|0|0|0|0|0|1|53||0|0|0|04|0|0|0|0|0|06|0|0|0|0|0|100000|0|\n";

  const resultado = parseSpedEfd(Buffer.from(SPED, "latin1"));
  const itens = resultado.invoices[0]?.items ?? [];

  it("lê o CST de PIS do campo 25 e o de COFINS do campo 31", () => {
    expect(itens[0]?.cstPis).toBe("50");
    expect(itens[0]?.cstCofins).toBe("50");
  });

  it("distingue o item que não gera crédito", () => {
    // CST 04 (monofásico) no PIS e 06 (alíquota zero) na COFINS.
    expect(itens[1]?.cstPis).toBe("04");
    expect(itens[1]?.cstCofins).toBe("06");
  });

  it("não confunde o CST com o valor do tributo", () => {
    // O erro anterior era ler só os valores; os dois têm de vir corretos e
    // separados, senão a regra de crédito compara a coisa errada.
    expect(itens[0]?.pisValue?.toFixed(2)).toBe("12.02");
    expect(itens[0]?.cofinsValue?.toFixed(2)).toBe("55.35");
  });

  it("traz o NCM do cadastro do produto (registro 0200)", () => {
    // O NCM não está no C170: vem do 0200, pelo código do item. É o que
    // permite dizer QUAL produto no relatório.
    expect(itens[0]?.ncm).toBe("73181500");
  });
});

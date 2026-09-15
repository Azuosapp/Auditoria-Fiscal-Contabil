import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseApuracaoDctf, ehApuracaoDctf } from "./dctf-mit";
import { classificar } from "./classificar";

/**
 * A fixture reproduz a estrutura de um arquivo real de contribuinte — mesmos
 * elementos, mesma ordem, mesmos códigos de receita —, com CNPJ, CPF, nome e
 * e-mail substituídos por dados fictícios. Arquivo de cliente não entra no
 * repositório.
 */
const FIXTURE = fileURLToPath(
  new URL("./fixtures/dctf-mit-exemplo.xml", import.meta.url),
);

describe("parseApuracaoDctf", () => {
  const buffer = readFileSync(FIXTURE);
  const r = parseApuracaoDctf(buffer)!;

  it("reconhece o arquivo pelo elemento raiz", () => {
    expect(ehApuracaoDctf(buffer.toString("latin1"))).toBe(true);
    expect(ehApuracaoDctf("<nfeProc><NFe/></nfeProc>")).toBe(false);
  });

  it("é classificado como DCTF pelo conteúdo, não pelo nome do arquivo", () => {
    const c = classificar(buffer, "qualquer-nome.xml");
    expect(c.tipo).toBe("DCTF");
    expect(c.seguro).toBe(true);
  });

  it("extrai o contribuinte e a competência da apuração", () => {
    expect(r.cnpj).toBe("12345678000199");
    expect(r.competencia).toBe("2025-06");
  });

  it("extrai os três débitos confessados, com o código de receita preservado", () => {
    expect(r.debitos).toHaveLength(3);
    expect(r.debitos.map((d) => d.codigoReceita)).toEqual([
      "512301",
      "691201",
      "585601",
    ]);
  });

  it("nomeia o tributo pelos quatro primeiros dígitos do código", () => {
    // Confirmados na tabela de códigos da DCTF publicada pela Receita Federal.
    expect(r.debitos[0].tributo).toBe("IPI"); // 5123/01 — demais produtos
    expect(r.debitos[1].tributo).toBe("PIS"); // 6912 — não cumulativo
    expect(r.debitos[2].tributo).toBe("COFINS"); // 5856 — não cumulativa
  });

  it("lê o valor com ponto decimal sem passar por float", () => {
    expect(r.debitos[0].valor.toFixed(2)).toBe("2795.48");
    expect(r.debitos[1].valor.toFixed(2)).toBe("2259.52");
    expect(r.debitos[2].valor.toFixed(2)).toBe("10407.48");
    expect(r.total.toFixed(2)).toBe("15462.48");
  });

  it("grava a competência de cada débito, não a do cabeçalho", () => {
    expect(r.debitos.every((d) => d.competencia === "2025-06")).toBe(true);
  });

  it("não emite aviso para o arquivo bem formado", () => {
    expect(r.avisos).toEqual([]);
  });
});

describe("parseApuracaoDctf — casos que o leiaute permite", () => {
  const envolver = (miolo: string) =>
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><ApuracaoDebitosDctf>${miolo}</ApuracaoDebitosDctf>`,
      "utf8",
    );

  it("devolve null para XML que não é DCTF", () => {
    expect(parseApuracaoDctf(Buffer.from("<nfeProc/>", "utf8"))).toBeNull();
  });

  it("aceita um único débito (fast-xml-parser não devolve array nesse caso)", () => {
    const r = parseApuracaoDctf(
      envolver(
        `<DadosIdentificadoresContribuinte><inscContrib>12345678000199</inscContrib>` +
          `<perApuracao>012026</perApuracao></DadosIdentificadoresContribuinte>` +
          `<DebitosApurados><DebitoApurado><codTrib>691201</codTrib>` +
          `<ctValor>100.00</ctValor><paDebito>012026</paDebito></DebitoApurado></DebitosApurados>`,
      ),
    )!;
    expect(r.debitos).toHaveLength(1);
    expect(r.debitos[0].tributo).toBe("PIS");
    expect(r.total.toFixed(2)).toBe("100.00");
  });

  it("usa a competência do débito quando ela difere da apuração, e avisa", () => {
    const r = parseApuracaoDctf(
      envolver(
        `<DadosIdentificadoresContribuinte><inscContrib>12345678000199</inscContrib>` +
          `<perApuracao>032026</perApuracao></DadosIdentificadoresContribuinte>` +
          `<DebitosApurados><DebitoApurado><codTrib>585601</codTrib>` +
          `<ctValor>50.00</ctValor><paDebito>012026</paDebito></DebitoApurado></DebitosApurados>`,
      ),
    )!;
    expect(r.competencia).toBe("2026-03");
    expect(r.debitos[0].competencia).toBe("2026-01");
    expect(r.avisos.some((a) => a.includes("diferente da apuração"))).toBe(true);
  });

  it("preserva o código desconhecido em vez de chamá-lo de 'outros'", () => {
    const r = parseApuracaoDctf(
      envolver(
        `<DadosIdentificadoresContribuinte><inscContrib>12345678000199</inscContrib>` +
          `<perApuracao>012026</perApuracao></DadosIdentificadoresContribuinte>` +
          `<DebitosApurados><DebitoApurado><codTrib>999901</codTrib>` +
          `<ctValor>10.00</ctValor></DebitoApurado></DebitosApurados>`,
      ),
    )!;
    expect(r.debitos[0].tributo).toBe("Código 9999");
    expect(r.debitos[0].valor.toFixed(2)).toBe("10.00");
    expect(r.avisos.some((a) => a.includes("999901"))).toBe(true);
  });

  it("avisa quando a apuração não confessa débito nenhum", () => {
    const r = parseApuracaoDctf(
      envolver(
        `<DadosIdentificadoresContribuinte><inscContrib>12345678000199</inscContrib>` +
          `<perApuracao>012026</perApuracao></DadosIdentificadoresContribuinte>`,
      ),
    )!;
    expect(r.debitos).toEqual([]);
    expect(r.avisos).toContain("Nenhum débito confessado neste arquivo.");
  });

  it("ignora o débito sem valor legível, sem derrubar os demais", () => {
    const r = parseApuracaoDctf(
      envolver(
        `<DadosIdentificadoresContribuinte><inscContrib>12345678000199</inscContrib>` +
          `<perApuracao>012026</perApuracao></DadosIdentificadoresContribuinte>` +
          `<DebitosApurados>` +
          `<DebitoApurado><codTrib>691201</codTrib><ctValor>1.234,56</ctValor></DebitoApurado>` +
          `<DebitoApurado><codTrib>585601</codTrib><ctValor>20.00</ctValor></DebitoApurado>` +
          `</DebitosApurados>`,
      ),
    )!;
    expect(r.debitos).toHaveLength(1);
    expect(r.debitos[0].tributo).toBe("COFINS");
    expect(r.avisos.some((a) => a.includes("sem valor legível"))).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseNfeXml } from "./nfe-xml";
import { apurarBaseCredito } from "@/server/tax/creditos-pis-cofins";

/**
 * Extração do CST de PIS/Cofins e o expurgo do crédito que ele destrava.
 *
 * Este teste vai do XML até o número que entra no comparativo de regimes — é o
 * caminho que antes exigia o usuário calcular o expurgo por fora e digitar.
 */

const FIXTURE = join(process.cwd(), "fixtures", "nfe-exemplo.xml");

/** NF-e mínima com um item por CST informado. */
function nfeCom(itens: Array<{ vProd: string; cstPisCofins: string }>): string {
  const dets = itens
    .map(
      (it, i) => `
      <det nItem="${i + 1}">
        <prod>
          <cProd>P${i + 1}</cProd>
          <xProd>Item ${i + 1}</xProd>
          <NCM>22030000</NCM>
          <CFOP>1102</CFOP>
          <qCom>1.0000</qCom>
          <vUnCom>${it.vProd}</vUnCom>
          <vProd>${it.vProd}</vProd>
        </prod>
        <imposto>
          <ICMS><ICMS00><orig>0</orig><CST>00</CST><vBC>${it.vProd}</vBC><vICMS>0.00</vICMS></ICMS00></ICMS>
          <PIS><PISAliq><CST>${it.cstPisCofins}</CST><vBC>${it.vProd}</vBC><vPIS>0.00</vPIS></PISAliq></PIS>
          <COFINS><COFINSAliq><CST>${it.cstPisCofins}</CST><vBC>${it.vProd}</vBC><vCOFINS>0.00</vCOFINS></COFINSAliq></COFINS>
        </imposto>
      </det>`,
    )
    .join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe><infNFe Id="NFe52260800000000000000550010000000011000000015" versao="4.00">
    <ide><cUF>52</cUF><nNF>1</nNF><serie>1</serie><dhEmi>2026-08-01T10:00:00-03:00</dhEmi><tpNF>0</tpNF></ide>
    <emit><CNPJ>11222333000181</CNPJ><xNome>Fornecedor Ltda</xNome><enderEmit><UF>GO</UF></enderEmit></emit>
    <dest><CNPJ>19131243000197</CNPJ><xNome>Cliente Ltda</xNome><enderDest><UF>GO</UF></enderDest></dest>
    ${dets}
    <total><ICMSTot><vProd>0.00</vProd><vNF>0.00</vNF><vICMS>0.00</vICMS></ICMSTot></total>
  </infNFe></NFe>
</nfeProc>`;
}

describe("extração do CST de PIS/Cofins", () => {
  it("lê o CST dos dois tributos na fixture real do projeto", () => {
    const xml = readFileSync(FIXTURE, "utf8");
    const r = parseNfeXml(xml, "SAIDA");

    expect(r.invoices).toHaveLength(1);
    const itens = r.invoices[0].items;
    expect(itens.length).toBeGreaterThan(0);
    for (const it of itens) {
      expect(it.cstPis).toBe("01");
      expect(it.cstCofins).toBe("01");
    }
  });

  it("preserva a origem da mercadoria", () => {
    const xml = readFileSync(FIXTURE, "utf8");
    const r = parseNfeXml(xml, "SAIDA");
    expect(r.invoices[0].items[0].origem).toBe("0");
  });

  it("lê o CST também no grupo PISNT, que não tem valor", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<nfeProc xmlns="http://www.portalfiscal.inf.br/nfe">
  <NFe><infNFe Id="NFe52260800000000000000550010000000011000000015" versao="4.00">
    <ide><cUF>52</cUF><nNF>1</nNF><dhEmi>2026-08-01T10:00:00-03:00</dhEmi><tpNF>0</tpNF></ide>
    <emit><CNPJ>11222333000181</CNPJ><xNome>F</xNome><enderEmit><UF>GO</UF></enderEmit></emit>
    <dest><CNPJ>19131243000197</CNPJ><xNome>C</xNome><enderDest><UF>GO</UF></enderDest></dest>
    <det nItem="1"><prod><xProd>X</xProd><CFOP>1102</CFOP><vProd>100.00</vProd></prod>
      <imposto>
        <PIS><PISNT><CST>07</CST></PISNT></PIS>
        <COFINS><COFINSNT><CST>07</CST></COFINSNT></COFINS>
      </imposto>
    </det>
    <total><ICMSTot><vProd>100.00</vProd><vNF>100.00</vNF></ICMSTot></total>
  </infNFe></NFe>
</nfeProc>`;
    const r = parseNfeXml(xml, "ENTRADA");
    expect(r.invoices[0].items[0].cstPis).toBe("07");
  });
});

describe("do XML ao crédito de PIS/Cofins", () => {
  it("expurga o monofásico e credita só o tributado", () => {
    const xml = nfeCom([
      { vProd: "10000.00", cstPisCofins: "01" }, // tributado
      { vProd: "7000.00", cstPisCofins: "04" }, // monofásico (bebida fria)
      { vProd: "3000.00", cstPisCofins: "06" }, // alíquota zero
    ]);
    const r = parseNfeXml(xml, "ENTRADA", { cnpjEmpresa: "19131243000197" });
    const itens = r.invoices[0].items.map((it) => ({
      totalValue: it.totalValue ?? null,
      cstPis: it.cstPis ?? null,
      cstCofins: it.cstCofins ?? null,
    }));

    const base = apurarBaseCredito(itens);

    expect(base.creditavel.toString()).toBe("10000");
    expect(base.naoCreditavel.toString()).toBe("10000");
    expect(base.total.toString()).toBe("20000");

    // O comportamento anterior usaria as 20.000 inteiras como base de crédito —
    // o dobro do correto, e o Lucro Real sairia barato demais.
    expect(base.creditavel.toString()).not.toBe("20000");
  });

  it("distribuidora de bebida: quase nada credita, e o alerta aparece", () => {
    const xml = nfeCom([
      { vProd: "1000.00", cstPisCofins: "01" },
      { vProd: "19000.00", cstPisCofins: "04" },
    ]);
    const r = parseNfeXml(xml, "ENTRADA", { cnpjEmpresa: "19131243000197" });
    const base = apurarBaseCredito(
      r.invoices[0].items.map((it) => ({
        totalValue: it.totalValue ?? null,
        cstPis: it.cstPis ?? null,
        cstCofins: it.cstCofins ?? null,
      })),
    );

    expect(base.creditavel.toString()).toBe("1000");
    expect(base.alertas.some((a) => a.includes("monofásico"))).toBe(true);
  });
});

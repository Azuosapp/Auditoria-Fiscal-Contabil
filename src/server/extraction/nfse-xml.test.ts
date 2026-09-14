import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import { parseNfseXml } from "./nfse-xml";

const D = (v: string) => new Prisma.Decimal(v);

/**
 * Todas as datas com timezone (-03:00) para o `.toISOString()` esperado não
 * depender do fuso do host rodando o teste. Valores conferidos com
 * `new Date(...).toISOString()` antes de escrever a asserção (protocolo
 * "calcular antes de afirmar") — ver comando/saída no relatório de
 * importação desta tarefa:
 *   2026-08-05T09:30:00-03:00 => 2026-08-05T12:30:00.000Z
 *   2026-08-06T08:00:00-03:00 => 2026-08-06T11:00:00.000Z
 *   2026-08-05T14:00:00-03:00 => 2026-08-05T17:00:00.000Z
 *   2026-07-10T10:00:00-03:00 => 2026-07-10T13:00:00.000Z
 */

// ---------------------------------------------------------------------------
// Padrão Nacional da NFS-e (Sefin Nacional / ADN) — leiaute confirmado em
// NFSe_v1.01.xsd + tiposComplexos_v1.01.xsd (ver cabeçalho de nfse-xml.ts).
// ---------------------------------------------------------------------------

const NACIONAL_NORMAL = `<?xml version="1.0" encoding="UTF-8"?>
<NFSe versao="1.01" xmlns="http://www.sped.fazenda.gov.br/nfse">
  <infNFSe Id="NFS12345678901234567890123456789012345678901234567890">
    <xLocEmi>Goiânia</xLocEmi>
    <xLocPrestacao>Goiânia</xLocPrestacao>
    <nNFSe>11</nNFSe>
    <cLocIncid>5208707</cLocIncid>
    <xLocIncid>Goiânia</xLocIncid>
    <xTribNac>Consultoria</xTribNac>
    <verAplic>1.0.0</verAplic>
    <ambGer>1</ambGer>
    <tpEmis>1</tpEmis>
    <cStat>100</cStat>
    <dhProc>2026-08-05T10:00:00-03:00</dhProc>
    <nDFSe>1</nDFSe>
    <emit>
      <CNPJ>11222333000181</CNPJ>
      <IM>123456</IM>
      <xNome>PRESTADORA</xNome>
      <enderNac>
        <xLgr>Rua Teste</xLgr>
        <nro>100</nro>
        <xBairro>Centro</xBairro>
        <cMun>5208707</cMun>
        <UF>GO</UF>
        <CEP>74000000</CEP>
      </enderNac>
    </emit>
    <valores>
      <vBC>1000.00</vBC>
      <pAliqAplic>5.00</pAliqAplic>
      <vISSQN>50.00</vISSQN>
      <vTotalRet>40.00</vTotalRet>
      <vLiq>960.00</vLiq>
    </valores>
    <DPS>
      <infDPS Id="DPS5208707100112223330001810000100000000000001">
        <tpAmb>1</tpAmb>
        <dhEmi>2026-08-05T09:30:00-03:00</dhEmi>
        <verAplic>1.0.0</verAplic>
        <serie>00001</serie>
        <nDPS>1</nDPS>
        <dCompet>2026-08-05</dCompet>
        <tpEmit>1</tpEmit>
        <cLocEmi>5208707</cLocEmi>
        <prest>
          <CNPJ>11222333000181</CNPJ>
          <IM>123456</IM>
          <xNome>PRESTADORA</xNome>
          <regTrib>
            <opSimpNac>1</opSimpNac>
            <regEspTrib>0</regEspTrib>
          </regTrib>
        </prest>
        <toma>
          <CNPJ>99888777000166</CNPJ>
          <xNome>TOMADORA</xNome>
        </toma>
        <serv>
          <locPrest>
            <cLocPrestacao>5208707</cLocPrestacao>
          </locPrest>
          <cServ>
            <cTribNac>010701</cTribNac>
            <xDescServ>Consultoria em tecnologia da informação</xDescServ>
          </cServ>
        </serv>
        <valores>
          <vServPrest>
            <vServ>1000.00</vServ>
          </vServPrest>
          <trib>
            <tribMun>
              <tribISSQN>1</tribISSQN>
              <tpRetISSQN>1</tpRetISSQN>
              <pAliq>5.00</pAliq>
            </tribMun>
            <tribFed>
              <piscofins>
                <CST>01</CST>
                <vBCPisCofins>1000.00</vBCPisCofins>
                <pAliqPis>0.65</pAliqPis>
                <pAliqCofins>3.00</pAliqCofins>
                <vPis>6.50</vPis>
                <vCofins>30.00</vCofins>
                <tpRetPisCofins>8</tpRetPisCofins>
              </piscofins>
              <vRetCP>15.00</vRetCP>
              <vRetIRRF>15.00</vRetIRRF>
              <vRetCSLL>10.00</vRetCSLL>
            </tribFed>
            <totTrib>
              <indTotTrib>0</indTotTrib>
            </totTrib>
          </trib>
        </valores>
      </infDPS>
    </DPS>
  </infNFSe>
</NFSe>`;

describe("parseNfseXml — Padrão Nacional, NFS-e normal (UTF-8, com acento)", () => {
  const result = parseNfseXml(Buffer.from(NACIONAL_NORMAL, "utf8"), "SAIDA");

  it("não gera erro, reconhece o layout e respeita o encoding=UTF-8 declarado no prólogo", () => {
    expect(result.errors).toEqual([]);
    expect(result.parser).toBe("nfse-xml");
    // O prólogo desta fixture declara encoding="UTF-8" — o parser prioriza
    // essa declaração em vez de detectar por conta própria (ver decodeXml).
    expect(result.warnings).toContain("Codificação informada no XML: utf-8.");
  });

  it("extrai a identificação e a chave (Id sem o prefixo NFS)", () => {
    expect(result.invoices).toHaveLength(1);
    const nota = result.invoices[0];
    expect(nota.model).toBe("NFSE");
    expect(nota.direction).toBe("SAIDA");
    expect(nota.accessKey).toBe(
      "12345678901234567890123456789012345678901234567890",
    );
    expect(nota.accessKey).toHaveLength(50);
    expect(nota.number).toBe("11");
  });

  it("extrai emitente (prestador) e tomador com CNPJ, sem inventar UF", () => {
    const nota = result.invoices[0];
    expect(nota.emitCnpj).toBe("11222333000181");
    expect(nota.emitName).toBe("PRESTADORA");
    expect(nota.emitUf).toBeUndefined(); // Padrão Nacional não traz UF explícita, só código IBGE.
    expect(nota.destDoc).toBe("99888777000166");
    expect(nota.destName).toBe("TOMADORA");
    expect(nota.destUf).toBeUndefined();
  });

  it("usa dhEmi do DPS (emissão pelo contribuinte) como issueDate, não dhProc (validação)", () => {
    expect(result.invoices[0].issueDate?.toISOString()).toBe(
      "2026-08-05T12:30:00.000Z",
    );
  });

  it("extrai base, alíquota e valor do ISSQN em Decimal a partir dos totais validados (infNFSe.valores)", () => {
    const raw = result.invoices[0].raw as any;
    expect(raw.issqn.baseCalculo.equals(D("1000.00"))).toBe(true);
    expect(raw.issqn.aliquota.equals(D("5.00"))).toBe(true);
    expect(raw.issqn.valor.equals(D("50.00"))).toBe(true);
  });

  it("marca ISS como NÃO retido (tpRetISSQN=1) e extrai as retenções federais (IR, CSLL, INSS)", () => {
    const raw = result.invoices[0].raw as any;
    expect(raw.issqn.retido).toBe(false);
    expect(raw.issqn.tipoRetencao).toBe("1");
    expect(raw.retencoesFederais.irrf.equals(D("15.00"))).toBe(true);
    expect(raw.retencoesFederais.csll.equals(D("10.00"))).toBe(true);
    expect(raw.retencoesFederais.inss.equals(D("15.00"))).toBe(true);
  });

  it("extrai PIS/COFINS (apuração própria) nos totais e no item, e o código de serviço da LC 116/2003", () => {
    const nota = result.invoices[0];
    expect(nota.totalPis?.equals(D("6.50"))).toBe(true);
    expect(nota.totalCofins?.equals(D("30.00"))).toBe(true);
    expect(nota.totalInvoice?.equals(D("960.00"))).toBe(true); // vLiq
    expect(nota.items).toHaveLength(1);
    expect(nota.items[0].description).toBe(
      "Consultoria em tecnologia da informação",
    );
    expect(nota.items[0].totalValue?.equals(D("1000.00"))).toBe(true);
    const raw = nota.raw as any;
    expect(raw.codigoServicoLC116).toBe("010701");
  });

  it("não marca situação (cStat não indica cancelamento — cancelamento é documento separado)", () => {
    expect(result.invoices[0].situationCode).toBeUndefined();
    expect(result.invoices[0].situationLabel).toBeUndefined();
  });
});

describe("parseNfseXml — Padrão Nacional, evento de cancelamento (documento separado)", () => {
  const EVENTO_CANCELAMENTO = `<?xml version="1.0" encoding="UTF-8"?>
<evento versao="1.01" xmlns="http://www.sped.fazenda.gov.br/nfse">
  <infEvento Id="EVT12345678901234567890123456789012345678901234567890">
    <verAplic>1.0.0</verAplic>
    <ambGer>2</ambGer>
    <nSeqEvento>001</nSeqEvento>
    <dhProc>2026-08-06T08:00:00-03:00</dhProc>
    <nDFSe>1</nDFSe>
    <pedRegEvento versao="1.01">
      <infPedReg Id="PED12345678901234567890123456789012345678901234567890">
        <tpAmb>1</tpAmb>
        <verAplic>1.0.0</verAplic>
        <dhEvento>2026-08-06T08:00:00-03:00</dhEvento>
        <CNPJAutor>11222333000181</CNPJAutor>
        <chNFSe>12345678901234567890123456789012345678901234567890</chNFSe>
        <e101101/>
      </infPedReg>
    </pedRegEvento>
  </infEvento>
</evento>`;

  const result = parseNfseXml(Buffer.from(EVENTO_CANCELAMENTO, "utf8"), "SAIDA");

  it("extrai a nota cancelada a partir da chave do evento, marcada, não descartada", () => {
    expect(result.errors).toEqual([]);
    expect(result.invoices).toHaveLength(1);
    const nota = result.invoices[0];
    expect(nota.accessKey).toBe(
      "12345678901234567890123456789012345678901234567890",
    );
    expect(nota.situationCode).toBe("02");
    expect(nota.situationLabel).toBe("Documento cancelado");
    expect(nota.items).toEqual([]);
  });

  it("avisa que os dados completos da nota não estão no arquivo de evento", () => {
    const warning = result.warnings.find((w) => w.includes("Evento de cancelamento"));
    expect(warning).toBeDefined();
    expect(warning).toContain("dados completos da nota");
  });
});

describe("parseNfseXml — Padrão Nacional, evento de cancelamento por substituição (e105102)", () => {
  const EVENTO_SUBSTITUICAO = `<?xml version="1.0" encoding="UTF-8"?>
<evento versao="1.01" xmlns="http://www.sped.fazenda.gov.br/nfse">
  <infEvento Id="EVT99995678901234567890123456789012345678901234567890">
    <verAplic>1.0.0</verAplic>
    <ambGer>2</ambGer>
    <nSeqEvento>001</nSeqEvento>
    <dhProc>2026-08-06T08:00:00-03:00</dhProc>
    <nDFSe>2</nDFSe>
    <pedRegEvento versao="1.01">
      <infPedReg Id="PED99995678901234567890123456789012345678901234567890">
        <tpAmb>1</tpAmb>
        <verAplic>1.0.0</verAplic>
        <dhEvento>2026-08-06T08:00:00-03:00</dhEvento>
        <CNPJAutor>11222333000181</CNPJAutor>
        <chNFSe>99995678901234567890123456789012345678901234567890</chNFSe>
        <e105102/>
      </infPedReg>
    </pedRegEvento>
  </infEvento>
</evento>`;

  const result = parseNfseXml(Buffer.from(EVENTO_SUBSTITUICAO, "utf8"), "SAIDA");

  it("marca como SUBSTITUIDA, distinta de CANCELADA simples", () => {
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].situationCode).toBe("SUBSTITUIDA");
    expect(result.invoices[0].situationLabel).toContain("substituição");
  });
});

// ---------------------------------------------------------------------------
// ABRASF 2.04 — leiaute confirmado em "schema nfse v2-04.xsd" (ABRASF).
// ---------------------------------------------------------------------------

const ABRASF_204_NORMAL = `<?xml version="1.0" encoding="UTF-8"?>
<CompNfse xmlns="http://www.abrasf.org.br/nfse.xsd">
  <Nfse versao="2.04">
    <InfNfse Id="nfse:123">
      <Numero>987</Numero>
      <CodigoVerificacao>ABC123XY</CodigoVerificacao>
      <DataEmissao>2026-08-05T14:00:00-03:00</DataEmissao>
      <ValoresNfse>
        <BaseCalculo>2000.00</BaseCalculo>
        <Aliquota>3.00</Aliquota>
        <ValorIss>60.00</ValorIss>
        <ValorLiquidoNfse>1800.00</ValorLiquidoNfse>
      </ValoresNfse>
      <PrestadorServico>
        <RazaoSocial>PRESTADORA ABRASF LTDA</RazaoSocial>
        <NomeFantasia>Prestadora</NomeFantasia>
        <Endereco>
          <Endereco>Av. Central</Endereco>
          <Numero>200</Numero>
          <Bairro>Setor Central</Bairro>
          <CodigoMunicipio>5208707</CodigoMunicipio>
          <Uf>GO</Uf>
          <Cep>74000000</Cep>
        </Endereco>
      </PrestadorServico>
      <OrgaoGerador>
        <CodigoMunicipio>5208707</CodigoMunicipio>
        <Uf>GO</Uf>
      </OrgaoGerador>
      <DeclaracaoPrestacaoServico>
        <InfDeclaracaoPrestacaoServico Id="rps:1">
          <Competencia>2026-08-05</Competencia>
          <Servico>
            <Valores>
              <ValorServicos>2000.00</ValorServicos>
              <ValorDeducoes>0.00</ValorDeducoes>
              <ValorPis>13.00</ValorPis>
              <ValorCofins>60.00</ValorCofins>
              <ValorInss>0.00</ValorInss>
              <ValorIr>30.00</ValorIr>
              <ValorCsll>20.00</ValorCsll>
              <ValorIss>60.00</ValorIss>
              <Aliquota>3.00</Aliquota>
              <DescontoIncondicionado>0.00</DescontoIncondicionado>
              <DescontoCondicionado>0.00</DescontoCondicionado>
            </Valores>
            <IssRetido>1</IssRetido>
            <ResponsavelRetencao>1</ResponsavelRetencao>
            <ItemListaServico>01.07</ItemListaServico>
            <CodigoCnae>6202300</CodigoCnae>
            <Discriminacao>Desenvolvimento de sistema sob encomenda</Discriminacao>
            <CodigoMunicipio>5208707</CodigoMunicipio>
            <ExigibilidadeISS>1</ExigibilidadeISS>
          </Servico>
          <Prestador>
            <CpfCnpj>
              <Cnpj>22333444000155</Cnpj>
            </CpfCnpj>
            <InscricaoMunicipal>654321</InscricaoMunicipal>
          </Prestador>
          <TomadorServico>
            <IdentificacaoTomador>
              <CpfCnpj>
                <Cnpj>55666777000199</Cnpj>
              </CpfCnpj>
            </IdentificacaoTomador>
            <RazaoSocial>TOMADORA ABRASF LTDA</RazaoSocial>
            <Endereco>
              <Endereco>Rua das Flores</Endereco>
              <Numero>10</Numero>
              <Bairro>Jardim</Bairro>
              <CodigoMunicipio>3550308</CodigoMunicipio>
              <Uf>SP</Uf>
              <Cep>01000000</Cep>
            </Endereco>
          </TomadorServico>
          <OptanteSimplesNacional>2</OptanteSimplesNacional>
          <IncentivoFiscal>2</IncentivoFiscal>
        </InfDeclaracaoPrestacaoServico>
      </DeclaracaoPrestacaoServico>
    </InfNfse>
  </Nfse>
</CompNfse>`;

describe("parseNfseXml — ABRASF 2.04, NFS-e normal com ISS retido pelo tomador", () => {
  const result = parseNfseXml(Buffer.from(ABRASF_204_NORMAL, "utf8"), "SAIDA");

  it("reconhece o layout ABRASF e extrai CNPJ do prestador do caminho aninhado (DeclaracaoPrestacaoServico.Prestador)", () => {
    expect(result.errors).toEqual([]);
    expect(result.invoices).toHaveLength(1);
    const nota = result.invoices[0];
    expect(nota.emitCnpj).toBe("22333444000155");
    expect(nota.emitName).toBe("PRESTADORA ABRASF LTDA");
    expect(nota.number).toBe("987");
  });

  it("extrai endereço/UF do prestador e do tomador", () => {
    const nota = result.invoices[0];
    expect(nota.emitUf).toBe("GO");
    expect(nota.destDoc).toBe("55666777000199");
    expect(nota.destName).toBe("TOMADORA ABRASF LTDA");
    expect(nota.destUf).toBe("SP");
  });

  it("usa DataEmissao como issueDate", () => {
    expect(result.invoices[0].issueDate?.toISOString()).toBe(
      "2026-08-05T17:00:00.000Z",
    );
  });

  it("extrai base/alíquota/ISS dos totais validados (ValoresNfse) e marca ISS retido", () => {
    const raw = result.invoices[0].raw as any;
    expect(raw.issqn.baseCalculo.equals(D("2000.00"))).toBe(true);
    expect(raw.issqn.aliquota.equals(D("3.00"))).toBe(true);
    expect(raw.issqn.valor.equals(D("60.00"))).toBe(true);
    expect(raw.issqn.retido).toBe(true);
    expect(raw.issqn.tipoRetencao).toBe("1"); // ResponsavelRetencao = Tomador
  });

  it("extrai retenções federais completas (PIS, COFINS, IR, CSLL) e INSS zero explícito (não ausência)", () => {
    const raw = result.invoices[0].raw as any;
    expect(raw.retencoesFederais.pis.equals(D("13.00"))).toBe(true);
    expect(raw.retencoesFederais.cofins.equals(D("60.00"))).toBe(true);
    expect(raw.retencoesFederais.irrf.equals(D("30.00"))).toBe(true);
    expect(raw.retencoesFederais.csll.equals(D("20.00"))).toBe(true);
    expect(raw.retencoesFederais.inss?.equals(D("0"))).toBe(true);
    expect(raw.retencoesFederais.inss).not.toBeUndefined(); // 0.00 informado é valor, não ausência.
  });

  it("marca situação como documento regular (sem NfseCancelamento/NfseSubstituicao)", () => {
    expect(result.invoices[0].situationCode).toBe("00");
    expect(result.invoices[0].situationLabel).toBe("Documento regular");
  });

  it("extrai o código de serviço LC 116/2003, CNAE e discriminação", () => {
    const raw = result.invoices[0].raw as any;
    expect(raw.codigoServicoLC116).toBe("01.07");
    expect(raw.cnae).toBe("6202300");
    expect(raw.discriminacao).toBe("Desenvolvimento de sistema sob encomenda");
    expect(result.invoices[0].totalInvoice?.equals(D("1800.00"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ABRASF 1.00 — leiaute confirmado em "nfse.xsd" (ABRASF v1.00).
// ---------------------------------------------------------------------------

const ABRASF_100_CANCELADA = `<?xml version="1.0" encoding="UTF-8"?>
<CompNfse xmlns="http://www.abrasf.org.br/nfse.xsd">
  <Nfse versao="1.00">
    <InfNfse Id="nfse:1.00:1">
      <Numero>555</Numero>
      <CodigoVerificacao>XYZ789</CodigoVerificacao>
      <DataEmissao>2026-07-10T10:00:00-03:00</DataEmissao>
      <NaturezaOperacao>1</NaturezaOperacao>
      <OptanteSimplesNacional>1</OptanteSimplesNacional>
      <IncentivadorCultural>2</IncentivadorCultural>
      <Competencia>2026-07-10T00:00:00-03:00</Competencia>
      <Servico>
        <Valores>
          <ValorServicos>500.00</ValorServicos>
          <ValorPis>0.00</ValorPis>
          <ValorCofins>0.00</ValorCofins>
          <IssRetido>2</IssRetido>
          <ValorIss>25.00</ValorIss>
          <BaseCalculo>500.00</BaseCalculo>
          <Aliquota>5.00</Aliquota>
          <ValorLiquidoNfse>500.00</ValorLiquidoNfse>
        </Valores>
        <ItemListaServico>07.02</ItemListaServico>
        <Discriminacao>Serviço de manutenção predial</Discriminacao>
        <CodigoMunicipio>5208707</CodigoMunicipio>
      </Servico>
      <PrestadorServico>
        <IdentificacaoPrestador>
          <Cnpj>33444555000177</Cnpj>
          <InscricaoMunicipal>111222</InscricaoMunicipal>
        </IdentificacaoPrestador>
        <RazaoSocial>PRESTADORA ANTIGA LTDA</RazaoSocial>
        <Endereco>
          <Endereco>Rua Antiga</Endereco>
          <Numero>50</Numero>
          <Bairro>Vila Antiga</Bairro>
          <CodigoMunicipio>5208707</CodigoMunicipio>
          <Uf>GO</Uf>
          <Cep>74100000</Cep>
        </Endereco>
      </PrestadorServico>
      <TomadorServico>
        <IdentificacaoTomador>
          <CpfCnpj>
            <Cpf>12345678909</Cpf>
          </CpfCnpj>
        </IdentificacaoTomador>
        <RazaoSocial>JOSE DA SILVA</RazaoSocial>
      </TomadorServico>
      <OrgaoGerador>
        <CodigoMunicipio>5208707</CodigoMunicipio>
        <Uf>GO</Uf>
      </OrgaoGerador>
    </InfNfse>
  </Nfse>
  <NfseCancelamento>
    <Confirmacao>
      <Pedido>
        <InfPedidoCancelamento>
          <IdentificacaoNfse>
            <Numero>555</Numero>
            <Cnpj>33444555000177</Cnpj>
            <CodigoMunicipio>5208707</CodigoMunicipio>
          </IdentificacaoNfse>
          <CodigoCancelamento>1</CodigoCancelamento>
        </InfPedidoCancelamento>
      </Pedido>
      <DataHora>2026-07-11T09:00:00-03:00</DataHora>
    </Confirmacao>
  </NfseCancelamento>
</CompNfse>`;

describe("parseNfseXml — ABRASF 1.00, nota CANCELADA com tomador pessoa física (CPF)", () => {
  const result = parseNfseXml(Buffer.from(ABRASF_100_CANCELADA, "utf8"), "SAIDA");

  it("extrai CNPJ do caminho v1.00 (PrestadorServico.IdentificacaoPrestador.Cnpj)", () => {
    expect(result.errors).toEqual([]);
    expect(result.invoices).toHaveLength(1);
    const nota = result.invoices[0];
    expect(nota.emitCnpj).toBe("33444555000177");
    expect(nota.emitName).toBe("PRESTADORA ANTIGA LTDA");
    const raw = nota.raw as any;
    expect(raw.prestadorIm).toBe("111222");
    expect(raw.layoutVersion).toBe("1.00");
  });

  it("extrai tomador pessoa física (CPF) e não inventa UF quando o tomador não tem endereço", () => {
    const nota = result.invoices[0];
    expect(nota.destDoc).toBe("12345678909");
    expect(nota.destName).toBe("JOSE DA SILVA");
    expect(nota.destUf).toBeUndefined();
  });

  it("extrai valores do grupo único Servico.Valores (leiaute 1.00, sem ValoresNfse próprio)", () => {
    const nota = result.invoices[0];
    const raw = nota.raw as any;
    expect(raw.issqn.baseCalculo.equals(D("500.00"))).toBe(true);
    expect(raw.issqn.aliquota.equals(D("5.00"))).toBe(true);
    expect(raw.issqn.valor.equals(D("25.00"))).toBe(true);
    expect(raw.issqn.retido).toBe(false); // IssRetido = 2 (Não)
    expect(nota.totalInvoice?.equals(D("500.00"))).toBe(true);
    expect(nota.items[0].description).toBe("Serviço de manutenção predial");
  });

  it("marca a nota como CANCELADA (irmã NfseCancelamento em CompNfse) — extraída, não descartada", () => {
    const nota = result.invoices[0];
    expect(nota.situationCode).toBe("02");
    expect(nota.situationLabel).toBe("Documento cancelado");
    // Mesmo cancelada, os dados continuam presentes — quem consome decide excluir da apuração.
    expect(nota.emitCnpj).toBe("33444555000177");
    expect(nota.totalInvoice?.equals(D("500.00"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Casos de robustez: lote, vírgula decimal, encoding Latin-1, XML malformado,
// leiaute não reconhecido.
// ---------------------------------------------------------------------------

describe("parseNfseXml — lote com várias notas (envelope arbitrário de prefeitura)", () => {
  const LOTE = `<?xml version="1.0" encoding="UTF-8"?>
<ListaNfse>
  <CompNfse>
    <Nfse versao="2.04">
      <InfNfse Id="a">
        <Numero>1</Numero>
        <CodigoVerificacao>AAA</CodigoVerificacao>
        <DataEmissao>2026-08-01T10:00:00-03:00</DataEmissao>
        <PrestadorServico>
          <RazaoSocial>EMPRESA UM</RazaoSocial>
        </PrestadorServico>
        <OrgaoGerador>
          <CodigoMunicipio>5208707</CodigoMunicipio>
          <Uf>GO</Uf>
        </OrgaoGerador>
        <DeclaracaoPrestacaoServico>
          <InfDeclaracaoPrestacaoServico>
            <Competencia>2026-08-01</Competencia>
            <Servico>
              <Valores>
                <ValorServicos>100.00</ValorServicos>
              </Valores>
              <IssRetido>2</IssRetido>
              <ItemListaServico>01.07</ItemListaServico>
              <Discriminacao>Nota um</Discriminacao>
              <CodigoMunicipio>5208707</CodigoMunicipio>
              <ExigibilidadeISS>1</ExigibilidadeISS>
            </Servico>
            <Prestador>
              <CpfCnpj><Cnpj>11111111000101</Cnpj></CpfCnpj>
            </Prestador>
            <OptanteSimplesNacional>2</OptanteSimplesNacional>
            <IncentivoFiscal>2</IncentivoFiscal>
          </InfDeclaracaoPrestacaoServico>
        </DeclaracaoPrestacaoServico>
      </InfNfse>
    </Nfse>
  </CompNfse>
  <CompNfse>
    <Nfse versao="2.04">
      <InfNfse Id="b">
        <Numero>2</Numero>
        <CodigoVerificacao>BBB</CodigoVerificacao>
        <DataEmissao>2026-08-02T10:00:00-03:00</DataEmissao>
        <PrestadorServico>
          <RazaoSocial>EMPRESA DOIS</RazaoSocial>
        </PrestadorServico>
        <OrgaoGerador>
          <CodigoMunicipio>5208707</CodigoMunicipio>
          <Uf>GO</Uf>
        </OrgaoGerador>
        <DeclaracaoPrestacaoServico>
          <InfDeclaracaoPrestacaoServico>
            <Competencia>2026-08-02</Competencia>
            <Servico>
              <Valores>
                <ValorServicos>200.00</ValorServicos>
              </Valores>
              <IssRetido>2</IssRetido>
              <ItemListaServico>01.07</ItemListaServico>
              <Discriminacao>Nota dois</Discriminacao>
              <CodigoMunicipio>5208707</CodigoMunicipio>
              <ExigibilidadeISS>1</ExigibilidadeISS>
            </Servico>
            <Prestador>
              <CpfCnpj><Cnpj>22222222000102</Cnpj></CpfCnpj>
            </Prestador>
            <OptanteSimplesNacional>2</OptanteSimplesNacional>
            <IncentivoFiscal>2</IncentivoFiscal>
          </InfDeclaracaoPrestacaoServico>
        </DeclaracaoPrestacaoServico>
      </InfNfse>
    </Nfse>
  </CompNfse>
</ListaNfse>`;

  const result = parseNfseXml(Buffer.from(LOTE, "utf8"), "SAIDA");

  it("extrai as duas notas do lote independentemente do nome do envelope (ListaNfse)", () => {
    expect(result.errors).toEqual([]);
    expect(result.invoices).toHaveLength(2);
    expect(result.invoices[0].number).toBe("1");
    expect(result.invoices[0].emitCnpj).toBe("11111111000101");
    expect(result.invoices[0].items[0].totalValue?.equals(D("100.00"))).toBe(
      true,
    );
    expect(result.invoices[1].number).toBe("2");
    expect(result.invoices[1].emitCnpj).toBe("22222222000102");
    expect(result.invoices[1].items[0].totalValue?.equals(D("200.00"))).toBe(
      true,
    );
  });
});

describe("parseNfseXml — valor com vírgula decimal (variação local fora do XSD)", () => {
  const COM_VIRGULA = `<?xml version="1.0" encoding="UTF-8"?>
<CompNfse>
  <Nfse versao="2.04">
    <InfNfse Id="c">
      <Numero>3</Numero>
      <CodigoVerificacao>CCC</CodigoVerificacao>
      <DataEmissao>2026-08-03T10:00:00-03:00</DataEmissao>
      <PrestadorServico>
        <RazaoSocial>EMPRESA VIRGULA</RazaoSocial>
      </PrestadorServico>
      <OrgaoGerador>
        <CodigoMunicipio>5208707</CodigoMunicipio>
        <Uf>GO</Uf>
      </OrgaoGerador>
      <DeclaracaoPrestacaoServico>
        <InfDeclaracaoPrestacaoServico>
          <Competencia>2026-08-03</Competencia>
          <Servico>
            <Valores>
              <ValorServicos>750,00</ValorServicos>
              <ValorIss>37,50</ValorIss>
            </Valores>
            <IssRetido>2</IssRetido>
            <ItemListaServico>01.07</ItemListaServico>
            <Discriminacao>Nota com vírgula</Discriminacao>
            <CodigoMunicipio>5208707</CodigoMunicipio>
            <ExigibilidadeISS>1</ExigibilidadeISS>
          </Servico>
          <Prestador>
            <CpfCnpj><Cnpj>33333333000103</Cnpj></CpfCnpj>
          </Prestador>
          <OptanteSimplesNacional>2</OptanteSimplesNacional>
          <IncentivoFiscal>2</IncentivoFiscal>
        </InfDeclaracaoPrestacaoServico>
      </DeclaracaoPrestacaoServico>
    </InfNfse>
  </Nfse>
</CompNfse>`;

  const result = parseNfseXml(Buffer.from(COM_VIRGULA, "utf8"), "SAIDA");

  it("converte '750,00' (vírgula) direto para Decimal, sem passar por float", () => {
    expect(result.errors).toEqual([]);
    expect(result.invoices).toHaveLength(1);
    expect(result.invoices[0].items[0].totalValue?.equals(D("750.00"))).toBe(
      true,
    );
    const raw = result.invoices[0].raw as any;
    expect(raw.issqn.valor.equals(D("37.50"))).toBe(true);
  });
});

describe("parseNfseXml — encoding ISO-8859-1 declarado no prólogo, com acento", () => {
  it("respeita o encoding=ISO-8859-1 do prólogo e preserva o acento do prestador", () => {
    const nome = "PRESTAÇÃO DE SERVIÇOS JOSÉ LTDA";
    const xmlUtf8 = `<?xml version="1.0" encoding="ISO-8859-1"?>
<CompNfse>
  <Nfse versao="2.04">
    <InfNfse Id="d">
      <Numero>4</Numero>
      <CodigoVerificacao>DDD</CodigoVerificacao>
      <DataEmissao>2026-08-04T10:00:00-03:00</DataEmissao>
      <PrestadorServico>
        <RazaoSocial>${nome}</RazaoSocial>
      </PrestadorServico>
      <OrgaoGerador>
        <CodigoMunicipio>5208707</CodigoMunicipio>
        <Uf>GO</Uf>
      </OrgaoGerador>
      <DeclaracaoPrestacaoServico>
        <InfDeclaracaoPrestacaoServico>
          <Competencia>2026-08-04</Competencia>
          <Servico>
            <Valores>
              <ValorServicos>300.00</ValorServicos>
            </Valores>
            <IssRetido>2</IssRetido>
            <ItemListaServico>01.07</ItemListaServico>
            <Discriminacao>Servico com acento</Discriminacao>
            <CodigoMunicipio>5208707</CodigoMunicipio>
            <ExigibilidadeISS>1</ExigibilidadeISS>
          </Servico>
          <Prestador>
            <CpfCnpj><Cnpj>44444444000104</Cnpj></CpfCnpj>
          </Prestador>
          <OptanteSimplesNacional>2</OptanteSimplesNacional>
          <IncentivoFiscal>2</IncentivoFiscal>
        </InfDeclaracaoPrestacaoServico>
      </DeclaracaoPrestacaoServico>
    </InfNfse>
  </Nfse>
</CompNfse>`;
    const buffer = Buffer.from(xmlUtf8, "latin1");

    // Confere que o texto realmente não é UTF-8 válido (senão o teste não provaria nada).
    expect(() => new TextDecoder("utf-8", { fatal: true }).decode(buffer)).toThrow();

    const result = parseNfseXml(buffer, "SAIDA");
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain("Codificação informada no XML: latin1.");
    expect(result.invoices[0].emitName).toBe(nome);
  });
});

describe("parseNfseXml — XML malformado", () => {
  it("devolve erro claro em vez de lançar exceção", () => {
    const result = parseNfseXml(
      Buffer.from("<CompNfse><Nfse>não fecha", "utf8"),
      "SAIDA",
    );
    expect(result.invoices).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("XML inválido");
  });
});

describe("parseNfseXml — leiaute não reconhecido (município fora dos dois padrões)", () => {
  it("não chuta estrutura: erro explícito listando as tags de topo encontradas", () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<NotaServicoPrefeituraXPTO>
  <Campo>1</Campo>
</NotaServicoPrefeituraXPTO>`;
    const result = parseNfseXml(Buffer.from(xml, "utf8"), "SAIDA");
    expect(result.invoices).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("não reconhecido");
    expect(result.errors[0]).toContain("NotaServicoPrefeituraXPTO");
  });
});

describe("parseNfseXml — proteção contra DOCTYPE/ENTITY (XXE)", () => {
  it("recusa XML com declaração de DOCTYPE em vez de processá-lo", () => {
    const xml = `<?xml version="1.0"?>
<!DOCTYPE CompNfse [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<CompNfse><Nfse><InfNfse><Numero>1</Numero></InfNfse></Nfse></CompNfse>`;
    const result = parseNfseXml(Buffer.from(xml, "utf8"), "SAIDA");
    expect(result.invoices).toEqual([]);
    expect(result.errors[0]).toContain("DOCTYPE/ENTITY");
  });
});

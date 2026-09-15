import { describe, expect, it } from "vitest";
import { ehSituacaoFiscal, parseSituacaoFiscal } from "./situacao-fiscal";

/**
 * Fixture anonimizada, construída a partir do leiaute real do Relatório de
 * Situação Fiscal do e-CAC (RFB + PGFN).
 *
 * Os relatórios reais usados para desenvolver o parser são de clientes e NÃO
 * ficam no repositório — sigilo profissional. Esta fixture reproduz a estrutura
 * com dados inventados, inclusive o detalhe que mais quebra a leitura: no texto
 * extraído do PDF, os VALORES da tabela de débitos saem numa linha e o código da
 * receita a que pertencem sai na LINHA SEGUINTE.
 */
const RELATORIO = `                        MINISTÉRIO DA FAZENDA
                        SECRETARIA ESPECIAL DA RECEITA FEDERAL DO BRASIL
                        PROCURADORIA-GERAL DA FAZENDA NACIONAL                       04/09/2026 09:30:19
                        INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO
CNPJ: 11.222.333 - EMPRESA DE TESTE LTDA

Dados Cadastrais da Matriz ______________________________________________________________

CNPJ: 11.222.333/0001-44

UA de Domicílio: DRF GOIANIA-GO                                    Código da UA: 01.201.00

Bairro: SETOR CENTRAL                     CEP: 74000-000 Município: GOIANIA            UF: GO

Responsável: 111.222.333-44 - FULANO DE TAL

Situação: ATIVA

Natureza Jurídica: 206-2 - SOCIEDADE EMPRESARIA LIMITADA        Data de Abertura: 09/05/2018

CNAE: 2599-3/99 - Fabricacao de outros produtos de metal

Porte da Empresa: EMPRESA DE PEQUENO PORTE

Sócios e Administradores ________________________________________________________________

CPF/CNPJ          Nome                            Qualificação          Situação Cadastral    Cap. Social

111.222.333-44    FULANO DE TAL                   SÓCIO-ADMINISTRADOR   REGULAR               60,00%

555.666.777-88    BELTRANA DE TAL                 SÓCIO                 REGULAR               40,00%

Certidão Emitida ________________________________________________________________________

Certidão Negativa: 1234.5678.9ABC.DEF0            Emissão: 28/08/2025    Data de Validade: 24/02/2026

_____________________________ Diagnóstico Fiscal na Receita Federal _____________________

Pendência - Débito (SIEF) _______________________________________________________________

CNPJ: 11.222.333/0001-44

Receita              PA/Exerc. Dt. Vcto     Vl. Original    Sdo. Devedor   Multa      Juros  Sdo. Dev. Cons. Situação
                                                  1.500,00        1.500,00    300,00     45,20         1.845,20 DEVEDOR
5440-01 - MAED - DCTFWEB 01/06/2026 10/07/2026
                                                     17,70           17,70      3,54      2,39            23,63 DEVEDOR
5952-07 - CSRF             08/2025 19/09/2025

Omissão de ECF __________________________________________________________________________

________________ Diagnóstico Fiscal na Procuradoria-Geral da Fazenda Nacional ___________

Pendência - Inscrição (SIDA)   ___________________________________________________________

Inscrição         Receita           Inscrito em   Ajuizado em   Processo              Tipo de Devedor
11.2.26.020072-78 3560-IRPJ FONTE   10/08/2026                  14966.718.975/2026-31 DEVEDOR PRINCIPAL
`;

const SEM_PENDENCIA = `                        INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO
CNPJ: 99.888.777 - EMPRESA REGULAR LTDA

CNPJ: 99.888.777/0001-11

Situação: ATIVA

______ Diagnóstico Fiscal na Receita Federal e Procuradoria-Geral da Fazenda Nacional ____

Não foram detectadas pendências/exigibilidades suspensas nos controles da Receita Federal e da Procuradoria-Geral da Fazenda Nacional.

                                                                        Final do Relatório
`;

describe("ehSituacaoFiscal", () => {
  it("reconhece o relatório do e-CAC", () => {
    expect(ehSituacaoFiscal(RELATORIO)).toBe(true);
    expect(ehSituacaoFiscal(SEM_PENDENCIA)).toBe(true);
  });

  it("não confunde com outro documento", () => {
    expect(ehSituacaoFiscal("|0000|015|0|01012026|31012026|EMPRESA|")).toBe(false);
    expect(ehSituacaoFiscal("Extrato do Simples Nacional")).toBe(false);
  });
});

describe("parseSituacaoFiscal — cadastro", () => {
  const r = parseSituacaoFiscal(RELATORIO)!;

  it("lê CNPJ completo e razão social", () => {
    expect(r.cnpj).toBe("11222333000144");
    expect(r.razaoSocial).toBe("EMPRESA DE TESTE LTDA");
  });

  it("lê os dados cadastrais", () => {
    expect(r.situacaoCadastral).toBe("ATIVA");
    expect(r.uf).toBe("GO");
    expect(r.municipio).toBe("GOIANIA");
    expect(r.porte).toBe("EMPRESA DE PEQUENO PORTE");
    expect(r.cnae).toContain("2599-3/99");
    expect(r.unidadeAdministrativa).toBe("DRF GOIANIA-GO");
  });

  it("lê a certidão vigente", () => {
    expect(r.certidao?.numero).toBe("1234.5678.9ABC.DEF0");
    expect(r.certidao?.validade).toBe("24/02/2026");
  });

  it("lê os sócios com qualificação separada do nome", () => {
    expect(r.socios).toHaveLength(2);
    expect(r.socios[0].nome).toBe("FULANO DE TAL");
    expect(r.socios[0].qualificacao).toBe("SÓCIO-ADMINISTRADOR");
    expect(r.socios[0].participacao).toBe("60,00%");
    expect(r.socios[1].documento).toBe("55566677788");
  });
});

describe("parseSituacaoFiscal — pendências", () => {
  const r = parseSituacaoFiscal(RELATORIO)!;

  /**
   * O caso que mais quebra: os valores vêm ANTES do código da receita no texto
   * extraído. Ler linha a linha, sem casar as duas, produziria débito sem
   * tributo ou tributo sem valor — e o total do relatório sairia errado.
   */
  it("casa os valores com a receita da linha seguinte", () => {
    const debitos = r.pendencias.filter((p) => p.natureza === "DEBITO");
    expect(debitos).toHaveLength(2);

    const maed = debitos.find((d) => d.receita?.includes("MAED"));
    expect(maed?.valorOriginal).toBe("1.500,00");
    expect(maed?.multa).toBe("300,00");
    expect(maed?.juros).toBe("45,20");
    expect(maed?.saldoConsolidado).toBe("1.845,20");
    expect(maed?.situacao).toBe("DEVEDOR");
    expect(maed?.vencimento).toBe("10/07/2026");

    const csrf = debitos.find((d) => d.receita?.includes("CSRF"));
    expect(csrf?.saldoConsolidado).toBe("23,63");
    expect(csrf?.periodo).toBe("08/2025");
  });

  it("separa o que é da Receita do que é da PGFN", () => {
    const rfb = r.pendencias.filter((p) => p.orgao === "RFB");
    const pgfn = r.pendencias.filter((p) => p.orgao === "PGFN");
    expect(rfb.length).toBeGreaterThan(0);
    expect(pgfn.length).toBeGreaterThan(0);
    expect(pgfn.every((p) => p.natureza === "DIVIDA_ATIVA")).toBe(true);
  });

  it("lê a inscrição em dívida ativa", () => {
    const divida = r.pendencias.find((p) => p.natureza === "DIVIDA_ATIVA");
    expect(divida?.identificacao).toBe("11.2.26.020072-78");
    expect(divida?.receita).toContain("IRPJ");
  });

  it("registra declaração omissa como pendência própria", () => {
    const omissao = r.pendencias.filter((p) => p.natureza === "OMISSAO_DECLARACAO");
    expect(omissao).toHaveLength(1);
    expect(omissao[0].descricao).toContain("ECF");
  });

  it("não marca semPendencias quando há pendência", () => {
    expect(r.semPendencias).toBe(false);
  });
});

describe("parseSituacaoFiscal — empresa sem pendência", () => {
  const r = parseSituacaoFiscal(SEM_PENDENCIA)!;

  it("reconhece a declaração de regularidade", () => {
    expect(r.semPendencias).toBe(true);
    expect(r.pendencias).toHaveLength(0);
  });

  it("não emite alarme falso: relatório limpo não é falha de leitura", () => {
    expect(r.avisos).toHaveLength(0);
  });
});

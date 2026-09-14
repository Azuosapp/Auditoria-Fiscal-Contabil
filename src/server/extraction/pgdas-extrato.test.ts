import { describe, expect, it } from "vitest";
import { ehExtratoPgdas, parseExtratoPgdas } from "./pgdas-extrato";

/**
 * Leitura do Extrato do Simples Nacional.
 *
 * O texto abaixo reproduz o leiaute real do PGDAS-D 2018 v2.2.27 depois de
 * `pdftotext -enc UTF-8 -layout`, com os dados trocados. As quebras de linha e o
 * embaralhamento das colunas foram PRESERVADOS de propósito: é justamente aí que
 * um parser ingênuo lê o número errado.
 */

function extrato(over: Partial<Record<string, string>> = {}): string {
  const pa = over.pa ?? "04/2026";
  const receita = over.receita ?? "5.799,44";
  const rbt12 = over.rbt12 ?? "182.444,94";
  return `                                    Extrato do Simples Nacional

                                                              Gerado em 10/08/2026 13:21:21
                                                            Apurado em ${over.apuradoEm ?? "11/05/2026 09:12:44"}

                                                                            Apuração Original
                                                                PGDAS-D 2018 Versão 2.2.27

1) Informações do Contribuinte

CNPJ Básico: 11.222.333  Nome Empresarial: EMPRESA TESTE LTDA

Data de Abertura: 21/02/2025          Regime de Apuração: Competência  Optante pelo Simples Nacional: Sim

2) Informações da Apuração 11222333202604001

Período de Apuração (PA): ${pa}

2.1 Discriminativo de Receitas                    Mercado Interno    Mercado Externo      Total
Total de Receitas Brutas (R$)                            ${receita}              0,00      ${receita}
Receita Bruta do PA (RPA) - Competência                                          0,00
Receita bruta acumulada nos doze meses anteriores ao PA   ${rbt12}                     ${rbt12}
(RBT12)                                                                          0,00    151.345,13
Receita bruta acumulada nos doze meses anteriores ao PA   43.711,90               0,00
proporcionalizada (RBT12p)                                 ${receita}             0,00      ${receita}
Receita bruta acumulada no ano-calendário corrente (RBA)          4.800.000,00       138.733,04

3) Informações dos Estabelecimentos - valores referentes às Receitas Informadas

CNPJ Estabelecimento: 11.222.333/0001-01

Município: GOIANIA                                            UF: GO

Sublimite de Receita Anual (R$): 3.600.000,00     Impedido de recolher ICMS/ISS no DAS: ${over.impedido ?? "Não"}

2.4) Fator r

Fator r = ${over.fatorR ?? "Não se aplica"}

4) Total Geral da Empresa

                     Total do Débito Declarado (exigível + suspenso) (R$)

   IRPJ         CSLL   COFINS   PIS/Pasep  INSS/CPP   ICMS    IPI      ISS        Total
   12,90        8,21                                                   0,00      234,54
                       29,88    6,47       97,32      79,76   0,00

                      Total do Débito com Exigibilidade Suspensa (R$)

   IRPJ         CSLL   COFINS   PIS/Pasep  INSS/CPP   ICMS    IPI      ISS        Total
   0,00         0,00                                                   0,00        0,00
                       0,00     0,00       0,00       0,00    0,00

                                Total do Débito Exigível (R$)

   IRPJ         CSLL   COFINS   PIS/Pasep  INSS/CPP   ICMS    IPI      ISS        Total
   12,90        8,21   29,88                                  0,00     0,00      234,54
                                6,47       97,32      79,76

5) Este item não se aplica à primeira apuração do PA:

6) Informações complementares

   IRPJ         CSLL   COFINS   PIS/Pasep  INSS/CPP   ICMS    IPI      ISS        Total
   12,90        8,21   29,88    6,47       97,32      79,76   0,00     0,00      234,54
`;
}

describe("reconhecimento do documento", () => {
  it("reconhece o extrato do Simples", () => {
    expect(ehExtratoPgdas(extrato())).toBe(true);
  });

  it("não confunde outro PDF com extrato", () => {
    expect(ehExtratoPgdas("COMPROVANTE DE INSCRIÇÃO E DE SITUAÇÃO CADASTRAL")).toBe(
      false,
    );
    expect(parseExtratoPgdas("Cartão CNPJ qualquer")).toBeNull();
  });
});

describe("campos essenciais", () => {
  it("competência vem no formato AAAA-MM", () => {
    expect(parseExtratoPgdas(extrato())!.competencia).toBe("2026-04");
    expect(parseExtratoPgdas(extrato({ pa: "01/2026" }))!.competencia).toBe("2026-01");
  });

  it("receita do período", () => {
    expect(parseExtratoPgdas(extrato())!.receitaPa.toFixed(2)).toBe("5799.44");
  });

  it("RBT12 é o da PRIMEIRA ocorrência, não o proporcionalizado nem o RBA", () => {
    const e = parseExtratoPgdas(extrato())!;
    expect(e.rbt12.toFixed(2)).toBe("182444.94");
    // 43.711,90 é o RBA, que aparece logo abaixo com rótulo deslocado.
    expect(e.rbt12.toFixed(2)).not.toBe("43711.90");
  });

  it("CNPJ e razão social", () => {
    const e = parseExtratoPgdas(extrato())!;
    expect(e.cnpj).toBe("11222333");
    expect(e.razaoSocial).toBe("EMPRESA TESTE LTDA");
  });

  it("sublimite: lê o que o próprio Fisco declarou", () => {
    expect(parseExtratoPgdas(extrato())!.impedidoIcmsIssNoDas).toBe(false);
    expect(
      parseExtratoPgdas(extrato({ impedido: "Sim" }))!.impedidoIcmsIssNoDas,
    ).toBe(true);
  });

  it("data da apuração, usada para escolher a retificação mais recente", () => {
    expect(parseExtratoPgdas(extrato())!.apuradoEm).toBe("11/05/2026 09:12:44");
  });
});

describe("total do DAS", () => {
  it("extrai o total do débito EXIGÍVEL", () => {
    expect(parseExtratoPgdas(extrato())!.dasTotal!.toFixed(2)).toBe("234.54");
  });

  it("o total é conferido pela soma dos tributos", () => {
    // 12,90 + 8,21 + 29,88 + 6,47 + 97,32 + 79,76 = 234,54
    const e = parseExtratoPgdas(extrato())!;
    expect(e.dasTotal!.toFixed(2)).toBe("234.54");
    expect(e.avisos.some((a) => a.includes("não bate"))).toBe(false);
  });

  it("total que NÃO fecha com a soma não é extraído — e o motivo é dito", () => {
    // Troca o total por um valor que não é a soma das parcelas.
    const adulterado = extrato().replace(
      /Total do Débito Exigível \(R\$\)([\s\S]*?)\n\n5\)/,
      `Total do Débito Exigível (R$)
   IRPJ         CSLL   COFINS   PIS/Pasep  INSS/CPP   ICMS    IPI      ISS        Total
   12,90        8,21   29,88                                  0,00     0,00      999,99
                                6,47       97,32      79,76

5)`,
    );
    const e = parseExtratoPgdas(adulterado)!;
    expect(e.dasTotal).toBeUndefined();
    expect(e.avisos.some((a) => a.includes("não bate"))).toBe(true);
  });

  it("a seção 6 não duplica os valores do total", () => {
    // O corte por seção existe justamente por isso: com corte fixo de
    // caracteres, os tributos vinham em dobro e a conferência falhava.
    const e = parseExtratoPgdas(extrato())!;
    expect(e.dasTotal).toBeDefined();
  });
});

describe("proporcionalização no início de atividade", () => {
  it("marca a menção na FLAG, sem inventar o valor", () => {
    const e = parseExtratoPgdas(extrato())!;
    expect(e.mencionaProporcionalizacao).toBe(true);
    expect(e).not.toHaveProperty("rbt12Proporcionalizado");
  });

  it("NÃO emite aviso por extrato — seriam seis mensagens idênticas na tela", () => {
    // O PGDAS-D imprime essa linha em toda apuração dos 12 primeiros meses.
    // Quem consolida os extratos (`lerExtratosDoProjeto`) emite um aviso só.
    const e = parseExtratoPgdas(extrato())!;
    expect(e.avisos.some((a) => a.includes("PROPORCIONALIZADO"))).toBe(false);
  });

  it("extrato sem proporcionalização não levanta a flag", () => {
    const semProporcional = extrato()
      .replace(/proporcionalizada \(RBT12p\)/g, "outra linha")
      .replace(/RBT12p/g, "XXX")
      .replace(/\(RBT12\)/g, "(RBT12)");
    const e = parseExtratoPgdas(semProporcional)!;
    expect(e.mencionaProporcionalizacao).toBe(false);
  });
});

describe("recusas", () => {
  it("extrato sem período de apuração é recusado com mensagem clara", () => {
    const semPa = extrato().replace(/Período de Apuração \(PA\): \d{2}\/\d{4}/, "");
    expect(() => parseExtratoPgdas(semPa)).toThrow(/Período de Apuração/i);
  });

  it("extrato sem RBT12 é recusado — é o dado que ele existe para dar", () => {
    const semRbt12 = extrato().replace(/doze meses anteriores ao PA/g, "XXX");
    expect(() => parseExtratoPgdas(semRbt12)).toThrow(/RBT12/);
  });
});

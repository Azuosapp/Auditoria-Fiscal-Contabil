import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseSpedEfd } from "./sped";
import { parseSpedContribuicoes } from "./sped-contribuicoes";
import {
  ColetorIdentidade,
  lerRegistro0000,
  normalizarCnpj,
  paraCompetencia,
  regimeDaEcf,
  regimeDaEfdContribuicoes,
} from "./identificar-empresa";

describe("paraCompetencia", () => {
  /**
   * Regressão da falha encontrada em 15/09/2026: uma EFD de janeiro/2026 foi
   * gravada na competência 2025-12.
   *
   * Os parsers constroem as datas com `Date.UTC`; a leitura usava
   * `getFullYear()`/`getMonth()`, que são locais. Em UTC-3, 01/01 à meia-noite
   * UTC é 31/12 às 21h — e como toda escrituração mensal começa no dia 1º, TODA
   * apuração caía no mês anterior. A competência é a chave de todo cruzamento
   * da auditoria, então o erro deslocava o relatório inteiro em silêncio.
   */
  it("lê a data em UTC — dia 1º não escorrega para o mês anterior", () => {
    expect(paraCompetencia(new Date(Date.UTC(2026, 0, 1)))).toBe("2026-01");
    expect(paraCompetencia(new Date(Date.UTC(2026, 0, 31)))).toBe("2026-01");
    expect(paraCompetencia(new Date(Date.UTC(2024, 11, 1)))).toBe("2024-12");
    expect(paraCompetencia(new Date(Date.UTC(2025, 2, 1)))).toBe("2025-03");
  });

  it("aceita o formato DDMMAAAA do SPED", () => {
    expect(paraCompetencia("01012026")).toBe("2026-01");
    expect(paraCompetencia("31122025")).toBe("2025-12");
  });

  it("aceita ISO e devolve o mês correto", () => {
    expect(paraCompetencia("2026-01-01")).toBe("2026-01");
  });

  it("devolve undefined para ausente ou inválido", () => {
    expect(paraCompetencia(undefined)).toBeUndefined();
    expect(paraCompetencia(null)).toBeUndefined();
    expect(paraCompetencia("")).toBeUndefined();
    expect(paraCompetencia(new Date("data ruim"))).toBeUndefined();
  });
});

describe("normalizarCnpj", () => {
  it("aceita CNPJ formatado e devolve só os dígitos", () => {
    expect(normalizarCnpj("12.345.678/0001-99")).toBe("12345678000199");
  });

  it("rejeita o que não tem 14 dígitos", () => {
    // CPF no lugar de CNPJ é o caso real: o registro 0000 traz os dois campos.
    expect(normalizarCnpj("12345678901")).toBeUndefined();
    expect(normalizarCnpj("")).toBeUndefined();
    expect(normalizarCnpj(undefined)).toBeUndefined();
  });
});

describe("lerRegistro0000 — cada leiaute põe o CNPJ numa posição diferente", () => {
  const buf = (s: string) => Buffer.from(s, "latin1");

  it("EFD ICMS/IPI: CNPJ no campo 7, nome no 6", () => {
    const r = lerRegistro0000(
      buf(
        "|0000|015|0|01012026|31012026|MERCADO CENTRAL LTDA|12345678000199||GO|101234567|5208707|||A|0|\n",
      ),
      "SPED_FISCAL",
    );
    expect(r.identidade?.cnpj).toBe("12345678000199");
    expect(r.identidade?.razaoSocial).toBe("MERCADO CENTRAL LTDA");
    expect(r.identidade?.uf).toBe("GO");
    expect(r.identidade?.inscricaoEstadual).toBe("101234567");
    expect(r.competenciaIni).toBe("2026-01");
    expect(r.competenciaFim).toBe("2026-01");
  });

  it("EFD-Contribuições: CNPJ no campo 9, nome no 8", () => {
    const r = lerRegistro0000(
      buf("|0000|006|0|0||01032025|31032025|EMPRESA TESTE SA|98765432000188|GO|5208707|||01|\n"),
      "SPED_CONTRIBUICOES",
    );
    expect(r.identidade?.cnpj).toBe("98765432000188");
    expect(r.identidade?.razaoSocial).toBe("EMPRESA TESTE SA");
    expect(r.competenciaIni).toBe("2025-03");
  });

  it("ECD: abertura LECD, CNPJ no campo 6", () => {
    const r = lerRegistro0000(
      buf("|0000|LECD|01012024|31122024|INDUSTRIA X LTDA|11222333000144|GO|112223334|5208707||0|0|\n"),
      "ECD",
    );
    expect(r.identidade?.cnpj).toBe("11222333000144");
    expect(r.identidade?.razaoSocial).toBe("INDUSTRIA X LTDA");
    expect(r.competenciaIni).toBe("2024-01");
    expect(r.competenciaFim).toBe("2024-12");
  });

  /**
   * A ECF tem COD_VER no campo 3 e a ECD não tem. Isso desloca CNPJ, nome e
   * datas em uma posição entre os dois leiautes — foi exatamente o erro
   * encontrado em 15/09/2026, quando o mapa da ECF foi escrito assumindo a
   * mesma sequência da ECD.
   *
   * Leiaute conferido no Manual do Leiaute 12 da ECF (ADE Cofis nº 02/2026):
   * 1 REG · 2 NOME_ESC · 3 COD_VER · 4 CNPJ · 5 NOME · 6 IND_SIT_INI_PER ·
   * 7 SIT_ESPECIAL · 8 PAT_REMAN_CIS · 9 DT_SIT_ESP · 10 DT_INI · 11 DT_FIN
   */
  it("ECF: COD_VER no campo 3 desloca CNPJ para o 4 e as datas para 10 e 11", () => {
    const r = lerRegistro0000(
      buf("|0000|LECF|0012|44555666000177|COMERCIO Y LTDA|0|0|||01012023|31122023|0||\n"),
      "ECF",
    );
    expect(r.identidade?.cnpj).toBe("44555666000177");
    expect(r.identidade?.razaoSocial).toBe("COMERCIO Y LTDA");
    expect(r.competenciaIni).toBe("2023-01");
    expect(r.competenciaFim).toBe("2023-12");
  });

  it("ECF: não confunde o COD_VER com o CNPJ", () => {
    // Se o mapa voltasse a apontar para o campo 3, o CNPJ seria "0012" — que
    // não passa em `normalizarCnpj` e faria a identificação falhar em silêncio.
    const r = lerRegistro0000(
      buf("|0000|LECF|0012|44555666000177|X|0|0|||01012023|31122023|0||\n"),
      "ECF",
    );
    expect(r.identidade?.cnpj).not.toBe("0012");
    expect(r.identidade?.cnpj).toBe("44555666000177");
  });

  it("devolve vazio quando não há registro 0000 legível", () => {
    expect(lerRegistro0000(buf("|0150|FORN|...|\n"), "SPED_FISCAL").identidade)
      .toBeUndefined();
  });
});

describe("regimeDaEcf", () => {
  const buf = (s: string) => Buffer.from(s, "latin1");

  it("bloco P indica Lucro Presumido", () => {
    expect(regimeDaEcf(buf("|0000|LECF|...|\n|P100|1|ATIVO|1000,00|\n"))).toBe(
      "LUCRO_PRESUMIDO",
    );
  });

  it("blocos L, M e N indicam Lucro Real", () => {
    expect(regimeDaEcf(buf("|0000|LECF|...|\n|L100|1|ATIVO|1000,00|\n"))).toBe(
      "LUCRO_REAL",
    );
    expect(regimeDaEcf(buf("|0000|LECF|...|\n|M300|1|X|100,00|\n"))).toBe(
      "LUCRO_REAL",
    );
  });

  it("devolve undefined quando nenhum bloco identifica o regime", () => {
    expect(regimeDaEcf(buf("|0000|LECF|...|\n|0010|0|0|\n"))).toBeUndefined();
  });
});

describe("ColetorIdentidade", () => {
  it("o registro 0000 vence a frequência dos XMLs", () => {
    const c = new ColetorIdentidade();
    // Um terceiro aparece em muitas notas; a escrituração aparece uma vez só.
    for (let i = 0; i < 50; i++) {
      c.registrarParticipanteNota("99888777000166", "FORNECEDOR GRANDE SA");
    }
    c.registrarEscrituracao({ cnpj: "12345678000199", razaoSocial: "A AUDITADA LTDA" });

    const r = c.concluir();
    expect(r.empresa?.cnpj).toBe("12345678000199");
    expect(r.confianca).toBe("ALTA");
  });

  it("duas escriturações de CNPJs diferentes baixam a confiança", () => {
    const c = new ColetorIdentidade();
    c.registrarEscrituracao({ cnpj: "12345678000199", razaoSocial: "MATRIZ" });
    c.registrarEscrituracao({ cnpj: "12345678000270", razaoSocial: "FILIAL" });

    const r = c.concluir();
    expect(r.confianca).toBe("MEDIA");
    expect(r.outrosCandidatos).toHaveLength(1);
  });

  it("sem escrituração, deduz pelo CNPJ mais frequente nas notas", () => {
    const c = new ColetorIdentidade();
    // A empresa aparece em toda nota; cada cliente, em uma só.
    for (let i = 0; i < 10; i++) {
      c.registrarParticipanteNota("12345678000199", "A AUDITADA LTDA");
      c.registrarParticipanteNota(`1122233300${String(i).padStart(4, "0")}`, "CLIENTE");
    }

    const r = c.concluir();
    expect(r.empresa?.cnpj).toBe("12345678000199");
    expect(r.confianca).toBe("MEDIA");
  });

  it("líder fraco entre muitos CNPJs devolve confiança BAIXA", () => {
    const c = new ColetorIdentidade();
    // Ninguém domina: 10 CNPJs com uma participação cada.
    for (let i = 0; i < 10; i++) {
      c.registrarParticipanteNota(`1122233300${String(i).padStart(4, "0")}`, "X");
    }

    const r = c.concluir();
    expect(r.confianca).toBe("BAIXA");
  });

  it("o período vai da menor à maior competência vista", () => {
    const c = new ColetorIdentidade();
    c.registrarCompetencia("01012021");
    c.registrarCompetencia(new Date(Date.UTC(2025, 11, 31)));
    c.registrarCompetencia("15062023");

    const r = c.concluir();
    expect(r.competenciaIni).toBe("2021-01");
    expect(r.competenciaFim).toBe("2025-12");
  });
});

/**
 * Validação cruzada contra os arquivos reais das fixtures.
 *
 * Os testes de posição acima usam linhas escritas à mão — o que é circular: se
 * o mapa estiver errado, a linha de teste tende a ser escrita com o mesmo erro.
 * Aqui a leitura rápida do 0000 é confrontada com o que o parser completo
 * (portado do azuos-tax-engine, com suíte própria) extrai do mesmo arquivo.
 * Divergir significa que um dos dois está errado.
 */
describe("lerRegistro0000 × parser completo, sobre arquivo real", () => {
  it("EFD ICMS/IPI: mesma identificação e mesmo período", () => {
    const buffer = readFileSync(join(process.cwd(), "fixtures", "sped-exemplo.txt"));

    const rapida = lerRegistro0000(buffer, "SPED_FISCAL");
    const completo = parseSpedEfd(buffer).identification;

    expect(rapida.identidade?.cnpj).toBe(completo?.cnpj);
    expect(rapida.identidade?.razaoSocial).toBe(completo?.name);
    expect(rapida.identidade?.uf).toBe(completo?.uf);
    expect(rapida.identidade?.inscricaoEstadual).toBe(completo?.ie);
    expect(rapida.competenciaIni).toBe(paraCompetencia(completo?.periodStart));
    expect(rapida.competenciaFim).toBe(paraCompetencia(completo?.periodEnd));
  });

  it("EFD-Contribuições: mesma identificação e mesmo período", () => {
    const buffer = readFileSync(
      join(process.cwd(), "src", "server", "extraction", "fixtures", "sped-contribuicoes-exemplo.txt"),
    );

    const rapida = lerRegistro0000(buffer, "SPED_CONTRIBUICOES");
    const completo = parseSpedContribuicoes(buffer).contribIdentification;

    expect(rapida.identidade?.cnpj).toBe(completo?.cnpj);
    expect(rapida.identidade?.razaoSocial).toBe(completo?.name);
    expect(rapida.identidade?.uf).toBe(completo?.uf);
    expect(rapida.competenciaIni).toBe(paraCompetencia(completo?.periodStart));
    expect(rapida.competenciaFim).toBe(paraCompetencia(completo?.periodEnd));
  });

  it("a competência do arquivo real é janeiro, não dezembro do ano anterior", () => {
    // O período começa em 01/01 — o caso exato que o fuso horário deslocava.
    const buffer = readFileSync(join(process.cwd(), "fixtures", "sped-exemplo.txt"));
    expect(lerRegistro0000(buffer, "SPED_FISCAL").competenciaIni).toBe("2026-01");
  });
});

describe("regimeDaEfdContribuicoes", () => {
  const b = (s: string) => Buffer.from(s, "latin1");
  it("cumulativo exclusivo é Lucro Presumido", () => {
    expect(regimeDaEfdContribuicoes(b("|0000|006|0|\n|0110|2|1||1|\n"))).toBe("LUCRO_PRESUMIDO");
  });
  it("não cumulativo ou misto é Lucro Real", () => {
    expect(regimeDaEfdContribuicoes(b("|0000|006|0|\n|0110|1|1||1|\n"))).toBe("LUCRO_REAL");
    expect(regimeDaEfdContribuicoes(b("|0000|006|0|\n|0110|3|1||1|\n"))).toBe("LUCRO_REAL");
  });
  it("sem 0110 não deduz", () => {
    expect(regimeDaEfdContribuicoes(b("|0000|006|0|\n"))).toBeUndefined();
  });
});

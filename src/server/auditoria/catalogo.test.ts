import { Prisma, type TipoDocumento } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { CATALOGO, cobertura, definicaoDe } from "./catalogo";
import { familiaB } from "./regras/familia-b-receita";
import { familiaC } from "./regras/familia-c-credito";
import { familiaD } from "./regras/familia-d-regime";
import { familiaE } from "./regras/familia-e-icms";

/** As mesmas regras que o motor executa. */
const REGRAS_REGISTRADAS = [familiaB, familiaC, familiaD, familiaE];
import { competenciasDoPeriodo } from "./tipos";
import { mesAno, moeda } from "./texto";

describe("catálogo", () => {
  it("não tem código repetido", () => {
    const codigos = CATALOGO.map((d) => d.codigo);
    expect(new Set(codigos).size).toBe(codigos.length);
  });

  it("todo achado declara ao menos uma fonte e uma base legal", () => {
    for (const d of CATALOGO) {
      expect(d.fontesNecessarias.length, `${d.codigo} sem fonte`).toBeGreaterThan(0);
      expect(d.baseLegal.length, `${d.codigo} sem base legal`).toBeGreaterThan(0);
    }
  });

  /**
   * O exemplo é o que torna a regra reconhecível para quem lê o catálogo.
   * "Divergência entre escriturações" é abstrato; ver os dois números é o que
   * faz a pessoa identificar o caso no cliente dela. Achado novo sem exemplo
   * entra no catálogo como texto morto.
   */
  it("todo achado traz exemplo concreto, com números ou registro", () => {
    for (const d of CATALOGO) {
      expect(d.exemplo, `${d.codigo} sem exemplo`).toBeTruthy();
      expect(
        d.exemplo.length,
        `${d.codigo}: exemplo curto demais para ser concreto`,
      ).toBeGreaterThan(60);

      // Um exemplo útil cita valor, data, código de registro ou percentual.
      const temNumero = /R\$\s?[\d.]+,\d{2}|\d{2}\/\d{4}|\d{4}-\d{2}|[A-Z]\d{3}\b|\d+%|CST \d{2}|CFOP \d{4}/.test(
        d.exemplo,
      );
      expect(temNumero, `${d.codigo}: exemplo sem número, data ou registro`).toBe(
        true,
      );
    }
  });

  it("o exemplo não repete literalmente a descrição", () => {
    // Repetir a descrição não ensina nada: o exemplo existe para mostrar o
    // caso concreto que a descrição enuncia em abstrato.
    for (const d of CATALOGO) {
      expect(d.exemplo, `${d.codigo}`).not.toBe(d.descricao);
    }
  });

  it("definicaoDe falha alto para código inexistente", () => {
    // Código inexistente é erro de programação, não dado ruim do cliente:
    // falhar em silêncio produziria achado sem título nem base legal.
    expect(() => definicaoDe("Z99")).toThrow(/não existe no catálogo/);
  });
});

describe("cobertura — o que dá para avaliar com o que o cliente entregou", () => {
  const fontes = (...t: TipoDocumento[]) => new Set<TipoDocumento>(t);

  it("sem nenhum documento, nada é avaliável e tudo vira lacuna", () => {
    const { avaliaveis, bloqueados } = cobertura(fontes());
    expect(avaliaveis).toHaveLength(0);
    expect(bloqueados).toHaveLength(CATALOGO.length);
  });

  it("XML mais SPED Fiscal liberam o cruzamento de escrituração", () => {
    const { avaliaveis } = cobertura(fontes("NFE_XML", "SPED_FISCAL"));
    const codigos = avaliaveis.map((a) => a.codigo);
    expect(codigos).toContain("B01");
    expect(codigos).toContain("B02");
  });

  it("achado de pagamento continua bloqueado sem o comprovante de arrecadação", () => {
    // É a lacuna mais importante do sistema hoje: sem saber o que foi pago,
    // nenhum dos achados críticos da família A se prova.
    const { bloqueados } = cobertura(fontes("SPED_FISCAL", "SPED_CONTRIBUICOES"));
    const a01 = bloqueados.find((b) => b.definicao.codigo === "A01");
    expect(a01).toBeDefined();
    expect(a01!.faltando).toContain("COMPROVANTE_ARRECADACAO");
  });

  it("cada achado aparece em exatamente um dos dois lados", () => {
    const { avaliaveis, bloqueados } = cobertura(fontes("NFE_XML", "SPED_FISCAL"));
    expect(avaliaveis.length + bloqueados.length).toBe(CATALOGO.length);
  });
});

describe("competenciasDoPeriodo", () => {
  it("lista mês a mês, inclusive as pontas", () => {
    expect(competenciasDoPeriodo("2025-11", "2026-02")).toEqual([
      "2025-11",
      "2025-12",
      "2026-01",
      "2026-02",
    ]);
  });

  it("período de um mês devolve esse mês", () => {
    expect(competenciasDoPeriodo("2026-01", "2026-01")).toEqual(["2026-01"]);
  });

  it("período invertido não entra em laço infinito", () => {
    const r = competenciasDoPeriodo("2026-05", "2026-01");
    expect(r.length).toBeLessThan(10);
  });
});

describe("formatação do texto do achado", () => {
  it("formata moeda a partir do Decimal, sem passar por ponto flutuante", () => {
    expect(moeda(new Prisma.Decimal("1234567.89"))).toBe("R$ 1.234.567,89");
    expect(moeda(new Prisma.Decimal("1000"))).toBe("R$ 1.000,00");
    expect(moeda(new Prisma.Decimal("0.07"))).toBe("R$ 0,07");
    expect(moeda(new Prisma.Decimal("-250.5"))).toBe("-R$ 250,50");
  });

  it("preserva centavos que o float arredondaria", () => {
    // 0.1 + 0.2 em ponto flutuante dá 0.30000000000000004. Com Decimal, não.
    const soma = new Prisma.Decimal("0.1").plus(new Prisma.Decimal("0.2"));
    expect(moeda(soma)).toBe("R$ 0,30");
  });

  it("converte competência para mês/ano", () => {
    expect(mesAno("2024-03")).toBe("03/2024");
  });
});

/**
 * Regressão de 15/09/2026: a regra da família B produzia o código B05, que não
 * existia no catálogo. A auditoria só quebrou em produção, na chamada da API —
 * o catálogo e as regras estavam corretos isoladamente, e nenhum teste ligava os
 * dois. Este teste é a ponte.
 */
describe("regras × catálogo", () => {
  it("todo código declarado por uma regra existe no catálogo", () => {
    const doCatalogo = new Set(CATALOGO.map((d) => d.codigo));

    for (const regra of REGRAS_REGISTRADAS) {
      for (const codigo of regra.codigos) {
        expect(
          doCatalogo.has(codigo),
          `A regra declara ${codigo}, que não existe no catálogo.`,
        ).toBe(true);
      }
    }
  });

  it("definicaoDe responde por todo código declarado", () => {
    for (const regra of REGRAS_REGISTRADAS) {
      for (const codigo of regra.codigos) {
        expect(() => definicaoDe(codigo), `${codigo}`).not.toThrow();
      }
    }
  });
});

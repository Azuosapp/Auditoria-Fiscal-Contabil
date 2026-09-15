import { describe, expect, it } from "vitest";
import { ART_150, ART_173, avaliarPrescricao, exercicioDe } from "./prescricao";

/**
 * A janela decadencial é o que dá credibilidade ao relatório. Apontar como
 * "risco" um débito que já decaiu queima a reunião; deixar de apontar o que
 * decai nos próximos meses perde a urgência comercial.
 */
describe("avaliarPrescricao", () => {
  const hoje = new Date(Date.UTC(2026, 8, 15)); // 15/09/2026

  describe("art. 173, I — tributo não declarado (omissão)", () => {
    it("conta do 1º dia do exercício seguinte, somando 5 anos", () => {
      // Competência 03/2021 → exercício seguinte começa em 01/01/2022 →
      // decai em 01/01/2027.
      const r = avaliarPrescricao("2021-03", false, hoje);
      expect(r.decaiEm.toISOString().slice(0, 10)).toBe("2027-01-01");
      expect(r.regra).toBe(ART_173);
    });

    it("competência de dezembro decai junto com a de janeiro do mesmo ano", () => {
      // A contagem é por EXERCÍCIO: todo 2021 decai em 01/01/2027.
      const janeiro = avaliarPrescricao("2021-01", false, hoje);
      const dezembro = avaliarPrescricao("2021-12", false, hoje);
      expect(dezembro.decaiEm.getTime()).toBe(janeiro.decaiEm.getTime());
    });
  });

  describe("art. 150, § 4º — houve declaração e pagamento", () => {
    it("conta do fato gerador, prazo mais curto que o do art. 173", () => {
      const declarado = avaliarPrescricao("2021-03", true, hoje);
      const omitido = avaliarPrescricao("2021-03", false, hoje);

      expect(declarado.regra).toBe(ART_150);
      // Do fato gerador: 03/2021 + 5 anos → 01/04/2026.
      expect(declarado.decaiEm.toISOString().slice(0, 10)).toBe("2026-04-01");
      // O prazo do art. 150 sempre vence antes do art. 173 para a mesma
      // competência — é justamente o que torna a escolha da regra relevante.
      expect(declarado.decaiEm.getTime()).toBeLessThan(omitido.decaiEm.getTime());
    });
  });

  describe("classificação", () => {
    it("EXIGIVEL quando falta mais de um ano", () => {
      expect(avaliarPrescricao("2023-06", false, hoje).situacao).toBe("EXIGIVEL");
    });

    it("A_DECAIR quando decai nos próximos 12 meses", () => {
      // Competência 2021-06 declarada: decai em 01/07/2026 — já passou.
      // Competência 2021-10 declarada: decai em 01/11/2026 — dentro de 12 meses.
      expect(avaliarPrescricao("2021-10", true, hoje).situacao).toBe("A_DECAIR");
    });

    it("DECAIDO quando a data já passou", () => {
      const r = avaliarPrescricao("2019-01", true, hoje);
      expect(r.situacao).toBe("DECAIDO");
    });

    it("competência recente de omissão é sempre exigível", () => {
      expect(avaliarPrescricao("2026-01", false, hoje).situacao).toBe("EXIGIVEL");
    });
  });

  it("exercicioDe extrai o ano da competência", () => {
    expect(exercicioDe("2024-07")).toBe(2024);
  });
});

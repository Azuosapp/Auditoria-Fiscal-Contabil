import { describe, it, expect } from "vitest";
import { $Enums } from "@prisma/client";
import { ESQUEMA_RESPOSTA, RespostaAnalise } from "./esquema";

const apontamento = {
  titulo: "ICMS da nota difere entre XML e EFD",
  severidade: "CRITICO",
  area: "FISCAL",
  confianca: "ALTA",
  tributo: "ICMS",
  competencias: ["2026-04"],
  valorEstimado: "5316.00",
  descricao: "NF-e 8 e 9 autorizadas com ICMS zero e escrituradas com débito.",
  recomendacao: "Emitir NF-e complementar de ICMS.",
  baseLegal: [],
  evidencias: [{ arquivo: "nfe-8.xml", localizacao: "nNF 8", detalhe: "vICMS 0,00", valor: "0.00" }],
};

describe("RespostaAnalise — fronteira com o Claude", () => {
  it("aceita uma resposta completa", () => {
    const r = RespostaAnalise.safeParse({ resumo: "x", documentosFaltantes: [], apontamentos: [apontamento] });
    expect(r.success).toBe(true);
  });

  it("recusa apontamento sem evidência — não há achado sem prova", () => {
    const r = RespostaAnalise.safeParse({
      resumo: "x",
      documentosFaltantes: [],
      apontamentos: [{ ...apontamento, evidencias: [] }],
    });
    expect(r.success).toBe(false);
  });

  it("recusa valor com vírgula ou separador de milhar", () => {
    for (const valorEstimado of ["5.316,00", "5,316.00", "R$ 5316"]) {
      const r = RespostaAnalise.safeParse({
        resumo: "x",
        documentosFaltantes: [],
        apontamentos: [{ ...apontamento, valorEstimado }],
      });
      expect(r.success, valorEstimado).toBe(false);
    }
  });

  it("aceita valor vazio para apontamento sem exposição mensurável", () => {
    const r = RespostaAnalise.safeParse({
      resumo: "x",
      documentosFaltantes: [],
      apontamentos: [{ ...apontamento, valorEstimado: "" }],
    });
    expect(r.success).toBe(true);
  });

  it("usa exatamente os valores dos enums do banco", () => {
    const props = ESQUEMA_RESPOSTA.properties.apontamentos.items.properties;
    expect([...props.severidade.enum].sort()).toEqual(Object.values($Enums.Severidade).sort());
    expect([...props.area.enum].sort()).toEqual(Object.values($Enums.AreaAchado).sort());
    expect([...props.confianca.enum].sort()).toEqual(Object.values($Enums.Confianca).sort());
  });
});

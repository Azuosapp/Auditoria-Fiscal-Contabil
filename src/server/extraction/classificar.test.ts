import { describe, expect, it } from "vitest";
import { classificar, classificarPdf } from "./classificar";

const buf = (s: string) => Buffer.from(s, "latin1");

describe("classificar — SPED pelo conteúdo", () => {
  /**
   * Regressão: num SPED Fiscal real de indústria, o Bloco 0 sozinho passa de
   * 8 KB, e a amostra antiga não alcançava o bloco de apuração. O arquivo era
   * reconhecido como SPED, mas sem saber qual — e caía como classificação
   * insegura. Por isso o reconhecimento usa registros do próprio Bloco 0.
   */
  it("EFD ICMS/IPI é reconhecida pelo Bloco 0, sem precisar do Bloco E", () => {
    const sped =
      "|0000|015|0|01012026|31012026|INDUSTRIA X|12345678000199||GO|1234|5208707|||A|0|\n" +
      "|0001|0|\n|0005|INDUSTRIA X|74000000|RUA A|||GOIANIA|||\n|0150|F1|FORN|1058|\n";
    const r = classificar(buf(sped), "qualquer.txt");
    expect(r.tipo).toBe("SPED_FISCAL");
    expect(r.seguro).toBe(true);
  });

  it("EFD-Contribuições é distinguida pelo registro 0110", () => {
    const sped =
      "|0000|006|0|0||01012026|31012026|EMPRESA|12345678000199|GO|5208707|||01|\n" +
      "|0001|0|\n|0110|1|1|1||\n";
    const r = classificar(buf(sped), "arquivo.txt");
    expect(r.tipo).toBe("SPED_CONTRIBUICOES");
  });

  it("ECD e ECF pela abertura do registro 0000", () => {
    expect(classificar(buf("|0000|LECD|01012024|31122024|X|1|\n"), "a.txt").tipo).toBe("ECD");
    expect(classificar(buf("|0000|LECF|0012|1|X|\n"), "b.txt").tipo).toBe("ECF");
  });

  it("nome do arquivo não manda: SPED com nome enganoso é lido pelo conteúdo", () => {
    const sped = "|0000|LECD|01012024|31122024|X|12345678000199|GO|\n|I155|1|\n";
    expect(classificar(buf(sped), "notas fiscais.xml").tipo).toBe("ECD");
  });

  it("recibo de entrega do SPED é reconhecido, não vira desconhecido", () => {
    const rec = "RCP011234567800019924022026141555B11FE32DF6684731C4F1E969F693B1E1855B0F47";
    const r = classificar(buf(rec), "PISCOFINS_20260101.rec");
    expect(r.tipo).toBe("RECIBO_ENTREGA");
  });
});

describe("classificar — XML pelo conteúdo", () => {
  it("separa NF-e de NFC-e pelo modelo", () => {
    const nfe = '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><mod>55</mod>';
    const nfce = '<?xml version="1.0"?><nfeProc><NFe><infNFe><ide><mod>65</mod>';
    expect(classificar(buf(nfe), "x.xml").tipo).toBe("NFE_XML");
    expect(classificar(buf(nfce), "y.xml").tipo).toBe("NFCE_XML");
  });

  it("evento não é confundido com nota", () => {
    // Tratar evento como nota infla o faturamento; ignorá-lo faz nota cancelada
    // seguir contando como receita.
    const evento = '<?xml version="1.0"?><procEventoNFe><evento><infEvento>';
    expect(classificar(buf(evento), "z.xml").tipo).toBe("EVENTO_NFE");
  });
});

describe("classificarPdf — PDF com texto", () => {
  it("reconhece o relatório de situação fiscal", () => {
    const t = "INFORMAÇÕES DE APOIO PARA EMISSÃO DE CERTIDÃO ".repeat(3);
    expect(classificarPdf(t, "arquivo.pdf").tipo).toBe("SITUACAO_FISCAL");
  });

  it("distingue certidão positiva de positiva com efeito de negativa", () => {
    // A diferença é jurídica e muda a conversa: a primeira indica débito
    // exigível; a segunda, débito com exigibilidade suspensa.
    const positiva =
      "CERTIDÃO POSITIVA DE DÉBITOS RELATIVOS AOS TRIBUTOS FEDERAIS ".repeat(2);
    const comEfeito =
      "CERTIDÃO POSITIVA COM EFEITOS DE NEGATIVA DE DÉBITOS RELATIVOS AOS TRIBUTOS ".repeat(2);

    const a = classificarPdf(positiva, "cnd.pdf");
    expect(a.tipo).toBe("CERTIDAO");
    expect(a.motivo).toContain("POSITIVA");

    const b = classificarPdf(comEfeito, "cpend.pdf");
    expect(b.tipo).toBe("CERTIDAO");
    expect(b.motivo).toContain("efeito de negativa");
  });
});

/**
 * PDF digitalizado é o caso real: certidão, cartão CNPJ e inscrição estadual
 * chegam como imagem, sem uma letra de texto. Dizer "conteúdo não reconhecido"
 * faz parecer erro do sistema; o certo é dizer que é imagem e usar o nome do
 * arquivo como último recurso — sempre marcado como inseguro.
 */
describe("classificarPdf — PDF digitalizado, sem texto", () => {
  const VAZIO = "\f\f";

  it("deduz o tipo pelo nome do arquivo", () => {
    expect(classificarPdf(VAZIO, "CND FEDERAL POSITIVA 15-09-2026.pdf").tipo).toBe(
      "CERTIDAO",
    );
    expect(classificarPdf(VAZIO, "CND ESTADUAL NEGATIVA.pdf").tipo).toBe("CERTIDAO");
    expect(classificarPdf(VAZIO, "CARTÃO CNPJ.pdf").tipo).toBe("CARTAO_CNPJ");
    expect(classificarPdf(VAZIO, "INSCRIÇÃO ESTADUAL.pdf").tipo).toBe(
      "INSCRICAO_ESTADUAL",
    );
    expect(classificarPdf(VAZIO, "DARF 01-2026.pdf").tipo).toBe(
      "COMPROVANTE_ARRECADACAO",
    );
  });

  it("dedução pelo nome nunca é marcada como segura", () => {
    const r = classificarPdf(VAZIO, "CND FEDERAL.pdf");
    expect(r.seguro).toBe(false);
    expect(r.motivo).toContain("NOME");
  });

  it("sem pista no nome, diz que o PDF é digitalizado", () => {
    const r = classificarPdf(VAZIO, "documento (3).pdf");
    expect(r.tipo).toBe("DESCONHECIDO");
    expect(r.motivo).toContain("digitalizado");
  });

  it("o acento do nome não atrapalha o reconhecimento", () => {
    // "CARTÃO" e "INSCRIÇÃO" só casam depois de remover os acentos — e a faixa
    // de combinantes precisa estar escrita com escapes, não com bytes
    // invisíveis que uma edição de arquivo pode perder.
    expect(classificarPdf(VAZIO, "CARTÃO CNPJ.pdf").tipo).toBe("CARTAO_CNPJ");
    expect(classificarPdf(VAZIO, "CARTAO CNPJ.pdf").tipo).toBe("CARTAO_CNPJ");
  });
});

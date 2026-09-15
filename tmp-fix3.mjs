import { readFileSync, writeFileSync } from "node:fs";

const p = "src/server/extraction/classificar.ts";
let s = readFileSync(p, "utf8");

const antigo = `  const t = texto.toUpperCase();

  if (/EXTRATO DO SIMPLES NACIONAL|PGDAS-?D|PERÍODO DE APURAÇÃO.*SIMPLES/.test(t)) {
    return { tipo: "PGDAS", motivo: "extrato do Simples Nacional (PGDAS-D)", seguro: true };
  }

  if (/RELATÓRIO DE SITUAÇÃO FISCAL|SITUAÇÃO FISCAL|DIAGNÓSTICO FISCAL/.test(t)) {`;

const novo = `  /**
   * Comparação sem acento, de propósito.
   *
   * O PDF do e-CAC vem em Latin-1 e o acento às vezes chega corrompido na
   * extração. Casar "SITUAÇÃO" exigiria que a decodificação tivesse dado certo;
   * casar "SITUACAO" funciona nos dois casos.
   */
  const t = texto
    .normalize("NFD")
    .replace(/[\\u0300-\\u036f]/g, "")
    .toUpperCase();

  if (/EXTRATO DO SIMPLES NACIONAL|PGDAS-?D|PERIODO DE APURACAO.*SIMPLES/.test(t)) {
    return { tipo: "PGDAS", motivo: "extrato do Simples Nacional (PGDAS-D)", seguro: true };
  }

  // "Informações de apoio para emissão de certidão" é o título oficial do
  // relatório; "Diagnóstico Fiscal" é o cabeçalho das seções de pendência.
  if (
    /INFORMACOES DE APOIO PARA EMISSAO DE CERTIDAO|RELATORIO DE SITUACAO FISCAL|SITUACAO FISCAL|DIAGNOSTICO FISCAL/.test(
      t,
    )
  ) {`;

if (!s.includes(antigo)) {
  console.error("trecho nao encontrado");
  process.exit(1);
}
s = s.replace(antigo, novo);

// Os demais padrões também passam a ser comparados sem acento.
s = s.replace(
  "/DOCUMENTO DE ARRECADAÇÃO|DARF|DOCUMENTO DE ARRECADA|GNRE|DARE/",
  "/DOCUMENTO DE ARRECADACAO|DARF|GNRE|DARE/",
);
s = s.replace(
  "/DCTF|DECLARAÇÃO DE DÉBITOS E CRÉDITOS/",
  "/DCTF|DECLARACAO DE DEBITOS E CREDITOS/",
);
s = s.replace(
  "/COMPROVANTE DE INSCRI..O E DE SITUA..O CADASTRAL/",
  "/COMPROVANTE DE INSCRICAO E DE SITUACAO CADASTRAL/",
);
s = s.replace(
  "/CONTRATO SOCIAL|ALTERAÇÃO CONTRATUAL/",
  "/CONTRATO SOCIAL|ALTERACAO CONTRATUAL/",
);
s = s.replace(
  "/CERTID.O (NEGATIVA|POSITIVA)|CERTID.O DE REGULARIDADE|D.BITOS RELATIVOS AOS TRIBUTOS/",
  "/CERTIDAO (NEGATIVA|POSITIVA)|CERTIDAO DE REGULARIDADE|DEBITOS RELATIVOS AOS TRIBUTOS/",
);
s = s.replace("/CERTID.O POSITIVA/", "/CERTIDAO POSITIVA/");
s = s.replace("/EFEITOS? DE NEGATIVA/", "/EFEITOS? DE NEGATIVA/");

writeFileSync(p, s, "utf8");
console.log("classificacao de PDF normalizada");

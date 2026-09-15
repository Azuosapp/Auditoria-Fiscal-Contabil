import type { SituacaoPrescricional } from "@prisma/client";

/**
 * Janela decadencial — o filtro que dá credibilidade ao relatório.
 *
 * Apontar ao cliente um débito de 2017 como "risco" queima a reunião: ele já
 * decaiu e a Receita não pode mais constituir. Todo achado é carimbado com o que
 * AINDA é exigível, o que decai nos próximos 12 meses (a urgência comercial) e o
 * que já passou.
 *
 * O CTN tem duas contagens, e usar a errada erra o ano inteiro:
 *
 * - **Art. 173, I** — 5 anos contados do primeiro dia do exercício SEGUINTE
 *   àquele em que o lançamento poderia ter sido efetuado. É a regra do
 *   lançamento de ofício: tributo não declarado, receita omitida, nota não
 *   escriturada. Dá ao Fisco quase 6 anos a partir do fato.
 *
 * - **Art. 150, § 4º** — 5 anos contados do FATO GERADOR. É a regra do
 *   lançamento por homologação: houve declaração e pagamento antecipado, ainda
 *   que parcial, e o que se homologa é esse pagamento. Prazo mais curto.
 *
 * Ressalva que o sistema declara, nunca esconde: comprovada dolo, fraude ou
 * simulação, a contagem do art. 150, § 4º cede lugar à do art. 173, I. O sistema
 * não julga intenção — quando aplica o prazo curto, diz que aplicou.
 */

export const ART_173 = "CTN, art. 173, I — 1º dia do exercício seguinte";
export const ART_150 = "CTN, art. 150, § 4º — do fato gerador";

export interface ResultadoPrescricao {
  situacao: SituacaoPrescricional;
  decaiEm: Date;
  regra: string;
}

/**
 * `houvePagamentoOuDeclaracao` decide qual contagem usar.
 *
 * Verdadeiro para achado que nasce de valor declarado pela própria empresa
 * (apuração no SPED, DAS do PGDAS, débito em DCTF). Falso para omissão — nota
 * não escriturada, receita não declarada —, em que não há o que homologar.
 */
export function avaliarPrescricao(
  competencia: string,
  houvePagamentoOuDeclaracao: boolean,
  hoje: Date = new Date(),
): ResultadoPrescricao {
  const [ano, mes] = competencia.split("-").map(Number);

  const decaiEm = houvePagamentoOuDeclaracao
    ? // Do fato gerador: 5 anos a contar do fim da competência.
      new Date(Date.UTC(ano + 5, mes, 1))
    : // Do 1º dia do exercício seguinte ao da competência, mais 5 anos.
      new Date(Date.UTC(ano + 6, 0, 1));

  const regra = houvePagamentoOuDeclaracao ? ART_150 : ART_173;

  if (hoje >= decaiEm) return { situacao: "DECAIDO", decaiEm, regra };

  const daquiUmAno = new Date(hoje);
  daquiUmAno.setUTCFullYear(daquiUmAno.getUTCFullYear() + 1);

  return {
    situacao: decaiEm <= daquiUmAno ? "A_DECAIR" : "EXIGIVEL",
    decaiEm,
    regra,
  };
}

/** Exercício da competência "AAAA-MM". */
export function exercicioDe(competencia: string): number {
  return Number(competencia.slice(0, 4));
}

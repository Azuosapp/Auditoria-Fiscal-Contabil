import { Prisma } from "@prisma/client";
import { type Money, ZERO } from "./decimal";

/**
 * Base de crédito de PIS/Cofins apurada a partir do CST de cada item de entrada.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * POR QUE ISTO EXISTE
 *
 * Até aqui, quem quisesse o cenário de Lucro Real precisava DIGITAR a "base de
 * crédito já expurgada" — e o próprio campo avisava: *"vazio = usa o total das
 * entradas (superestima)"*. Usar o total das entradas trata como creditável a
 * compra de combustível, de medicamento, de bebida fria, de autopeça: tudo o que
 * é monofásico e, por lei, não gera crédito nenhum na revenda.
 *
 * O CST está no XML, item a item. Este módulo o lê e separa o que credita do que
 * não credita, em vez de pedir o número pronto ao usuário.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * O CST de PIS/Cofins que vem no XML de uma nota de ENTRADA é o da SAÍDA do
 * fornecedor (tabelas 4.3.3 e 4.3.4 do leiaute da NF-e). É ele que revela se
 * houve contribuição paga na etapa anterior — condição do crédito no regime não
 * cumulativo (Lei nº 10.637/2002, art. 3º; Lei nº 10.833/2003, art. 3º).
 */

const D = (v: string | number) => new Prisma.Decimal(String(v));

export type ClassificacaoCredito =
  | "CREDITAVEL"
  | "NAO_CREDITAVEL"
  | "VERIFICAR";

/**
 * CST de saída que indicam contribuição efetivamente paga pelo fornecedor —
 * logo, crédito para o adquirente no não cumulativo.
 *
 * 01 alíquota básica · 02 alíquota diferenciada · 03 alíquota por unidade de medida
 */
const CST_TRIBUTADO = new Set(["01", "02", "03"]);

/**
 * CST de saída que NÃO geram crédito, com o motivo de cada um.
 *
 * O caso que mais pesa é o 04: a tributação monofásica concentra a contribuição
 * no início da cadeia e o revendedor fica com alíquota zero — sem direito a
 * crédito (Lei nº 10.637/2002, art. 3º, I, "b", e Lei nº 10.833/2003, art. 3º,
 * I, "b", na redação da Lei nº 11.787/2008). Combustível, medicamento,
 * cosmético, bebida fria, autopeça e pneu entram aqui.
 *
 * Os demais decorrem do art. 3º, § 2º, II: não dá direito a crédito a aquisição
 * de bem ou serviço não sujeito ao pagamento da contribuição.
 */
const CST_SEM_CREDITO: Record<string, string> = {
  "04": "monofásico — revenda a alíquota zero (art. 3º, I, \"b\")",
  "05": "substituição tributária de PIS/Cofins",
  "06": "alíquota zero (art. 3º, § 2º, II)",
  "07": "isenta da contribuição (art. 3º, § 2º, II)",
  "08": "sem incidência da contribuição (art. 3º, § 2º, II)",
  "09": "suspensão da contribuição (art. 3º, § 2º, II)",
  "70": "operação de aquisição sem direito a crédito",
  "71": "aquisição com isenção",
  "72": "aquisição com suspensão",
  "73": "aquisição a alíquota zero",
  "74": "aquisição sem incidência da contribuição",
  "75": "aquisição por substituição tributária",
};

/**
 * CSOSN — presença indica fornecedor optante do Simples Nacional.
 * Os códigos de CSOSN têm três dígitos e começam em 1, 2, 4, 5, 6 ou 9.
 */
function fornecedorDoSimples(cstCsosn: string | null | undefined): boolean {
  const v = (cstCsosn ?? "").trim();
  return v.length === 3 && /^[124569]/.test(v);
}

export interface ItemParaCredito {
  totalValue?: Prisma.Decimal | null;
  cstPis?: string | null;
  cstCofins?: string | null;
  cstCsosn?: string | null;
  ncm?: string | null;
  cfop?: string | null;
  description?: string | null;
}

export interface ClassificacaoItem {
  classificacao: ClassificacaoCredito;
  motivo: string;
}

/**
 * Classifica um item de entrada. O CST de PIS manda; o de Cofins serve de
 * conferência, porque divergência entre os dois é erro de emissão e precisa
 * aparecer, não ser silenciada.
 */
/**
 * Normaliza o CST para dois dígitos. String vazia continua vazia — `padStart`
 * sozinho transformaria ausência de CST no código "00", e um item com só o CST
 * de PIS preenchido seria acusado de divergência com o de Cofins.
 */
function normalizarCst(v: string | null | undefined): string {
  const s = (v ?? "").trim();
  return s.length ? s.padStart(2, "0") : "";
}

export function classificarItem(item: ItemParaCredito): ClassificacaoItem {
  const cstPis = normalizarCst(item.cstPis);
  const cstCofins = normalizarCst(item.cstCofins);

  if (!item.cstPis && !item.cstCofins) {
    if (fornecedorDoSimples(item.cstCsosn)) {
      return {
        classificacao: "VERIFICAR",
        motivo:
          "fornecedor optante do Simples Nacional, sem CST de PIS/Cofins na nota — " +
          "o direito ao crédito depende de a operação ter sido tributada",
      };
    }
    return {
      classificacao: "VERIFICAR",
      motivo: "item sem CST de PIS/Cofins no XML",
    };
  }

  if (cstPis && cstCofins && cstPis !== cstCofins) {
    return {
      classificacao: "VERIFICAR",
      motivo: `CST divergente entre PIS (${cstPis}) e Cofins (${cstCofins}) — conferir a nota`,
    };
  }

  const cst = cstPis || cstCofins;

  if (CST_TRIBUTADO.has(cst)) {
    return { classificacao: "CREDITAVEL", motivo: `CST ${cst} — operação tributada` };
  }
  if (cst in CST_SEM_CREDITO) {
    return {
      classificacao: "NAO_CREDITAVEL",
      motivo: `CST ${cst} — ${CST_SEM_CREDITO[cst]}`,
    };
  }
  if (cst === "49" || cst === "99") {
    return {
      classificacao: "VERIFICAR",
      motivo: `CST ${cst} — "outras operações", exige análise do item`,
    };
  }
  if (["50", "51", "52", "53", "54", "55", "56"].includes(cst)) {
    return {
      classificacao: "CREDITAVEL",
      motivo: `CST ${cst} — aquisição com direito a crédito`,
    };
  }
  if (["60", "61", "62", "63", "64", "65", "66", "67"].includes(cst)) {
    return {
      classificacao: "CREDITAVEL",
      motivo: `CST ${cst} — crédito presumido`,
    };
  }

  return { classificacao: "VERIFICAR", motivo: `CST ${cst} não mapeado` };
}

export interface BaseCredito {
  /** Soma dos itens com direito a crédito. */
  creditavel: Money;
  /** Soma dos itens que a lei exclui do crédito. */
  naoCreditavel: Money;
  /** Soma dos itens que exigem decisão humana. */
  verificar: Money;
  /** Total das entradas classificadas. */
  total: Money;
  itensCreditaveis: number;
  itensNaoCreditaveis: number;
  itensVerificar: number;
  /** Motivos agregados, do que mais pesa para o que menos pesa. */
  motivos: { motivo: string; valor: Money; itens: number }[];
  alertas: string[];
}

/**
 * Consolida a base de crédito de um conjunto de itens de entrada.
 *
 * O que fica em `verificar` NÃO entra no creditável — na dúvida, o motor é
 * conservador: crédito a maior é glosa, e glosa é multa de 75%.
 */
export function apurarBaseCredito(itens: ItemParaCredito[]): BaseCredito {
  const acumulado = new Map<string, { valor: Money; itens: number }>();
  let creditavel = ZERO;
  let naoCreditavel = ZERO;
  let verificar = ZERO;
  let nCred = 0;
  let nNao = 0;
  let nVer = 0;

  for (const item of itens) {
    const valor = item.totalValue ? D(item.totalValue.toString()) : ZERO;
    const { classificacao, motivo } = classificarItem(item);

    if (classificacao === "CREDITAVEL") {
      creditavel = creditavel.plus(valor);
      nCred += 1;
    } else if (classificacao === "NAO_CREDITAVEL") {
      naoCreditavel = naoCreditavel.plus(valor);
      nNao += 1;
    } else {
      verificar = verificar.plus(valor);
      nVer += 1;
    }

    const chave = `${classificacao}: ${motivo}`;
    const atual = acumulado.get(chave) ?? { valor: ZERO, itens: 0 };
    acumulado.set(chave, {
      valor: atual.valor.plus(valor),
      itens: atual.itens + 1,
    });
  }

  const motivos = [...acumulado.entries()]
    .map(([motivo, v]) => ({ motivo, valor: v.valor, itens: v.itens }))
    .sort((a, b) => b.valor.comparedTo(a.valor));

  const total = creditavel.plus(naoCreditavel).plus(verificar);
  const alertas: string[] = [];

  if (nVer > 0) {
    alertas.push(
      `${nVer} item(ns), somando ${verificar.toFixed(2)}, não puderam ser ` +
        `classificados pelo CST e ficaram FORA da base de crédito. O cálculo é ` +
        `conservador: se algum deles for creditável, o Lucro Real melhora.`,
    );
  }
  if (nCred === 0 && itens.length > 0) {
    alertas.push(
      "Nenhum item de entrada foi classificado como creditável. Confira se as " +
        "notas de entrada foram importadas e se trazem CST de PIS/Cofins.",
    );
  }
  if (naoCreditavel.greaterThan(ZERO) && total.greaterThan(ZERO)) {
    const pct = naoCreditavel.div(total).mul(100);
    if (pct.greaterThan(30)) {
      alertas.push(
        `${pct.toFixed(1)}% das entradas não geram crédito de PIS/Cofins — ` +
          `proporção alta, típica de revenda de produto monofásico. Isso reduz ` +
          `bastante a vantagem do Lucro Real e precisa constar do parecer.`,
      );
    }
  }

  return {
    creditavel,
    naoCreditavel,
    verificar,
    total,
    itensCreditaveis: nCred,
    itensNaoCreditaveis: nNao,
    itensVerificar: nVer,
    motivos,
    alertas,
  };
}

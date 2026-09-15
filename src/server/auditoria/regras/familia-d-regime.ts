import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família D — regime e enquadramento.
 *
 * O que dá para afirmar hoje vem do PGDAS-D, porque é o único documento em mãos
 * que declara enquadramento. O comparativo entre regimes (D04) exige a folha e
 * o resultado contábil — ainda não disponíveis — e por isso vira lacuna.
 */

export const familiaD: Regra = {
  codigos: ["D01", "D02"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    const achados: AchadoProduzido[] = [];
    achados.push(...(await d01Sublimite(ctx)));
    achados.push(...(await d02FatorR(ctx)));
    return achados;
  },
};

/**
 * D01 — sublimite ultrapassado sem segregar ICMS e ISS.
 *
 * O extrato do PGDAS-D traz o campo "impedido de recolher ICMS/ISS no DAS" — é
 * o próprio Fisco afirmando o sublimite. Usar esse campo é muito melhor que
 * deduzir pelo RBT12: o sublimite varia por estado e por ano, e a dedução
 * erraria em toda unidade da federação que adota valor diferente.
 *
 * O achado nasce quando a empresa está impedida E o extrato não mostra ICMS ou
 * ISS recolhido fora do DAS — ou seja, continuou pagando tudo dentro do DAS.
 */
async function d01Sublimite(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  if (!ctx.fontesDisponiveis.has("PGDAS")) return [];

  const impedidas = await prisma.apuracaoSimples.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      impedidoIcmsIssNoDas: true,
    },
    orderBy: { competencia: "asc" },
  });

  const achados: AchadoProduzido[] = [];

  for (const a of impedidas) {
    const icmsNoDas = a.icms ?? new Prisma.Decimal(0);
    const issNoDas = a.iss ?? new Prisma.Decimal(0);
    const dentroDoDas = icmsNoDas.plus(issNoDas);

    // Impedida e ainda assim com ICMS/ISS dentro do DAS: é a inconsistência.
    // Sem valor dentro do DAS, a empresa provavelmente segregou corretamente.
    if (dentroDoDas.isZero()) continue;

    achados.push({
      codigo: "D01",
      competencia: a.competencia,
      descricao:
        `O extrato do PGDAS-D marca a empresa como impedida de recolher ICMS/ISS ` +
        `no DAS, mas a competência ainda apresenta ${moeda(dentroDoDas)} desses ` +
        `tributos dentro do DAS.`,
      textoCliente:
        `A empresa ultrapassou o sublimite em ${mesAno(a.competencia)} e ` +
        `continuou recolhendo ${moeda(dentroDoDas)} de ICMS e ISS dentro do DAS. ` +
        `O estado e o município podem cobrar o tributo próprio, com multa e juros — ` +
        `e o valor pago a maior no DAS não compensa automaticamente essa cobrança.`,
      recomendacao:
        "Retificar o PGDAS-D da competência, recolher ICMS ao estado e ISS ao " +
        "município em guia própria e pleitear a restituição do que foi pago a " +
        "maior no DAS.",
      valorExposicao: dentroDoDas,
      declarado: true,
      evidencias: [
        {
          arquivo: `PGDAS-D ${mesAno(a.competencia)}`,
          campo: "impedido de recolher ICMS/ISS no DAS",
          valor: "sim",
        },
        {
          arquivo: `PGDAS-D ${mesAno(a.competencia)}`,
          campo: "ICMS + ISS no DAS",
          valor: moeda(dentroDoDas),
        },
        {
          arquivo: `PGDAS-D ${mesAno(a.competencia)}`,
          campo: "RBT12",
          valor: moeda(a.rbt12),
        },
      ],
    });
  }

  return achados;
}

/**
 * D02 — fator R incoerente com o anexo aplicado.
 *
 * O fator R é a razão folha ÷ receita dos 12 meses anteriores: a partir de 28%,
 * o serviço migra do Anexo V para o Anexo III, que é substancialmente mais
 * barato. Empresa perto do limiar e enquadrada no anexo caro é dinheiro na mesa.
 *
 * O achado só aponta o que os números do próprio extrato mostram — não recalcula
 * o fator R, porque isso exigiria a folha, que ainda não é importada. Por isso
 * sai como oportunidade a confirmar, não como erro afirmado.
 */
async function d02FatorR(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  if (!ctx.fontesDisponiveis.has("PGDAS")) return [];

  const comFatorR = await prisma.apuracaoSimples.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      fatorR: { not: null },
    },
    orderBy: { competencia: "asc" },
  });

  const LIMIAR = new Prisma.Decimal("0.28");
  // Faixa de atenção: entre 25% e 28%, um ajuste legítimo de pró-labore leva a
  // empresa ao Anexo III. Acima de 28% já deveria estar no III.
  const PISO_ATENCAO = new Prisma.Decimal("0.25");

  const achados: AchadoProduzido[] = [];

  for (const a of comFatorR) {
    const fator = a.fatorR!;
    if (fator.greaterThanOrEqualTo(LIMIAR)) continue;
    if (fator.lessThan(PISO_ATENCAO)) continue;

    achados.push({
      codigo: "D02",
      competencia: a.competencia,
      severidade: "OPORTUNIDADE",
      confianca: "MEDIA",
      descricao:
        `Fator R de ${fator.times(100).toFixed(2)}% em ${mesAno(a.competencia)} — ` +
        `abaixo dos 28% que levariam a receita de serviço do Anexo V ao Anexo III.`,
      textoCliente:
        `Em ${mesAno(a.competencia)} a empresa ficou a pouco do fator R de 28%. ` +
        `Atingindo esse patamar, a receita de serviço migra do Anexo V para o ` +
        `Anexo III, com alíquota sensivelmente menor.`,
      recomendacao:
        "Simular o custo de elevar a folha (pró-labore incluído) até o fator R de " +
        "28% e comparar com a economia no DAS. A mudança só vale quando a economia " +
        "supera o custo da folha e dos encargos.",
      declarado: true,
      ressalva:
        "O fator R usado é o informado no próprio extrato. A confirmação exige a " +
        "folha de pagamento dos 12 meses anteriores, ainda não importada.",
      evidencias: [
        {
          arquivo: `PGDAS-D ${mesAno(a.competencia)}`,
          campo: "fator R",
          valor: `${fator.times(100).toFixed(2)}%`,
        },
        {
          arquivo: `PGDAS-D ${mesAno(a.competencia)}`,
          campo: "DAS do período",
          valor: moeda(a.valorDas),
        },
      ],
    });
  }

  return achados;
}

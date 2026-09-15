import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família C — crédito indevido e crédito perdido.
 *
 * É onde mora a oportunidade: o que o cliente pagou a mais e pode recuperar. Mas
 * é também a família mais fácil de errar, porque crédito depende do regime: no
 * Simples e no Lucro Presumido cumulativo não há crédito de PIS/COFINS a tomar,
 * e acusar "crédito indevido" nesses regimes seria constrangedor.
 */

const ZERO = new Prisma.Decimal(0);

/**
 * CST que indicam item sem direito a crédito numa entrada.
 *
 * São DUAS tabelas diferentes, e confundi-las inverte o resultado:
 *
 * - **04 a 09** é a tabela de SAÍDA (tabela 4.3.3/4.3.4). Num XML de entrada,
 *   é o CST que o FORNECEDOR aplicou na saída dele: 04 monofásico, 05
 *   substituição tributária, 06 alíquota zero, 07 isento, 08 sem incidência,
 *   09 suspensão. Comprar item assim e tomar crédito é glosa certa — este é o
 *   erro que a regra procura.
 *
 * - **70 a 75** é a tabela de AQUISIÇÃO, usada no C170 do SPED Fiscal e na
 *   EFD-Contribuições: 70 aquisição sem direito a crédito, 71 com isenção,
 *   72 com suspensão, 73 a alíquota zero, 74 sem incidência, 75 por
 *   substituição. Aqui a própria empresa JÁ classificou a entrada como sem
 *   crédito — é escrituração correta, não achado. Se ela errar, o erro está em
 *   ter usado 50 (com direito) onde cabia 70; isso só se prova indo ao NCM do
 *   item, fora do alcance desta regra.
 *
 * Por isso o gatilho é a primeira tabela. Ver docs/CATALOGO_ACHADOS.md.
 */
const CST_SEM_CREDITO = new Set(["04", "05", "06", "07", "08", "09"]);

/** O que cada CST significa, para o relatório não exigir a tabela ao lado. */
const NOME_CST: Record<string, string> = {
  "04": "tributação monofásica",
  "05": "substituição tributária",
  "06": "alíquota zero",
  "07": "operação isenta",
  "08": "operação sem incidência",
  "09": "operação com suspensão",
};

function rotuloCst(cst: string | null | undefined): string {
  return NOME_CST[cst ?? ""] ?? "sem direito a crédito";
}

export const familiaC: Regra = {
  codigos: ["C01", "C02"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    return [
      ...(await c01CreditoSobreItemSemDireito(ctx)),
      ...(await c02CombustivelComCstGenerico(ctx)),
    ];
  },
};

/**
 * NCM de combustíveis sujeitos à tributação concentrada de PIS/COFINS.
 *
 * 2710 são os óleos de petróleo (gasolina, diesel, querosene, lubrificantes) e
 * 2711 os gases de petróleo (GLP, GNV). A Lei nº 9.718/1998, art. 4º, concentra
 * a contribuição no produtor e no importador, e a MP nº 2.158-35/2001, art. 42,
 * I, zera a alíquota na venda por distribuidor e comerciante varejista.
 *
 * O prefixo basta: a posição da NCM já identifica o produto como combustível.
 */
const NCM_COMBUSTIVEL = ["2710", "2711"];

/**
 * CST que dizem apenas "outras operações" — não explicam por que não houve
 * crédito. Na aquisição de monofásico, o correto vem da faixa 70 a 75.
 */
const CST_GENERICO = new Set(["98", "99"]);

/**
 * C02 — combustível monofásico escriturado com CST genérico.
 *
 * Não muda tributo: o crédito não existe de qualquer forma, porque a compra de
 * distribuidor se dá a alíquota zero e o art. 3º, § 2º, II da Lei nº
 * 10.833/2003 veda crédito sobre aquisição não sujeita ao pagamento da
 * contribuição — inclusive quando o bem é insumo legítimo, como o GLP de forno
 * numa metalúrgica.
 *
 * O que o achado aponta é a IMPRECISÃO: com CST 99 a escrituração não registra
 * o motivo de não haver crédito. Com 73 (aquisição a alíquota zero), registra —
 * e é isso que sustenta a posição da empresa num cruzamento da Receita.
 *
 * Encontrado em arquivo real: 31 notas de GLP com CFOP 1651 (industrialização
 * subsequente) e CST 99.
 */
async function c02CombustivelComCstGenerico(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (!ctx.fontesDisponiveis.has("SPED_FISCAL")) return [];

  const itens = await prisma.notaFiscalItem.findMany({
    where: {
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        direcao: "ENTRADA",
        situacao: "AUTORIZADA",
      },
      OR: NCM_COMBUSTIVEL.map((prefixo) => ({ ncm: { startsWith: prefixo } })),
    },
    select: {
      ncm: true,
      cfop: true,
      cstPis: true,
      cstCofins: true,
      descricao: true,
      valorItem: true,
      nota: {
        select: { numero: true, competencia: true, dataEmissao: true },
      },
    },
    orderBy: { valorItem: "desc" },
  });

  const genericos = itens.filter(
    (i) => CST_GENERICO.has(i.cstPis ?? "") || CST_GENERICO.has(i.cstCofins ?? ""),
  );
  if (genericos.length === 0) return [];

  const porCompetencia = new Map<string, typeof genericos>();
  for (const i of genericos) {
    const lista = porCompetencia.get(i.nota.competencia) ?? [];
    lista.push(i);
    porCompetencia.set(i.nota.competencia, lista);
  }

  return [...porCompetencia.entries()].map(([competencia, lista]) => {
    const soma = lista.reduce((s, i) => s.plus(i.valorItem), ZERO);
    // O CFOP diz o destino dado ao combustível, e muda a conversa: 1651 é
    // industrialização, 1653 é consumo do próprio estabelecimento.
    const cfops = [...new Set(lista.map((i) => i.cfop).filter(Boolean))];

    return {
      codigo: "C02",
      competencia,
      confianca: "ALTA" as const,
      descricao:
        `${lista.length} aquisição(ões) de combustível (NCM ${[
          ...new Set(lista.map((i) => i.ncm)),
        ].join(", ")}) escriturada(s) com CST de PIS/COFINS 98 ou 99, somando ` +
        `${moeda(soma)}. CFOP utilizado: ${cfops.join(", ") || "não informado"}.`,
      textoCliente:
        `Em ${mesAno(competencia)} há ${lista.length} aquisição(ões) de ` +
        `combustível escriturada(s) com CST genérico (98/99), somando ` +
        `${moeda(soma)}. Não altera o tributo devido — o crédito não caberia de ` +
        `qualquer forma, porque a venda por distribuidor é a alíquota zero —, ` +
        `mas a escrituração deixa de registrar POR QUE não houve crédito.`,
      recomendacao:
        "Reclassificar para o CST da faixa 70 a 75 conforme o caso, em regra o " +
        "73 (aquisição a alíquota zero) quando a compra é de distribuidor ou " +
        "revendedor. Se a aquisição for direto de produtor ou importador, a " +
        "situação é outra e merece análise própria.",
      // Sem valor de exposição: não há tributo a recolher nem a recuperar. O
      // achado é de qualidade da escrituração, e pôr o valor das compras aqui
      // inflaria o total do relatório com algo que não é risco.
      declarado: true,
      evidencias: [
        ...lista.slice(0, 10).map((i) => ({
          tipo: "EXEMPLO" as const,
          arquivo: `SPED Fiscal ${mesAno(competencia)}`,
          registro: "C170",
          documentoNumero: `NF ${i.nota.numero}`,
          dataDocumento: i.nota.dataEmissao.toLocaleDateString("pt-BR", {
            timeZone: "UTC",
          }),
          campo: `${i.descricao ?? "combustível"} · NCM ${i.ncm} · CFOP ${
            i.cfop ?? "—"
          }`,
          valor: moeda(i.valorItem),
          observacao: `CST PIS ${i.cstPis ?? "—"} / COFINS ${
            i.cstCofins ?? "—"
          } — genérico; o próprio seria 73 (aquisição a alíquota zero)`,
        })),
        {
          tipo: "CONTEXTO" as const,
          arquivo: "Regime do produto",
          observacao:
            "Combustível sujeito à tributação concentrada: Lei nº 9.718/1998, " +
            "art. 4º. A venda por distribuidor e varejista é a alíquota zero " +
            "(MP nº 2.158-35/2001, art. 42, I), e o crédito é vedado pelo art. " +
            "3º, § 2º, II da Lei nº 10.833/2003 — mesmo sendo insumo.",
        },
      ],
    };
  });
}

/**
 * C01 — entradas sem direito a crédito enquanto a empresa apropria crédito.
 *
 * O achado NÃO afirma que o crédito daquele item específico foi tomado — isso
 * exigiria o bloco C/M da EFD-Contribuições item a item. O que ele afirma é
 * mensurável e verdadeiro: a empresa apropriou crédito na competência E comprou
 * itens que não geram crédito algum, no valor X. É um alerta quantificado para
 * conferência, não uma acusação fechada — e sai com confiança MÉDIA, dizendo
 * isso.
 *
 * Só roda no Lucro Real: é o único regime em que há crédito de PIS/COFINS a
 * tomar. No Simples e no Presumido cumulativo o achado não faria sentido.
 */
async function c01CreditoSobreItemSemDireito(
  ctx: ContextoRegra,
): Promise<AchadoProduzido[]> {
  if (!ctx.fontesDisponiveis.has("SPED_CONTRIBUICOES")) return [];

  const temEntradas =
    ctx.fontesDisponiveis.has("NFE_XML") || ctx.fontesDisponiveis.has("SPED_FISCAL");
  if (!temEntradas) return [];

  // Competências com crédito efetivamente apropriado. Sem crédito apropriado,
  // comprar item monofásico é apenas uma compra — não há achado.
  const comCredito = await prisma.apuracaoContribuicoes.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      creditos: { gt: 0 },
    },
    select: { competencia: true, creditos: true, contribuicao: true },
  });
  if (comCredito.length === 0) return [];

  const creditoPorCompetencia = new Map<string, Prisma.Decimal>();
  for (const c of comCredito) {
    const atual = creditoPorCompetencia.get(c.competencia) ?? ZERO;
    creditoPorCompetencia.set(c.competencia, atual.plus(c.creditos ?? ZERO));
  }

  const itensEntrada = await prisma.notaFiscalItem.findMany({
    where: {
      nota: {
        documento: { auditoriaId: ctx.auditoriaId },
        direcao: "ENTRADA",
        situacao: "AUTORIZADA",
        competencia: { in: [...creditoPorCompetencia.keys()] },
      },
      OR: [
        { cstPis: { in: [...CST_SEM_CREDITO] } },
        { cstCofins: { in: [...CST_SEM_CREDITO] } },
      ],
    },
    select: {
      cstPis: true,
      cstCofins: true,
      valorItem: true,
      descricao: true,
      // O NCM identifica o produto melhor que a descrição, que varia de
      // fornecedor para fornecedor. É por ele que se confere se o item é
      // mesmo monofásico na lista da IN RFB nº 2.121/2022.
      ncm: true,
      quantidade: true,
      nota: {
        select: {
          numero: true,
          competencia: true,
          dataEmissao: true,
          cnpjEmitente: true,
        },
      },
    },
    orderBy: { valorItem: "desc" },
  });

  const porCompetencia = new Map<
    string,
    { quantidade: number; soma: Prisma.Decimal; exemplos: typeof itensEntrada }
  >();

  for (const item of itensEntrada) {
    const c = item.nota.competencia;
    const atual = porCompetencia.get(c) ?? {
      quantidade: 0,
      soma: ZERO,
      exemplos: [] as typeof itensEntrada,
    };
    atual.quantidade += 1;
    atual.soma = atual.soma.plus(item.valorItem);
    if (atual.exemplos.length < 10) atual.exemplos.push(item);
    porCompetencia.set(c, atual);
  }

  return [...porCompetencia.entries()]
    .filter(([, d]) => d.quantidade > 0)
    .map(([competencia, d]) => {
      const creditoApropriado = creditoPorCompetencia.get(competencia) ?? ZERO;
      return {
        codigo: "C01",
        competencia,
        confianca: "MEDIA" as const,
        descricao:
          `${d.quantidade} item(ns) de entrada com CST que não gera crédito ` +
          `(monofásico, ST, alíquota zero, isento ou suspenso), somando ` +
          `${moeda(d.soma)}, em competência com ${moeda(creditoApropriado)} de ` +
          `crédito apropriado.`,
        textoCliente:
          `Em ${mesAno(competencia)} a empresa apropriou ${moeda(creditoApropriado)} ` +
          `de crédito de PIS/COFINS e, no mesmo período, comprou ${moeda(d.soma)} ` +
          `em produtos que não geram crédito algum. Crédito tomado sobre esses ` +
          `itens é glosado em fiscalização.`,
        recomendacao:
          "Conferir, no bloco de créditos da EFD-Contribuições, se esses itens " +
          "entraram na base de crédito. Havendo apropriação indevida, retificar e " +
          "recolher a diferença com denúncia espontânea.",
        valorExposicao: d.soma,
        declarado: true,
        ressalva:
          "O achado compara compras sem direito a crédito com crédito apropriado " +
          "na mesma competência. Confirmar item a item no bloco de créditos da " +
          "EFD-Contribuições antes de tratar como crédito indevido — o valor " +
          "apontado é o das compras, não o do crédito glosável.",
        evidencias: [
          // Produto e NCM vêm na frente: é o que permite conferir, na lista
          // da IN RFB nº 2.121/2022, se o item é mesmo monofásico — e é a
          // primeira pergunta que o contador do cliente faz.
          ...d.exemplos.map((item) => ({
            tipo: "EXEMPLO" as const,
            arquivo: `Entrada · ${mesAno(competencia)}`,
            documentoNumero: `NF ${item.nota.numero}`,
            dataDocumento: item.nota.dataEmissao.toLocaleDateString("pt-BR", {
              timeZone: "UTC",
            }),
            participante: item.nota.cnpjEmitente,
            campo: `${item.descricao ?? "produto sem descrição"} · NCM ${
              item.ncm ?? "não informado"
            }`,
            valor: moeda(item.valorItem),
            observacao:
              `CST PIS ${item.cstPis ?? "—"} / COFINS ${item.cstCofins ?? "—"}` +
              ` — ${rotuloCst(item.cstPis ?? item.cstCofins)}`,
          })),
          {
            tipo: "CONFRONTO" as const,
            arquivo: `EFD-Contribuições ${mesAno(competencia)}`,
            campo: "crédito apropriado na competência",
            valor: moeda(creditoApropriado),
          },
        ],
      };
    });
}

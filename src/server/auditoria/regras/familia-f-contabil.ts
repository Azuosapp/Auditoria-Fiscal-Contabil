import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda, percentual as pct } from "../texto";

/**
 * Família F — escrituração contábil (ECD) e declaração do IRPJ/CSLL (ECF).
 *
 * Regras que só existem com a ECD e a ECF lidas:
 *
 *   A04 — IRPJ/CSLL da ECF × débito confessado na DCTF, nos dois sentidos
 *   B09 — receita bruta da DRE (ECD) × receita bruta da ECF
 *   F01 — conta de caixa com saldo credor
 *   F03 — débitos e créditos do mês que não fecham
 *   F09 — escrituração com lançamentos globais mensais
 */

const ZERO = new Prisma.Decimal(0);
const TOLERANCIA = new Prisma.Decimal("1.00");

export const familiaF: Regra = {
  codigos: ["A04", "B09", "F01", "F03", "F09"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    const achados: AchadoProduzido[] = [];
    if (ctx.fontesDisponiveis.has("ECF") && ctx.fontesDisponiveis.has("DCTF")) {
      achados.push(...(await a04EcfDctf(ctx)));
    }
    if (ctx.fontesDisponiveis.has("ECD") && ctx.fontesDisponiveis.has("ECF")) {
      achados.push(...(await b09ReceitaEcdEcf(ctx)));
    }
    if (ctx.fontesDisponiveis.has("ECD")) {
      achados.push(...(await f01CaixaCredor(ctx)));
      achados.push(...(await f03BalanceteNaoFecha(ctx)));
      achados.push(...(await f09LancamentosGlobais(ctx)));
    }
    return achados;
  },
};

/** "2025-03" → "1º trimestre de 2025" quando é fim de trimestre. */
function nomePeriodo(periodo: string): string {
  const [ano, mes] = periodo.split("-").map(Number);
  return mes % 3 === 0 ? `${mes / 3}º trimestre de ${ano}` : mesAno(periodo);
}

/**
 * Havendo mais de uma ECF para o mesmo exercício (retificadora), vale a do
 * documento importado por último.
 */
async function apuracoesEcfVigentes(auditoriaId: string) {
  const linhas = await prisma.apuracaoEcf.findMany({
    where: { documento: { auditoriaId } },
    include: { documento: { select: { nomeArquivo: true, createdAt: true } } },
    orderBy: { documento: { createdAt: "asc" } },
  });
  const vigente = new Map<string, (typeof linhas)[number]>();
  for (const l of linhas) vigente.set(`${l.periodo}|${l.tributo}`, l);
  return [...vigente.values()];
}

/**
 * A04 — IRPJ/CSLL apurado na ECF diverge do confessado na DCTF.
 *
 * Os dois sentidos importam e dizem coisas diferentes:
 *
 * - ECF maior que a DCTF: tributo apurado e não confessado. Sem confissão não
 *   há débito exigível; a Receita precisa lançar de ofício, com multa de 75%.
 * - DCTF maior que a ECF: confessou mais do que apurou. Se foi pago, é crédito
 *   a recuperar; se a ECF é que está errada, é ela que precisa ser retificada.
 *   Os arquivos não dizem qual das duas — por isso a confiança é MÉDIA.
 *
 * O mesmo débito trimestral volta nas DCTFs de vários meses: por código e
 * período, vale a declaração mais recente, nunca a soma das repetições.
 */
async function a04EcfDctf(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const [ecf, confissoes] = await Promise.all([
    apuracoesEcfVigentes(ctx.auditoriaId),
    prisma.confissao.findMany({
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        tributo: { in: ["IRPJ", "CSLL"] },
      },
      include: { documento: { select: { nomeArquivo: true } } },
      orderBy: [{ dataDeclaracao: "asc" }],
    }),
  ]);

  // Última declaração por (período, código).
  const ultima = new Map<string, (typeof confissoes)[number]>();
  for (const c of confissoes) ultima.set(`${c.competencia}|${c.codigoReceita}`, c);

  const confessado = new Map<string, { valor: Prisma.Decimal; itens: (typeof confissoes)[number][] }>();
  for (const c of ultima.values()) {
    const chave = `${c.competencia}|${c.tributo}`;
    const atual = confessado.get(chave) ?? { valor: ZERO, itens: [] };
    atual.valor = atual.valor.plus(c.valorDebito);
    atual.itens.push(c);
    confessado.set(chave, atual);
  }

  // Só confronta exercícios com DCTF: sem nenhuma, a falta é lacuna, não erro.
  const exerciciosComDctf = new Set(confissoes.map((c) => c.competencia.slice(0, 4)));

  const achados: AchadoProduzido[] = [];
  for (const e of ecf) {
    if (!exerciciosComDctf.has(e.periodo.slice(0, 4))) continue;
    const dctf = confessado.get(`${e.periodo}|${e.tributo}`);
    const valorDctf = dctf?.valor ?? ZERO;
    const diferenca = e.aPagar.minus(valorDctf);
    if (diferenca.abs().lessThanOrEqualTo(TOLERANCIA)) continue;

    const naoConfessado = diferenca.greaterThan(0);
    const periodo = nomePeriodo(e.periodo);
    const evidencias: AchadoProduzido["evidencias"] = [
      {
        tipo: "CONFRONTO",
        arquivo: e.documento.nomeArquivo,
        registro: e.registroOrigem ?? undefined,
        campo: `${e.tributo} a pagar apurado na ECF`,
        valor: moeda(e.aPagar),
      },
      {
        tipo: "CONFRONTO",
        arquivo: dctf?.itens.map((i) => i.documento.nomeArquivo).join(", ") ?? "DCTF do período",
        campo: `${e.tributo} confessado na DCTF (declaração mais recente)`,
        valor: moeda(valorDctf),
      },
      {
        tipo: "EXEMPLO",
        arquivo: e.documento.nomeArquivo,
        registro: e.registroOrigem ?? undefined,
        campo: `Base de cálculo do ${e.tributo} na ECF`,
        valor: moeda(e.baseCalculo),
        observacao: `período ${periodo}`,
      },
      ...(dctf?.itens ?? []).map((i) => ({
        tipo: "EXEMPLO" as const,
        arquivo: i.documento.nomeArquivo,
        campo: `Código de receita ${i.codigoReceita}`,
        valor: moeda(i.valorDebito),
        observacao: i.dataDeclaracao
          ? `declarado em ${i.dataDeclaracao.toLocaleDateString("pt-BR", { timeZone: "UTC" })}`
          : undefined,
      })),
      {
        tipo: "EXEMPLO",
        arquivo: "Cálculo",
        campo: naoConfessado ? "Apurado e não confessado" : "Confessado acima do apurado",
        valor: moeda(diferenca.abs()),
        observacao: valorDctf.isZero() ? "" : `a ECF corresponde a ${pct(e.aPagar.dividedBy(valorDctf).times(100))} da DCTF`,
      },
    ];

    achados.push(
      naoConfessado
        ? {
            codigo: "A04",
            competencia: e.periodo,
            severidade: "CRITICO",
            confianca: "ALTA",
            descricao:
              `${e.tributo} de ${moeda(e.aPagar)} apurado na ECF do ${periodo} e ` +
              `${valorDctf.isZero() ? "nenhum débito" : moeda(valorDctf)} confessado na DCTF.`,
            textoCliente:
              `No ${periodo}, a ECF apurou ${moeda(e.aPagar)} de ${e.tributo}, mas a DCTF ` +
              `confessou ${moeda(valorDctf)}. A diferença de ${moeda(diferenca)} não foi ` +
              `confessada e pode ser lançada de ofício, com multa.`,
            recomendacao:
              "Retificar a DCTF do período para confessar o valor apurado e recolher a " +
              "diferença com denúncia espontânea, antes de qualquer procedimento fiscal.",
            valorExposicao: diferenca,
            declarado: false,
            evidencias,
          }
        : {
            codigo: "A04",
            competencia: e.periodo,
            severidade: "OPORTUNIDADE",
            confianca: "MEDIA",
            descricao:
              `DCTF do ${periodo} confessou ${moeda(valorDctf)} de ${e.tributo}, acima dos ` +
              `${moeda(e.aPagar)} apurados na ECF.`,
            textoCliente:
              `No ${periodo}, a empresa confessou ${moeda(valorDctf)} de ${e.tributo} na DCTF, ` +
              `mas a ECF apurou ${moeda(e.aPagar)}. Se o valor confessado foi pago, há ` +
              `${moeda(diferenca.abs())} pagos a mais, recuperáveis por PER/DCOMP.`,
            recomendacao:
              "Conferir qual das duas declarações está correta. Se for a ECF, retificar a " +
              "DCTF e pedir a restituição ou compensação do que foi pago a mais; se for a " +
              "DCTF, retificar a ECF.",
            ressalva:
              "Os arquivos não mostram o pagamento nem qual das declarações está certa. A " +
              "diferença só vira crédito se o valor da DCTF foi recolhido e a ECF estiver " +
              "correta — conferir os DARFs e o cálculo do período antes de levar ao cliente.",
            valorExposicao: diferenca.abs(),
            declarado: true,
            evidencias,
          },
    );
  }
  return achados;
}

/**
 * B09 — receita bruta da DRE da ECD diferente da declarada na ECF.
 *
 * As duas escriturações descrevem o mesmo período da mesma empresa, e a ECF
 * recupera a ECD. Diferença mostra ajuste feito numa e não na outra — o que a
 * Receita cruza sem esforço, porque recebe as duas.
 */
async function b09ReceitaEcdEcf(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const [dre, ecf] = await Promise.all([
    prisma.linhaDre.findMany({
      where: { documento: { auditoriaId: ctx.auditoriaId } },
      include: { documento: { select: { nomeArquivo: true } } },
      orderBy: [{ dataFim: "asc" }, { ordem: "asc" }],
    }),
    apuracoesEcfVigentes(ctx.auditoriaId),
  ]);

  // Receita bruta da DRE por período: o primeiro totalizador que a nomeia.
  const receitaEcd = new Map<string, (typeof dre)[number]>();
  for (const l of dre) {
    const nome = l.descricao.toUpperCase();
    if (!/RECEITA\s+(OPERACIONAL\s+)?BRUTA/.test(nome) || /DEDU/.test(nome)) continue;
    const meses =
      (l.dataFim.getUTCFullYear() - l.dataInicio.getUTCFullYear()) * 12 +
      l.dataFim.getUTCMonth() - l.dataInicio.getUTCMonth() + 1;
    const periodo = `${l.dataFim.getUTCFullYear()}-${String(l.dataFim.getUTCMonth() + 1).padStart(2, "0")}|${meses}`;
    if (!receitaEcd.has(periodo)) receitaEcd.set(periodo, l);
  }

  const achados: AchadoProduzido[] = [];
  const vistos = new Set<string>();
  for (const e of ecf) {
    if (!e.receitaDeclarada || vistos.has(e.periodo)) continue;
    vistos.add(e.periodo);
    // A ECF trimestral compara com a DRE trimestral do mesmo fim.
    const linha = receitaEcd.get(`${e.periodo}|3`) ?? receitaEcd.get(`${e.periodo}|12`);
    if (!linha) continue;

    const diferenca = e.receitaDeclarada.minus(linha.valor);
    if (diferenca.abs().lessThanOrEqualTo(TOLERANCIA)) continue;
    const percentual = diferenca.abs().dividedBy(linha.valor.isZero() ? e.receitaDeclarada : linha.valor).times(100);
    const periodo = nomePeriodo(e.periodo);

    achados.push({
      codigo: "B09",
      competencia: e.periodo,
      severidade: percentual.lessThan(1) ? "BAIXO" : "ALTO",
      confianca: "ALTA",
      descricao:
        `Receita bruta de ${moeda(e.receitaDeclarada)} na ECF e de ${moeda(linha.valor)} ` +
        `na DRE da ECD, no ${periodo} — diferença de ${moeda(diferenca.abs())} (${pct(percentual)}).`,
      textoCliente:
        `No ${periodo}, a receita bruta declarada na ECF (${moeda(e.receitaDeclarada)}) não ` +
        `bate com a da contabilidade (${moeda(linha.valor)}). São duas declarações da ` +
        `mesma empresa que a Receita cruza entre si.`,
      recomendacao:
        "Identificar o lançamento que explica a diferença e retificar a declaração que " +
        "estiver errada — em regra a ECF, que deve partir da ECD.",
      declarado: true,
      evidencias: [
        {
          tipo: "CONFRONTO",
          arquivo: e.documento.nomeArquivo,
          registro: "L300/P150 3.01.01.01.01",
          campo: "Receita bruta na ECF",
          valor: moeda(e.receitaDeclarada),
        },
        {
          tipo: "CONFRONTO",
          arquivo: linha.documento.nomeArquivo,
          registro: "J150",
          campo: `Receita bruta na DRE da ECD (${linha.descricao})`,
          valor: moeda(linha.valor),
        },
        {
          tipo: "EXEMPLO",
          arquivo: "Cálculo",
          campo: "Diferença entre as duas declarações",
          valor: `${moeda(diferenca.abs())} (${pct(percentual)})`,
          observacao: diferenca.greaterThan(0) ? "ECF maior que a ECD" : "ECD maior que a ECF",
        },
      ],
    });
  }
  return achados;
}

/**
 * F01 — caixa com saldo credor.
 *
 * Caixa não fica negativo: saldo credor mostra saída sem entrada registrada,
 * e a lei presume que essa entrada é receita omitida. A conta é reconhecida
 * pelo plano referencial (1.01.01.01), não pelo nome.
 */
async function f01CaixaCredor(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const saldos = await prisma.saldoConta.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      classificacao: "CAIXA",
      naturezaSaldo: "C",
      saldoFinal: { gt: 0 },
    },
    include: { documento: { select: { nomeArquivo: true } } },
    orderBy: { competencia: "asc" },
  });

  return saldos.map((s) => ({
    codigo: "F01",
    competencia: s.competencia,
    confianca: "ALTA" as const,
    descricao:
      `Conta ${s.contaCodigo} (${s.contaNome ?? "caixa"}) com saldo credor de ` +
      `${moeda(s.saldoFinal)} em ${mesAno(s.competencia)}.`,
    textoCliente:
      `Em ${mesAno(s.competencia)} o caixa da empresa ficou negativo em ${moeda(s.saldoFinal)}. ` +
      `Para a Receita, caixa negativo indica pagamento feito com dinheiro que não entrou ` +
      `pela contabilidade — e presume omissão de receita nesse valor.`,
    recomendacao:
      "Localizar as entradas não registradas (empréstimos, aportes, vendas) e corrigir a " +
      "escrituração; se a origem não se comprovar, avaliar o recolhimento dos tributos " +
      "sobre a receita presumida.",
    valorExposicao: s.saldoFinal,
    declarado: false,
    evidencias: [
      {
        tipo: "EXEMPLO",
        arquivo: s.documento.nomeArquivo,
        registro: "I155",
        linha: s.linhaOrigem ?? undefined,
        campo: `Saldo final da conta ${s.contaCodigo} ${s.contaNome ?? ""}`.trim(),
        valor: `${moeda(s.saldoFinal)} C`,
        observacao: `saldo inicial ${moeda(s.saldoInicial)}, débitos ${moeda(s.debitos)}, créditos ${moeda(s.creditos)}`,
      },
    ],
  }));
}

/**
 * F03 — débitos e créditos do mês que não fecham.
 *
 * Partida dobrada: em cada mês, a soma dos débitos do balancete é igual à dos
 * créditos. Diferença mostra lançamento de uma perna só, e a escrituração
 * perde valor de prova — a Receita pode desconsiderá-la e arbitrar o lucro.
 */
async function f03BalanceteNaoFecha(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const somas = await prisma.saldoConta.groupBy({
    by: ["competencia"],
    where: { documento: { auditoriaId: ctx.auditoriaId } },
    _sum: { debitos: true, creditos: true },
    orderBy: { competencia: "asc" },
  });

  const achados: AchadoProduzido[] = [];
  for (const s of somas) {
    const deb = s._sum.debitos ?? ZERO;
    const cred = s._sum.creditos ?? ZERO;
    const diferenca = deb.minus(cred);
    if (diferenca.abs().lessThanOrEqualTo(TOLERANCIA)) continue;
    achados.push({
      codigo: "F03",
      competencia: s.competencia,
      confianca: "ALTA",
      descricao: `Balancete de ${mesAno(s.competencia)} com débitos de ${moeda(deb)} e créditos de ${moeda(cred)}.`,
      textoCliente:
        `O balancete de ${mesAno(s.competencia)} não fecha: débitos e créditos diferem em ` +
        `${moeda(diferenca.abs())}. Escrituração que não fecha pode ser desconsiderada pela ` +
        `Receita, com arbitramento do lucro.`,
      recomendacao: "Localizar os lançamentos incompletos e retificar a ECD do exercício.",
      declarado: true,
      evidencias: [
        { tipo: "CONFRONTO", arquivo: "ECD", registro: "I155", campo: "Soma dos débitos do mês", valor: moeda(deb) },
        { tipo: "CONFRONTO", arquivo: "ECD", registro: "I155", campo: "Soma dos créditos do mês", valor: moeda(cred) },
        { tipo: "EXEMPLO", arquivo: "Cálculo", campo: "Diferença", valor: moeda(diferenca.abs()) },
      ],
    });
  }
  return achados;
}

/**
 * F09 — lançamentos globais mensais.
 *
 * Contabilidade feita a partir de um resumo do mês, com meia dúzia de
 * lançamentos, não tem lastro documento a documento. É indício — uma empresa
 * pequena pode ter pouca movimentação —, por isso sai com confiança MÉDIA e só
 * quando o mês tem receita registrada.
 */
async function f09LancamentosGlobais(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const LIMITE = 10;
  const porMes = await prisma.$queryRaw<{ competencia: string; lancamentos: bigint }[]>`
    SELECT l.competencia, COUNT(DISTINCT l."numeroLancamento") AS lancamentos
      FROM "LancamentoContabil" l
      JOIN "Documento" d ON d.id = l."documentoId"
     WHERE d."auditoriaId" = ${ctx.auditoriaId}
     GROUP BY l.competencia
     ORDER BY l.competencia`;

  const comReceita = new Set(
    (
      await prisma.notaFiscal.groupBy({
        by: ["competencia"],
        where: { documento: { auditoriaId: ctx.auditoriaId }, direcao: "SAIDA" },
      })
    ).map((n) => n.competencia),
  );

  return porMes
    .filter((m) => Number(m.lancamentos) <= LIMITE && (comReceita.size === 0 || comReceita.has(m.competencia)))
    .map((m) => ({
      codigo: "F09",
      competencia: m.competencia,
      confianca: "MEDIA" as const,
      descricao: `Apenas ${m.lancamentos} lançamento(s) contábil(is) em ${mesAno(m.competencia)}.`,
      textoCliente:
        `Em ${mesAno(m.competencia)} a contabilidade tem só ${m.lancamentos} lançamento(s): ` +
        `indício de escrituração por totais mensais, sem registro documento a documento.`,
      recomendacao:
        "Conferir se a escrituração registra cada documento. Contabilidade por totais " +
        "perde valor de prova e fragiliza a empresa numa fiscalização.",
      ressalva: "Pouca movimentação pode ser legítima em empresa pequena ou sem atividade no mês.",
      declarado: true,
      evidencias: [
        {
          tipo: "EXEMPLO",
          arquivo: "ECD",
          registro: "I200",
          campo: `Lançamentos em ${mesAno(m.competencia)}`,
          valor: String(m.lancamentos),
          observacao: `limite de referência: ${LIMITE} por mês`,
        },
      ],
    }));
}

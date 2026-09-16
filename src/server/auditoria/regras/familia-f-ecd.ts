import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Evidencia, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família F — escrituração contábil (ECD) lida como um auditor contábil lê.
 *
 * Integridade do livro:
 *   F04 — saldo com natureza invertida (ativo credor, fornecedor devedor)
 *   F06 — saldo inicial que não é o final do mês anterior
 *   F07 — balanço da ECD diferente do informado na ECF (L100/P100)
 *   F08 — plano de contas com referencial ausente ou incompatível
 * Contábil × declarações:
 *   F10 — pró-labore e lucros contabilizados × quadro societário da ECF (Y600)
 *   F20 — IRPJ/CSLL contabilizado × apurado na ECF
 *   F21 — tributo provisionado no passivo × confessado em DCTF
 *   F22 — ICMS, PIS e COFINS apurados nos SPED × contabilizados
 *   F19 — estoque do balanço × inventário do Bloco H
 * Substância:
 *   F11 — depreciação ausente ou acima do custo
 *   F12 — passivo sem movimentação no exercício
 *   F13 — despesas de funcionamento e honorários contábeis não escriturados
 *   F14 — obrigação de folha sem folha escriturada
 *   F16 — caixa elevado e conta bancária sempre zerada
 *   F18 — empréstimo a empresa ou pessoa ligada no ativo
 */

const ZERO = new Prisma.Decimal(0);
const UM = new Prisma.Decimal(1);

// ---------------------------------------------------------------------------
// Carga
// ---------------------------------------------------------------------------

interface Conta {
  documentoId: string;
  codigo: string;
  nome: string;
  natureza: string;
  tipo: string;
  referencial?: string;
  /** Nomes da própria conta e de todas as superiores, em maiúsculas. */
  caminho: string;
}

interface Saldo {
  competencia: string;
  saldoInicial: Prisma.Decimal;
  debitos: Prisma.Decimal;
  creditos: Prisma.Decimal;
  saldoFinal: Prisma.Decimal;
  naturezaSaldo: string;
  linhaOrigem: number | null;
}

interface Livro {
  documentoId: string;
  arquivo: string;
  exercicio: string;
  meses: string[];
  contas: Map<string, Conta>;
  /** codigo → saldos em ordem de competência */
  saldos: Map<string, Saldo[]>;
  /** codigo → competência → { D, C } só de lançamentos que não são de encerramento */
  movimento: Map<string, Map<string, { D: Prisma.Decimal; C: Prisma.Decimal }>>;
}

function semAcento(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase();
}

async function carregarLivros(auditoriaId: string): Promise<Livro[]> {
  const docs = await prisma.documento.findMany({
    where: { auditoriaId, tipo: "ECD", contasContabeis: { some: {} } },
    select: { id: true, nomeArquivo: true },
  });
  const livros: Livro[] = [];
  for (const doc of docs) {
    const brutas = await prisma.contaContabil.findMany({ where: { documentoId: doc.id } });
    const porCodigo = new Map(brutas.map((c) => [c.codigo, c]));
    const contas = new Map<string, Conta>();
    for (const c of brutas) {
      const nomes: string[] = [];
      let atual: typeof c | undefined = c;
      for (let i = 0; atual && i < 12; i++) {
        nomes.push(atual.nome);
        atual = atual.codigoSuperior ? porCodigo.get(atual.codigoSuperior) : undefined;
      }
      contas.set(c.codigo, {
        documentoId: doc.id,
        codigo: c.codigo,
        nome: c.nome,
        natureza: c.natureza,
        tipo: c.tipo,
        referencial: c.referencial ?? undefined,
        caminho: semAcento(nomes.join(" / ")),
      });
    }

    const linhas = await prisma.saldoConta.findMany({
      where: { documentoId: doc.id },
      orderBy: [{ contaCodigo: "asc" }, { competencia: "asc" }],
    });
    const saldos = new Map<string, Saldo[]>();
    const meses = new Set<string>();
    for (const s of linhas) {
      meses.add(s.competencia);
      saldos.set(s.contaCodigo, [...(saldos.get(s.contaCodigo) ?? []), s]);
    }

    const agregados = await prisma.lancamentoContabil.groupBy({
      by: ["contaCodigo", "competencia", "natureza"],
      where: { documentoId: doc.id, NOT: { tipoLancamento: "E" } },
      _sum: { valor: true },
    });
    const movimento: Livro["movimento"] = new Map();
    for (const a of agregados) {
      const porMes = movimento.get(a.contaCodigo) ?? new Map();
      const m = porMes.get(a.competencia) ?? { D: ZERO, C: ZERO };
      m[a.natureza === "C" ? "C" : "D"] = m[a.natureza === "C" ? "C" : "D"].plus(a._sum.valor ?? ZERO);
      porMes.set(a.competencia, m);
      movimento.set(a.contaCodigo, porMes);
    }

    const ordenados = [...meses].sort();
    livros.push({
      documentoId: doc.id,
      arquivo: doc.nomeArquivo,
      exercicio: ordenados[ordenados.length - 1]?.slice(0, 4) ?? "",
      meses: ordenados,
      contas,
      saldos,
      movimento,
    });
  }
  return livros;
}

/** Saldo com sinal: devedor positivo, credor negativo. */
function assinado(valor: Prisma.Decimal, natureza: string): Prisma.Decimal {
  return natureza === "C" ? valor.negated() : valor;
}

function ultimoSaldo(livro: Livro, codigo: string): Saldo | undefined {
  const l = livro.saldos.get(codigo);
  return l?.[l.length - 1];
}

/** Soma do movimento sem encerramento no exercício. */
function movimentoAno(livro: Livro, codigo: string): { D: Prisma.Decimal; C: Prisma.Decimal } {
  let D = ZERO;
  let C = ZERO;
  for (const m of livro.movimento.get(codigo)?.values() ?? []) {
    D = D.plus(m.D);
    C = C.plus(m.C);
  }
  return { D, C };
}

function analiticas(livro: Livro, filtro: (c: Conta) => boolean): Conta[] {
  return [...livro.contas.values()].filter((c) => c.tipo === "A" && filtro(c));
}

function evidenciaSaldo(livro: Livro, conta: Conta, s: Saldo, observacao: string): Evidencia {
  return {
    tipo: "EXEMPLO",
    arquivo: livro.arquivo,
    registro: "I155",
    linha: s.linhaOrigem ?? undefined,
    campo: `${conta.codigo} ${conta.nome}`,
    valor: `${moeda(s.saldoFinal)} ${s.naturezaSaldo === "C" ? "credor" : "devedor"} em ${mesAno(s.competencia)}`,
    observacao,
  };
}

const REDUTORA = /\(-\)|DEPRECIA|AMORTIZA|EXAUST|PROVIS|PERDA|AJUSTE|REDUTOR|A APROPRIAR|PREJUIZ|DISTRIBU|TESOURARIA|RETIRADA|DEVOLU|DESCONTO|ABATIMENTO/;

// ---------------------------------------------------------------------------
// Regra
// ---------------------------------------------------------------------------

export const familiaFEcd: Regra = {
  codigos: ["F04", "F06", "F07", "F08", "F10", "F11", "F12", "F13", "F14", "F16", "F18", "F19", "F20", "F21", "F22"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    if (!ctx.fontesDisponiveis.has("ECD")) return [];
    const livros = await carregarLivros(ctx.auditoriaId);
    const achados: AchadoProduzido[] = [];
    for (const livro of livros) {
      achados.push(...f04NaturezaInvertida(livro));
      achados.push(...f06SaldosNaoEncadeiam(livro));
      achados.push(...f08EstruturaDoPlano(livro));
      achados.push(...f11Depreciacao(livro));
      achados.push(...f12PassivoParado(livro));
      achados.push(...f13DespesasDeFuncionamento(livro));
      achados.push(...f14ObrigacaoDeFolhaSemFolha(livro));
      achados.push(...f16CaixaEBanco(livro));
      achados.push(...f18EmprestimoLigada(livro));
      if (ctx.fontesDisponiveis.has("ECF")) {
        achados.push(...(await f07BalancoEcdEcf(livro, ctx)));
        achados.push(...(await f10SociosEcf(livro, ctx)));
        achados.push(...(await f20IrpjCsllEcdEcf(livro, ctx)));
      }
      if (ctx.fontesDisponiveis.has("DCTF")) achados.push(...(await f21TributoSemDctf(livro, ctx)));
      if (ctx.fontesDisponiveis.has("SPED_FISCAL") || ctx.fontesDisponiveis.has("SPED_CONTRIBUICOES")) {
        achados.push(...(await f22TributosSpedContabil(livro, ctx)));
      }
      if (ctx.fontesDisponiveis.has("SPED_FISCAL")) achados.push(...(await f19EstoqueInventario(livro, ctx)));
    }
    return achados;
  },
};

// ---------------------------------------------------------------------------
// Integridade
// ---------------------------------------------------------------------------

/**
 * F04 — saldo com natureza invertida.
 *
 * Ativo credor, passivo ou patrimônio líquido devedor. Contas redutoras
 * (depreciação, provisões, "(-)"), prejuízos e lucros distribuídos têm saldo
 * contrário por definição e ficam de fora; caixa credor é a F01.
 */
function f04NaturezaInvertida(livro: Livro): AchadoProduzido[] {
  const casos: { conta: Conta; saldos: Saldo[] }[] = [];
  for (const conta of analiticas(livro, (c) => ["01", "02", "03"].includes(c.natureza))) {
    if (REDUTORA.test(conta.caminho)) continue;
    if (conta.natureza === "01" && /^CAIXA\b/.test(semAcento(conta.nome))) continue;
    if (conta.natureza === "02" && /ADIANTAMENTO/.test(conta.caminho)) continue;
    const esperado = conta.natureza === "01" ? "D" : "C";
    const invertidos = (livro.saldos.get(conta.codigo) ?? []).filter(
      (s) => s.naturezaSaldo !== esperado && s.saldoFinal.greaterThanOrEqualTo(UM),
    );
    if (invertidos.length > 0) casos.push({ conta, saldos: invertidos });
  }
  if (casos.length === 0) return [];

  const grupo = (c: Conta) =>
    c.natureza === "01" ? "ativo com saldo credor" : c.natureza === "02" ? "passivo com saldo devedor" : "patrimônio líquido devedor";
  const ultimo = casos.flatMap((c) => c.saldos.map((s) => s.competencia)).sort().pop()!;
  return [
    {
      codigo: "F04",
      competencia: ultimo,
      confianca: "ALTA",
      descricao:
        `${casos.length} conta(s) com saldo de natureza contrária à do grupo em ` +
        `${casos.reduce((n, c) => n + c.saldos.length, 0)} fechamento(s) mensal(is) de ${livro.exercicio}: ` +
        [...new Set(casos.map((c) => grupo(c.conta)))].join(", ") + ".",
      textoCliente:
        `A contabilidade de ${livro.exercicio} tem contas com saldo invertido — ` +
        casos.slice(0, 4).map((c) => `${c.conta.nome} (${grupo(c.conta)})`).join("; ") +
        `. Saldo invertido indica lançamento em conta errada ou pagamento sem o registro de origem.`,
      recomendacao:
        "Analisar a composição de cada conta: reclassificar adiantamentos para a conta própria e " +
        "localizar o lançamento que falta (nota de compra, recebimento, baixa).",
      declarado: true,
      evidencias: casos.slice(0, 15).map((c) => {
        const pior = c.saldos.reduce((a, b) => (b.saldoFinal.greaterThan(a.saldoFinal) ? b : a));
        return evidenciaSaldo(
          livro,
          c.conta,
          pior,
          `${grupo(c.conta)} em ${c.saldos.length} mês(es): ${c.saldos.map((s) => mesAno(s.competencia)).join(", ")}`,
        );
      }),
    },
  ];
}

/**
 * F06 — saldos que não encadeiam.
 *
 * O saldo inicial de um mês é o final do anterior, e o final é o inicial mais
 * débitos menos créditos. Quando não bate, o balancete foi alterado depois de
 * fechado ou o arquivo foi montado com saldos digitados.
 */
function f06SaldosNaoEncadeiam(livro: Livro): AchadoProduzido[] {
  const quebras: { conta: Conta; saldo: Saldo; motivo: string; diferenca: Prisma.Decimal }[] = [];
  for (const [codigo, lista] of livro.saldos) {
    const conta = livro.contas.get(codigo);
    if (!conta) continue;
    for (let i = 0; i < lista.length; i++) {
      const s = lista[i];
      // O indicador D/C do saldo inicial não é gravado; a conferência parte do
      // saldo final do mês anterior, que tem indicador.
      const finalAssinado = assinado(s.saldoFinal, s.naturezaSaldo);
      if (i > 0) {
        const anterior = lista[i - 1];
        const anteriorAssinado = assinado(anterior.saldoFinal, anterior.naturezaSaldo);
        const esperadoFinal = anteriorAssinado.plus(s.debitos).minus(s.creditos);
        const dif = esperadoFinal.minus(finalAssinado).abs();
        if (dif.greaterThan(UM)) {
          quebras.push({
            conta,
            saldo: s,
            diferenca: dif,
            motivo:
              `final de ${mesAno(anterior.competencia)} ${moeda(anterior.saldoFinal)}${anterior.naturezaSaldo} ` +
              `+ débitos ${moeda(s.debitos)} − créditos ${moeda(s.creditos)} ≠ final ${moeda(s.saldoFinal)}${s.naturezaSaldo}`,
          });
        }
      }
      const semMovimento = s.debitos.isZero() && s.creditos.isZero();
      if (semMovimento && s.saldoInicial.minus(s.saldoFinal).abs().greaterThan(UM)) {
        quebras.push({
          conta,
          saldo: s,
          diferenca: s.saldoInicial.minus(s.saldoFinal).abs(),
          motivo: `mês sem movimento com saldo inicial ${moeda(s.saldoInicial)} e final ${moeda(s.saldoFinal)}`,
        });
      }
    }
  }
  if (quebras.length === 0) return [];
  const total = quebras.reduce((s, q) => s.plus(q.diferenca), ZERO);
  return [
    {
      codigo: "F06",
      competencia: quebras.map((q) => q.saldo.competencia).sort().pop(),
      confianca: "ALTA",
      descricao:
        `${quebras.length} fechamento(s) mensal(is) em ${new Set(quebras.map((q) => q.conta.codigo)).size} ` +
        `conta(s) cujo saldo não decorre do saldo anterior e do movimento do mês (diferenças somando ${moeda(total)}).`,
      textoCliente:
        `Na contabilidade de ${livro.exercicio} há saldos que não resultam do mês anterior mais o movimento. ` +
        `O balancete foi alterado depois de fechado ou tem saldos digitados.`,
      recomendacao: "Refazer o encadeamento dos saldos a partir dos lançamentos e retificar a ECD.",
      declarado: true,
      evidencias: quebras.slice(0, 15).map((q) => evidenciaSaldo(livro, q.conta, q.saldo, q.motivo)),
    },
  ];
}

/**
 * F08 — plano de contas.
 *
 * Conta analítica com saldo e sem mapeamento para o referencial da Receita, ou
 * com natureza (I050) incompatível com o grupo do referencial, ou com nome que
 * contradiz o grupo em que foi colocada.
 */
function f08EstruturaDoPlano(livro: Livro): AchadoProduzido[] {
  const casos: { conta: Conta; motivo: string }[] = [];
  const grupoRef: Record<string, RegExp> = { "01": /^1\./, "02": /^2\.0[12]/, "03": /^2\.03/, "04": /^3\./ };
  for (const conta of analiticas(livro, (c) => livro.saldos.has(c.codigo))) {
    const nome = semAcento(conta.nome);
    if (!conta.referencial) {
      casos.push({ conta, motivo: "conta analítica com saldo sem mapeamento ao plano referencial (I051)" });
    } else if (grupoRef[conta.natureza] && !grupoRef[conta.natureza].test(conta.referencial)) {
      casos.push({
        conta,
        motivo: `natureza ${conta.natureza} no I050, mas mapeada para o referencial ${conta.referencial}`,
      });
    }
    if (conta.natureza === "01" && /FORNECEDOR|A RECOLHER|SALARIOS A PAGAR|A PAGAR\b/.test(nome) && !/ADIANTAMENTO|A RECUPERAR/.test(nome)) {
      casos.push({ conta, motivo: "nome de obrigação em conta do ativo" });
    }
    if (conta.natureza === "02" && /A RECUPERAR|^CLIENTES?\b|DUPLICATAS A RECEBER|^CAIXA\b|^ESTOQUE/.test(nome)) {
      casos.push({ conta, motivo: "nome de direito em conta do passivo" });
    }
    if (conta.referencial?.startsWith("1.01.01.01") && !/CAIXA|NUMERARIO|FUNDO FIXO/.test(nome)) {
      casos.push({ conta, motivo: `mapeada como caixa (${conta.referencial}) com nome "${conta.nome}"` });
    }
  }
  if (casos.length === 0) return [];
  return [
    {
      codigo: "F08",
      competencia: livro.meses[livro.meses.length - 1],
      confianca: "ALTA",
      descricao: `${casos.length} inconsistência(s) no plano de contas da ECD de ${livro.exercicio}.`,
      textoCliente:
        `O plano de contas de ${livro.exercicio} tem contas sem classificação no plano da Receita ou ` +
        `classificadas em grupo incompatível, o que distorce o balanço entregue na ECF.`,
      recomendacao: "Revisar o mapeamento referencial (I051) e a natureza das contas apontadas.",
      declarado: true,
      evidencias: casos.slice(0, 15).map((c) => ({
        tipo: "EXEMPLO" as const,
        arquivo: livro.arquivo,
        registro: "I050",
        campo: `${c.conta.codigo} ${c.conta.nome}`,
        valor: c.conta.referencial ?? "sem referencial",
        observacao: c.motivo,
      })),
    },
  ];
}

// ---------------------------------------------------------------------------
// Substância
// ---------------------------------------------------------------------------

/** Taxa anual usual (IN RFB nº 1.700/2017, Anexo III) pelo nome do bem. */
function taxaUsual(nome: string): Prisma.Decimal | undefined {
  if (/VEICUL|AUTOMOV|CAMINH|MOTO/.test(nome)) return new Prisma.Decimal(20);
  if (/COMPUTA|INFORMATICA|PROCESSAMENTO DE DADOS/.test(nome)) return new Prisma.Decimal(20);
  if (/MAQUINA|EQUIPAMENTO/.test(nome)) return new Prisma.Decimal(10);
  if (/MOVEIS|UTENSILIO/.test(nome)) return new Prisma.Decimal(10);
  if (/INSTALAC/.test(nome)) return new Prisma.Decimal(10);
  if (/EDIFIC|PREDIO|CONSTRUC|BENFEITORIA/.test(nome)) return new Prisma.Decimal(4);
  return undefined;
}

/**
 * F11 — depreciação.
 *
 * Bem do imobilizado com custo e sem nenhuma depreciação lançada no exercício,
 * embora ainda não totalmente depreciado; depreciação acumulada maior que o
 * custo; ou taxa efetiva acima da usual, que é adição no Lalur.
 */
function f11Depreciacao(livro: Livro): AchadoProduzido[] {
  const ehImobilizado = (c: Conta) =>
    c.natureza === "01" &&
    (c.referencial?.startsWith("1.02.03") || /IMOBILIZADO/.test(c.caminho)) &&
    !REDUTORA.test(c.caminho) &&
    !/TERRENO|ANDAMENTO|ADIANTAMENTO|CONSORCIO/.test(semAcento(c.nome));
  const ehDepreciacao = (c: Conta) => c.natureza === "01" && /DEPRECIA/.test(c.caminho);

  const deps = analiticas(livro, ehDepreciacao);
  type Caso = { bem: Conta; custo: Prisma.Decimal; acumulada: Prisma.Decimal; noAno: Prisma.Decimal; motivo: string; tipo: "SEM" | "EXCESSO" | "TAXA" };
  const casos: Caso[] = [];
  for (const bem of analiticas(livro, ehImobilizado)) {
    const s = ultimoSaldo(livro, bem.codigo);
    if (!s || s.saldoFinal.lessThan(UM)) continue;
    const nome = semAcento(bem.nome);
    const dep = deps.find((d) => semAcento(d.nome).replace(/^\(-\)\s*/, "").replace(/^DEPRECIACAO (ACUMULADA )?(DE |DO |DA |S\/ )?/, "") === nome);
    const custo = s.saldoFinal;
    const ds = dep ? ultimoSaldo(livro, dep.codigo) : undefined;
    const acumulada = ds?.saldoFinal ?? ZERO;
    const noAno = dep ? movimentoAno(livro, dep.codigo).C : ZERO;

    if (acumulada.greaterThan(custo.plus(UM))) {
      casos.push({ bem, custo, acumulada, noAno, tipo: "EXCESSO", motivo: `depreciação acumulada ${moeda(acumulada)} maior que o custo ${moeda(custo)}` });
      continue;
    }
    if (noAno.isZero() && acumulada.lessThan(custo.minus(UM))) {
      casos.push({
        bem, custo, acumulada, noAno, tipo: "SEM",
        motivo: dep
          ? `nenhuma depreciação lançada em ${livro.exercicio}; acumulada ${moeda(acumulada)} de ${moeda(custo)}`
          : "sem conta de depreciação acumulada correspondente",
      });
      continue;
    }
    const taxa = taxaUsual(nome);
    const inicio = livro.saldos.get(bem.codigo)?.[0]?.saldoInicial ?? custo;
    const base = inicio.plus(custo).dividedBy(2);
    if (taxa && base.greaterThan(0) && noAno.greaterThan(0)) {
      const efetiva = noAno.dividedBy(base).times(100);
      if (efetiva.greaterThan(taxa.times("1.15"))) {
        casos.push({
          bem, custo, acumulada, noAno, tipo: "TAXA",
          motivo: `taxa efetiva de ${efetiva.toFixed(1).replace(".", ",")}% a.a., acima dos ${taxa}% usuais para o bem`,
        });
      }
    }
  }
  if (casos.length === 0) return [];

  const achados: AchadoProduzido[] = [];
  const certos = casos.filter((c) => c.tipo !== "TAXA");
  const taxas = casos.filter((c) => c.tipo === "TAXA");
  const mes = livro.meses[livro.meses.length - 1];
  const evid = (lista: Caso[]) =>
    lista.slice(0, 15).map((c) => ({
      tipo: "EXEMPLO" as const,
      arquivo: livro.arquivo,
      registro: "I155",
      campo: `${c.bem.codigo} ${c.bem.nome}`,
      valor: `custo ${moeda(c.custo)} · depreciado no ano ${moeda(c.noAno)}`,
      observacao: c.motivo,
    }));
  if (certos.length > 0) {
    const semDep = certos.filter((c) => c.tipo === "SEM").reduce((s, c) => s.plus(c.custo), ZERO);
    achados.push({
      codigo: "F11",
      competencia: mes,
      confianca: "ALTA",
      descricao:
        `${certos.length} bem(ns) do imobilizado com depreciação ausente no exercício ou acumulada acima do custo` +
        (semDep.greaterThan(0) ? ` (${moeda(semDep)} de custo sem depreciação em ${livro.exercicio})` : "") + ".",
      textoCliente:
        `Em ${livro.exercicio} parte do imobilizado não foi depreciada — ` +
        certos.slice(0, 4).map((c) => c.bem.nome).join(", ") +
        `. O resultado e o patrimônio ficam distorcidos.`,
      recomendacao: "Calcular a depreciação do período pelo prazo de vida útil de cada bem e lançar o ajuste.",
      declarado: true,
      evidencias: evid(certos),
    });
  }
  if (taxas.length > 0) {
    achados.push({
      codigo: "F11",
      competencia: mes,
      severidade: "BAIXO",
      confianca: "MEDIA",
      descricao: `${taxas.length} bem(ns) depreciado(s) acima da taxa usual da Receita em ${livro.exercicio}.`,
      textoCliente: `Parte do imobilizado foi depreciada acima da taxa fiscal; o excesso deve ser adicionado no Lalur.`,
      recomendacao: "Conferir a taxa pelo NCM do bem e adicionar o excesso na apuração do lucro real.",
      ressalva: "A taxa usual foi inferida pelo nome da conta; confirmar pelo NCM (IN RFB nº 1.700/2017, Anexo III) ou por laudo.",
      declarado: true,
      evidencias: evid(taxas),
    });
  }
  return achados;
}

/**
 * F12 — passivo sem movimentação.
 *
 * Fornecedor ou obrigação de curto prazo com saldo credor que não teve um
 * único débito ou crédito no exercício inteiro. Obrigação que ninguém paga nem
 * cobra é o retrato do passivo fictício: a Lei nº 9.430/1996, art. 40, presume
 * omissão de receita na manutenção no passivo de obrigação não comprovada.
 */
function f12PassivoParado(livro: Livro): AchadoProduzido[] {
  if (livro.meses.length < 6) return [];
  const casos: { conta: Conta; saldo: Saldo }[] = [];
  for (const conta of analiticas(
    livro,
    (c) => c.natureza === "02" && (c.referencial?.startsWith("2.01") ?? /CIRCULANTE|FORNECEDOR/.test(c.caminho)),
  )) {
    if (/PARCELAMENTO|EMPRESTIMO|FINANCIAMENTO/.test(conta.caminho)) continue;
    const lista = livro.saldos.get(conta.codigo) ?? [];
    if (lista.length < livro.meses.length) continue;
    const parado = lista.every((s) => s.debitos.isZero() && s.creditos.isZero());
    const ultimo = lista[lista.length - 1];
    if (parado && ultimo.naturezaSaldo === "C" && ultimo.saldoFinal.greaterThanOrEqualTo(1000)) {
      casos.push({ conta, saldo: ultimo });
    }
  }
  if (casos.length === 0) return [];
  const total = casos.reduce((s, c) => s.plus(c.saldo.saldoFinal), ZERO);
  casos.sort((a, b) => b.saldo.saldoFinal.comparedTo(a.saldo.saldoFinal));
  return [
    {
      codigo: "F12",
      competencia: livro.meses[livro.meses.length - 1],
      confianca: "MEDIA",
      descricao:
        `${casos.length} obrigação(ões) de curto prazo somando ${moeda(total)} sem nenhuma movimentação ` +
        `durante todo o exercício de ${livro.exercicio}.`,
      textoCliente:
        `A empresa mantém ${moeda(total)} em fornecedores e obrigações que não foram pagos nem movimentados ` +
        `em ${livro.exercicio}. Obrigação sem comprovação no passivo é presumida receita omitida.`,
      recomendacao:
        "Circularizar os fornecedores ou obter os documentos que comprovem a dívida; baixar o que já foi pago " +
        "ou prescreveu, avaliando o efeito tributário da baixa.",
      ressalva: "Dívida em discussão ou negociação legítima pode ficar parada; confirmar com o credor.",
      declarado: true,
      evidencias: casos.slice(0, 15).map((c) =>
        evidenciaSaldo(livro, c.conta, c.saldo, `sem débitos nem créditos nos ${livro.meses.length} meses do exercício`),
      ),
    },
  ];
}

const CATEGORIAS_FIXAS: { nome: string; padrao: RegExp }[] = [
  { nome: "energia elétrica", padrao: /ENERGIA|\bLUZ\b/ },
  { nome: "água", padrao: /\bAGUA\b|SANEAMENTO/ },
  { nome: "telefone e internet", padrao: /TELEFON|INTERNET|COMUNICAC/ },
  { nome: "aluguel", padrao: /ALUGUE|LOCACAO DE IMOV/ },
];
const HONORARIOS = /HONORARIO|CONTABILIDADE|ASSESSORIA CONTABIL|SERVICOS CONTABEIS|ESCRITORIO CONTABIL/;

/**
 * F13 — despesas de funcionamento.
 *
 * Empresa em atividade paga energia, água, telefone, aluguel e contador todo
 * mês. Categoria que aparece em alguns meses e some em outros, ou honorário
 * contábil que não aparece em nenhum, mostra despesa paga por fora da
 * contabilidade — com dinheiro que também não passou por ela.
 */
function f13DespesasDeFuncionamento(livro: Livro): AchadoProduzido[] {
  const despesas = analiticas(livro, (c) => c.natureza === "04");
  const mesesCom = (padrao: RegExp) => {
    const meses = new Map<string, Prisma.Decimal>();
    for (const c of despesas.filter((d) => padrao.test(semAcento(d.nome)))) {
      for (const [mes, m] of livro.movimento.get(c.codigo) ?? []) {
        if (m.D.greaterThan(0)) meses.set(mes, (meses.get(mes) ?? ZERO).plus(m.D));
      }
    }
    return meses;
  };

  const achados: AchadoProduzido[] = [];
  const ultimo = livro.meses[livro.meses.length - 1];
  const lacunas: Evidencia[] = [];
  let algumaFixa = false;
  for (const cat of CATEGORIAS_FIXAS) {
    const meses = mesesCom(cat.padrao);
    if (meses.size === 0) continue;
    algumaFixa = true;
    const faltam = livro.meses.filter((m) => !meses.has(m));
    if (faltam.length > 0 && faltam.length < livro.meses.length) {
      lacunas.push({
        tipo: "EXEMPLO",
        arquivo: livro.arquivo,
        registro: "I250",
        campo: cat.nome,
        valor: `lançada em ${meses.size} de ${livro.meses.length} meses`,
        observacao: `sem lançamento em ${faltam.map(mesAno).join(", ")}`,
      });
    }
  }
  if (lacunas.length > 0) {
    achados.push({
      codigo: "F13",
      competencia: ultimo,
      severidade: "BAIXO",
      confianca: "MEDIA",
      descricao: `${lacunas.length} despesa(s) fixa(s) sem lançamento em parte dos meses de ${livro.exercicio}.`,
      textoCliente: `Despesas fixas de funcionamento não foram contabilizadas em todos os meses de ${livro.exercicio}.`,
      recomendacao: "Localizar as faturas dos meses faltantes e contabilizá-las na competência.",
      ressalva: "Fatura bimestral ou lançada em conta de nome diferente explica parte das ausências.",
      declarado: true,
      evidencias: lacunas,
    });
  }
  if (!algumaFixa && livro.meses.length >= 6) {
    achados.push({
      codigo: "F13",
      competencia: ultimo,
      severidade: "ALTO",
      confianca: "MEDIA",
      descricao: `Nenhuma despesa de energia, água, telefone ou aluguel contabilizada em ${livro.exercicio}.`,
      textoCliente:
        `A contabilidade de ${livro.exercicio} não mostra as despesas mínimas de funcionamento. Ou a empresa ` +
        `não opera no endereço, ou essas despesas são pagas por fora da contabilidade.`,
      recomendacao: "Confirmar onde a empresa funciona e quem paga as despesas do estabelecimento.",
      declarado: true,
      evidencias: [{ tipo: "CONTEXTO", arquivo: livro.arquivo, registro: "I050", observacao: "nenhuma conta de resultado com esses nomes teve débito no exercício" }],
    });
  }
  const honorarios = mesesCom(HONORARIOS);
  if (honorarios.size === 0 && livro.meses.length >= 6) {
    achados.push({
      codigo: "F13",
      competencia: ultimo,
      severidade: "MEDIO",
      confianca: "MEDIA",
      descricao: `Nenhuma despesa com honorários contábeis lançada em ${livro.exercicio}, embora a escrituração seja feita por contador.`,
      textoCliente:
        `A empresa não contabilizou nenhum pagamento de honorários contábeis em ${livro.exercicio}. ` +
        `A despesa existe — a ECD é assinada por contador — e foi paga por fora da contabilidade.`,
      recomendacao: "Contabilizar os honorários pelos recibos ou notas do escritório de contabilidade.",
      ressalva: "Os honorários podem estar lançados em conta de nome genérico (serviços de terceiros, despesas diversas).",
      declarado: true,
      evidencias: [{ tipo: "CONTEXTO", arquivo: livro.arquivo, registro: "I050", observacao: "nenhuma conta de resultado com nome de honorários ou contabilidade teve débito no exercício" }],
    });
  }
  return achados;
}

/**
 * F14 — obrigação de folha sem folha.
 *
 * Sem salário, férias ou 13º contabilizados, saldo em FGTS, salários ou férias
 * a pagar não tem origem. Pró-labore e o INSS dele não contam como folha.
 */
function f14ObrigacaoDeFolhaSemFolha(livro: Livro): AchadoProduzido[] {
  const FOLHA = /SALARIO|ORDENADO|FERIAS|13.? ?SALARIO|DECIMO TERCEIRO|FGTS|RESCIS|HORAS? EXTRA|VALE.?TRANSPORTE/;
  const temFolha = analiticas(livro, (c) => c.natureza === "04" && FOLHA.test(semAcento(c.nome))).some((c) =>
    movimentoAno(livro, c.codigo).D.greaterThan(0),
  );
  if (temFolha) return [];
  const casos = analiticas(livro, (c) => c.natureza === "02" && /FGTS|SALARIOS? A PAGAR|FERIAS A PAGAR|13.? ?SALARIO|RESCIS/.test(semAcento(c.nome)))
    .map((conta) => ({ conta, saldo: ultimoSaldo(livro, conta.codigo) }))
    .filter((c): c is { conta: Conta; saldo: Saldo } => !!c.saldo && c.saldo.saldoFinal.greaterThanOrEqualTo(UM));
  if (casos.length === 0) return [];
  const total = casos.reduce((s, c) => s.plus(c.saldo.saldoFinal), ZERO);
  return [
    {
      codigo: "F14",
      competencia: livro.meses[livro.meses.length - 1],
      confianca: "ALTA",
      descricao:
        `A empresa não tem folha de salários escriturada em ${livro.exercicio}, mas mantém ${moeda(total)} em ` +
        `obrigações de folha (${casos.map((c) => c.conta.nome).join(", ")}).`,
      textoCliente:
        `Sem funcionários registrados na contabilidade de ${livro.exercicio}, os saldos de ` +
        `${casos.map((c) => c.conta.nome).join(", ")} não têm origem e precisam ser baixados ou explicados.`,
      recomendacao: "Identificar a origem dos saldos (período anterior com folha, erro de lançamento) e regularizá-los.",
      declarado: true,
      evidencias: casos.map((c) => evidenciaSaldo(livro, c.conta, c.saldo, "obrigação de folha sem salário, férias ou 13º lançados no exercício")),
    },
  ];
}

/**
 * F16 — caixa elevado e banco sempre zerado.
 *
 * Caixa acima da receita média mensal por três meses ou mais não é dinheiro
 * guardado: é pagamento que saiu sem registro ou recebimento lançado no caixa
 * para não passar pelo banco. Conta bancária que fecha todos os meses em zero,
 * com movimento, não está conciliada com o extrato.
 */
function f16CaixaEBanco(livro: Livro): AchadoProduzido[] {
  const achados: AchadoProduzido[] = [];
  const receitaContas = analiticas(livro, (c) => c.natureza === "04" && (c.referencial?.startsWith("3.01.01.01.01") ?? false) && !REDUTORA.test(c.caminho));
  const receita = receitaContas.reduce((s, c) => s.plus(movimentoAno(livro, c.codigo).C), ZERO);
  const mediaMensal = livro.meses.length > 0 ? receita.dividedBy(livro.meses.length) : ZERO;

  const caixas = analiticas(livro, (c) => c.natureza === "01" && (c.referencial?.startsWith("1.01.01.01") ?? /^CAIXA\b/.test(semAcento(c.nome))));
  if (mediaMensal.greaterThan(0)) {
    const meses = new Map<string, Prisma.Decimal>();
    for (const c of caixas) {
      for (const s of livro.saldos.get(c.codigo) ?? []) {
        if (s.naturezaSaldo === "D") meses.set(s.competencia, (meses.get(s.competencia) ?? ZERO).plus(s.saldoFinal));
      }
    }
    const altos = [...meses].filter(([, v]) => v.greaterThan(mediaMensal) && v.greaterThan(50000));
    if (altos.length >= 3) {
      const maior = altos.reduce((a, b) => (b[1].greaterThan(a[1]) ? b : a));
      achados.push({
        codigo: "F16",
        competencia: maior[0],
        confianca: "MEDIA",
        descricao:
          `Caixa acima da receita média mensal (${moeda(mediaMensal)}) em ${altos.length} mês(es) de ${livro.exercicio}; ` +
          `maior saldo ${moeda(maior[1])} em ${mesAno(maior[0])}.`,
        textoCliente:
          `O caixa da empresa chegou a ${moeda(maior[1])} em espécie, mais que uma receita mensal inteira. ` +
          `Saldo assim costuma esconder pagamentos não contabilizados.`,
        recomendacao: "Fazer a contagem física do caixa e conciliar com o saldo contábil; lançar os pagamentos que faltam.",
        ressalva: "Empresa que recebe muito em espécie pode ter caixa alto legítimo por poucos dias.",
        declarado: true,
        evidencias: altos.slice(0, 12).map(([mes, v]) => ({
          tipo: "EXEMPLO" as const,
          arquivo: livro.arquivo,
          registro: "I155",
          campo: "Caixa",
          valor: `${moeda(v)} em ${mesAno(mes)}`,
          observacao: `receita média mensal de ${moeda(mediaMensal)}`,
        })),
      });
    }
  }

  const bancos = analiticas(livro, (c) => c.natureza === "01" && (c.referencial?.startsWith("1.01.01.02") ?? false) && /C\/C|CONTA CORRENTE|MOVIMENTO|\bBANCO\b/.test(semAcento(c.nome)));
  const zerados = bancos.filter((c) => {
    const lista = livro.saldos.get(c.codigo) ?? [];
    return lista.length >= 6 && lista.every((s) => s.saldoFinal.isZero()) && lista.some((s) => s.debitos.greaterThan(0));
  });
  if (zerados.length > 0) {
    achados.push({
      codigo: "F16",
      competencia: livro.meses[livro.meses.length - 1],
      severidade: "MEDIO",
      confianca: "ALTA",
      descricao: `${zerados.length} conta(s) bancária(s) com movimento e saldo zero em todos os meses de ${livro.exercicio}.`,
      textoCliente:
        `A conta bancária fecha todo mês exatamente em zero, apesar do movimento. O saldo contábil não é o do ` +
        `extrato: a conta não é conciliada, e o banco é ajustado contra o caixa.`,
      recomendacao: "Conciliar o banco com os extratos mês a mês e lançar as diferenças pela origem.",
      declarado: true,
      evidencias: zerados.map((c) => {
        const mov = movimentoAno(livro, c.codigo);
        return {
          tipo: "EXEMPLO" as const,
          arquivo: livro.arquivo,
          registro: "I155",
          campo: `${c.codigo} ${c.nome}`,
          valor: `débitos ${moeda(mov.D)} · créditos ${moeda(mov.C)}`,
          observacao: "saldo final zero em todos os meses",
        };
      }),
    });
  }
  return achados;
}

/**
 * F18 — empréstimo a empresa ou pessoa ligada.
 *
 * Mútuo no ativo com sócio ou outra empresa: sem contrato e juros, é
 * distribuição disfarçada; com ou sem eles, o mútuo entre pessoas jurídicas
 * sofre IOF.
 */
function f18EmprestimoLigada(livro: Livro): AchadoProduzido[] {
  const casos = analiticas(
    livro,
    (c) =>
      c.natureza === "01" &&
      /EMPRESTIMO|MUTUO|PARTES RELACIONADAS|PESSOAS LIGADAS|CONTA CORRENTE (DE )?(SOCIO|EMPRESA|COLIGADA|CONTROLADA)|CREDITOS? COM (SOCIO|EMPRESA|COLIGADA)/.test(c.caminho) &&
      !/FUNCIONARIO|EMPREGADO|APLICAC/.test(c.caminho),
  )
    .map((conta) => ({ conta, saldo: ultimoSaldo(livro, conta.codigo) }))
    .filter((c): c is { conta: Conta; saldo: Saldo } => !!c.saldo && c.saldo.naturezaSaldo === "D" && c.saldo.saldoFinal.greaterThanOrEqualTo(1000));
  if (casos.length === 0) return [];
  const total = casos.reduce((s, c) => s.plus(c.saldo.saldoFinal), ZERO);
  return [
    {
      codigo: "F18",
      competencia: livro.meses[livro.meses.length - 1],
      confianca: "MEDIA",
      descricao: `${moeda(total)} emprestados a empresas ou pessoas ligadas, registrados no ativo em ${livro.exercicio}.`,
      textoCliente:
        `A empresa tem ${moeda(total)} emprestados a terceiros ligados. Sem contrato, juros e IOF, o empréstimo ` +
        `é tratado como distribuição disfarçada de lucros.`,
      recomendacao: "Formalizar os contratos de mútuo, recolher o IOF e conferir se há pagamentos da empresa ligada lançados como despesa.",
      ressalva: "Confirmar a natureza da conta pela composição dos lançamentos.",
      declarado: true,
      evidencias: casos.slice(0, 15).map((c) => evidenciaSaldo(livro, c.conta, c.saldo, "conta de empréstimo ou mútuo no ativo")),
    },
  ];
}

// ---------------------------------------------------------------------------
// Contábil × declarações
// ---------------------------------------------------------------------------

/**
 * F07 — balanço da ECD × ECF.
 *
 * A ECF recupera o balanço da ECD pelo plano referencial (L100/P100). Linha
 * analítica do referencial cujo saldo final não é a soma das contas da ECD
 * mapeadas para ela mostra ECF preenchida à mão ou ECD retificada depois.
 */
async function f07BalancoEcdEcf(livro: Livro, ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const linhas = await prisma.linhaEcf.findMany({
    where: { documento: { auditoriaId: ctx.auditoriaId }, registro: { in: ["L100", "P100"] }, exercicio: Number(livro.exercicio) },
    orderBy: { dataFim: "asc" },
  });
  if (linhas.length === 0) return [];
  const fim = linhas[linhas.length - 1].dataFim;
  const doFim = linhas.filter((l) => l.dataFim.getTime() === fim.getTime());
  const codigos = new Set(doFim.map((l) => l.codigo));
  const folhas = doFim.filter((l) => ![...codigos].some((c) => c !== l.codigo && c.startsWith(`${l.codigo}.`)));
  const mes = `${fim.getUTCFullYear()}-${String(fim.getUTCMonth() + 1).padStart(2, "0")}`;

  const somaEcd = (ref: string) => {
    let s = ZERO;
    let achou = false;
    for (const c of livro.contas.values()) {
      if (c.tipo !== "A" || !c.referencial || (c.referencial !== ref && !c.referencial.startsWith(`${ref}.`))) continue;
      const saldo = livro.saldos.get(c.codigo)?.find((x) => x.competencia === mes);
      if (!saldo) continue;
      achou = true;
      s = s.plus(assinado(saldo.saldoFinal, saldo.naturezaSaldo));
    }
    return achou ? s : undefined;
  };

  const casos: { codigo: string; descricao: string; ecf: Prisma.Decimal; ecd: Prisma.Decimal }[] = [];
  for (const l of folhas) {
    const ecf = assinado(l.valor ?? ZERO, l.indicador ?? "D");
    const ecd = somaEcd(l.codigo) ?? ZERO;
    if (ecf.minus(ecd).abs().greaterThan(UM)) casos.push({ codigo: l.codigo, descricao: l.descricao, ecf, ecd });
  }
  if (casos.length === 0) return [];
  const fmt = (v: Prisma.Decimal) => `${moeda(v.abs())} ${v.isNegative() ? "C" : "D"}`;
  return [
    {
      codigo: "F07",
      competencia: mes,
      confianca: "ALTA",
      descricao: `${casos.length} linha(s) do balanço da ECF de ${livro.exercicio} com saldo diferente da ECD em ${mesAno(mes)}.`,
      textoCliente:
        `O balanço entregue na ECF de ${livro.exercicio} não é o da contabilidade: ${casos.length} linha(s) divergem ` +
        `do livro registrado na ECD.`,
      recomendacao: "Recuperar novamente a ECD na ECF e retificar a declaração.",
      declarado: true,
      evidencias: casos.slice(0, 15).map((c) => ({
        tipo: "CONFRONTO" as const,
        arquivo: "ECF × ECD",
        registro: "L100",
        campo: `${c.codigo} ${c.descricao}`,
        valor: `ECF ${fmt(c.ecf)} · ECD ${fmt(c.ecd)}`,
        observacao: `diferença de ${moeda(c.ecf.minus(c.ecd).abs())}`,
      })),
    },
  ];
}

/**
 * F10 — sócios.
 *
 * O Y600 da ECF informa, por sócio, o percentual do capital, a remuneração do
 * trabalho (pró-labore) e os lucros distribuídos. O que a contabilidade lançou
 * tem de ser o que a ECF declarou — é daí que a Receita cruza a DIRPF do sócio.
 */
async function f10SociosEcf(livro: Livro, ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const socios = await prisma.socioEcf.findMany({
    where: { documento: { auditoriaId: ctx.auditoriaId }, exercicio: Number(livro.exercicio) },
  });
  if (socios.length === 0) return [];
  const evid: Evidencia[] = [];

  const proLaboreContas = analiticas(livro, (c) => c.natureza === "04" && /PRO.?LABORE/.test(semAcento(c.nome)));
  const proLabore = proLaboreContas.reduce((s, c) => s.plus(movimentoAno(livro, c.codigo).D), ZERO);
  const remuneracaoEcf = socios.reduce((s, x) => s.plus(x.remuneracaoTrabalho ?? ZERO), ZERO);
  if (proLabore.minus(remuneracaoEcf).abs().greaterThan(UM)) {
    evid.push({
      tipo: "CONFRONTO",
      arquivo: "ECD × ECF (Y600)",
      campo: "Pró-labore",
      valor: `contabilizado ${moeda(proLabore)} · declarado na ECF ${moeda(remuneracaoEcf)}`,
      observacao: [...new Set(proLaboreContas.map((c) => c.nome))].join(", ") || "nenhuma conta de pró-labore",
    });
  }

  const lucrosContas = analiticas(livro, (c) => ["02", "03"].includes(c.natureza) && /LUCROS? DISTRIBUI|DIVIDENDO|LUCROS? A (PAGAR|DISTRIBUIR)/.test(semAcento(c.nome)));
  const distribuido = lucrosContas.reduce((s, c) => {
    const mov = movimentoAno(livro, c.codigo);
    return s.plus(c.natureza === "03" ? mov.D : mov.C);
  }, ZERO);
  const lucrosEcf = socios.reduce((s, x) => s.plus(x.lucrosDividendos ?? ZERO), ZERO);
  if (distribuido.minus(lucrosEcf).abs().greaterThan(UM)) {
    evid.push({
      tipo: "CONFRONTO",
      arquivo: "ECD × ECF (Y600)",
      campo: "Lucros distribuídos",
      valor: `contabilizado ${moeda(distribuido)} · declarado na ECF ${moeda(lucrosEcf)}`,
      observacao: lucrosContas.map((c) => c.nome).join(", ") || "nenhuma conta de lucros distribuídos",
    });
  }

  if (lucrosEcf.greaterThan(0) && socios.filter((s) => (s.lucrosDividendos ?? ZERO).greaterThan(0)).length > 1) {
    for (const s of socios) {
      const parte = (s.lucrosDividendos ?? ZERO).dividedBy(lucrosEcf).times(100);
      const capital = s.percentualCapital ?? ZERO;
      if (parte.minus(capital).abs().greaterThan(1)) {
        evid.push({
          tipo: "EXEMPLO",
          arquivo: "ECF (Y600)",
          campo: s.nome,
          valor: `${parte.toFixed(1).replace(".", ",")}% dos lucros · ${capital.toFixed(1).replace(".", ",")}% do capital`,
          observacao: "distribuição desproporcional à participação",
        });
      }
    }
  }
  if (evid.length === 0) return [];
  return [
    {
      codigo: "F10",
      competencia: livro.meses[livro.meses.length - 1],
      confianca: "ALTA",
      descricao: `Remuneração e lucros dos sócios em ${livro.exercicio} divergem entre a contabilidade e o quadro societário da ECF.`,
      textoCliente:
        `O que a contabilidade pagou aos sócios em ${livro.exercicio} não é o que a ECF declarou. A Receita cruza ` +
        `o Y600 com a declaração de IR de cada sócio.`,
      recomendacao:
        "Retificar o Y600 da ECF com os valores contabilizados; distribuição desproporcional só com previsão no contrato social.",
      ressalva: evid.some((e) => e.observacao === "distribuição desproporcional à participação")
        ? "Distribuição desproporcional é válida quando o contrato social a prevê."
        : undefined,
      declarado: true,
      evidencias: evid,
    },
  ];
}

const NOME_IRPJ = /\bIRPJ\b|IMPOSTO DE RENDA/;
const NOME_CSLL = /\bCSLL\b|CONTRIBUICAO SOCIAL|CONTR\.? ?SOCIAL/;

/** "2025-03" → trimestre que termina nele. */
function trimestreDe(mes: string): string {
  const [ano, m] = mes.split("-").map(Number);
  return `${ano}-${String(Math.ceil(m / 3) * 3).padStart(2, "0")}`;
}

/**
 * F20 — IRPJ/CSLL contabilizado × apurado na ECF.
 *
 * A despesa de IRPJ e CSLL do trimestre é o imposto que a ECF apurou (antes
 * das deduções). Divergência é provisão sem cálculo ou ECF feita à parte.
 */
async function f20IrpjCsllEcdEcf(livro: Livro, ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const apuracoes = await prisma.apuracaoEcf.findMany({
    where: { documento: { auditoriaId: ctx.auditoriaId }, periodo: { startsWith: livro.exercicio } },
    orderBy: { documento: { createdAt: "asc" } },
  });
  if (apuracoes.length === 0) return [];
  const ecf = new Map<string, Prisma.Decimal>();
  for (const a of apuracoes) ecf.set(`${a.tributo}|${a.periodo}`, a.valorApurado);
  const anual = apuracoes.every((a) => a.periodo.endsWith("-12"));

  const casos: Evidencia[] = [];
  let diferencaTotal = ZERO;
  for (const [tributo, padrao] of [["IRPJ", NOME_IRPJ], ["CSLL", NOME_CSLL]] as const) {
    const contas = analiticas(livro, (c) => c.natureza === "04" && padrao.test(semAcento(c.nome)) && !/DIFERID|RETID|A RECUPERAR/.test(semAcento(c.nome)));
    if (contas.length === 0) continue;
    const porPeriodo = new Map<string, Prisma.Decimal>();
    for (const c of contas) {
      for (const [mes, m] of livro.movimento.get(c.codigo) ?? []) {
        const p = anual ? `${livro.exercicio}-12` : trimestreDe(mes);
        porPeriodo.set(p, (porPeriodo.get(p) ?? ZERO).plus(m.D).minus(m.C));
      }
    }
    for (const [periodo, apurado] of ecf) {
      if (!periodo.startsWith(`${tributo}|`)) continue;
      const p = periodo.split("|")[1];
      const contabil = porPeriodo.get(p) ?? ZERO;
      const dif = contabil.minus(apurado);
      if (dif.abs().greaterThan(UM)) {
        diferencaTotal = diferencaTotal.plus(dif.abs());
        casos.push({
          tipo: "CONFRONTO",
          arquivo: "ECD × ECF",
          campo: `${tributo} ${anual ? livro.exercicio : `${Number(p.slice(5)) / 3}º trimestre de ${livro.exercicio}`}`,
          valor: `contabilizado ${moeda(contabil)} · apurado na ECF ${moeda(apurado)}`,
          observacao: `diferença de ${moeda(dif.abs())} (${contas.map((c) => c.nome).join(", ")})`,
        });
      }
    }
  }
  if (casos.length === 0) return [];
  return [
    {
      codigo: "F20",
      competencia: `${livro.exercicio}-12`,
      confianca: "ALTA",
      descricao: `${casos.length} período(s) de ${livro.exercicio} com IRPJ/CSLL contabilizado diferente do apurado na ECF (diferenças de ${moeda(diferencaTotal)}).`,
      textoCliente:
        `O IRPJ e a CSLL lançados na contabilidade de ${livro.exercicio} não são os apurados na ECF. O resultado ` +
        `do balanço e a base do imposto partem de números diferentes.`,
      recomendacao: "Refazer a provisão pelo cálculo da ECF e ajustar o resultado; se a ECF estiver errada, retificá-la e a DCTF.",
      declarado: true,
      evidencias: casos,
    },
  ];
}

const TRIBUTOS_PASSIVO: { tributo: string; padrao: RegExp; trimestral?: boolean }[] = [
  { tributo: "IRPJ", padrao: NOME_IRPJ, trimestral: true },
  { tributo: "CSLL", padrao: NOME_CSLL, trimestral: true },
  { tributo: "PIS", padrao: /\bPIS\b/ },
  { tributo: "COFINS", padrao: /COFINS/ },
  { tributo: "IPI", padrao: /\bIPI\b/ },
];

/**
 * F21 — tributo provisionado no passivo e não confessado em DCTF.
 *
 * O crédito na conta de tributo a recolher é o débito reconhecido pela
 * empresa. Sem DCTF com o mesmo tributo e competência, o débito só existe no
 * balanço: não foi declarado, não há confissão e a Receita pode lançar de
 * ofício com multa de 75%.
 */
async function f21TributoSemDctf(livro: Livro, ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const confissoes = await prisma.confissao.findMany({
    where: { documento: { auditoriaId: ctx.auditoriaId }, competencia: { startsWith: livro.exercicio } },
    orderBy: { dataDeclaracao: "asc" },
  });
  // Mesmo débito repetido em várias DCTFs: vale o da declaração mais recente.
  const declarado = new Map<string, Prisma.Decimal>();
  const porCodigo = new Map<string, Prisma.Decimal>();
  for (const c of confissoes) porCodigo.set(`${c.tributo}|${c.competencia}|${c.codigoReceita ?? ""}`, c.valorDebito);
  for (const [k, v] of porCodigo) {
    const [tributo, competencia] = k.split("|");
    declarado.set(`${tributo}|${competencia}`, (declarado.get(`${tributo}|${competencia}`) ?? ZERO).plus(v));
  }
  const mesesComDctf = new Set(confissoes.map((c) => c.competencia));

  const semDeclaracao: Evidencia[] = [];
  const divergentes: Evidencia[] = [];
  let totalSem = ZERO;
  for (const t of TRIBUTOS_PASSIVO) {
    const contas = analiticas(livro, (c) => c.natureza === "02" && t.padrao.test(semAcento(c.nome)) && !/A RECUPERAR|PARCELAMENTO|RETID/.test(semAcento(c.nome)));
    if (contas.length === 0) continue;
    // A DCTF confessa o débito líquido dos créditos. No não cumulativo o
    // crédito sai da conta "a recuperar" para a "a recolher" no mesmo mês; o
    // provisionado comparável é o bruto menos essa transferência.
    const recuperar = analiticas(livro, (c) => c.natureza === "01" && t.padrao.test(semAcento(c.nome)) && /A RECUPERAR|A COMPENSAR/.test(semAcento(c.nome)));
    const porMes = new Map<string, Prisma.Decimal>();
    for (const c of contas) {
      for (const [mes, m] of livro.movimento.get(c.codigo) ?? []) {
        const p = t.trimestral ? trimestreDe(mes) : mes;
        porMes.set(p, (porMes.get(p) ?? ZERO).plus(m.C));
      }
    }
    for (const c of recuperar) {
      for (const [mes, m] of livro.movimento.get(c.codigo) ?? []) {
        const p = t.trimestral ? trimestreDe(mes) : mes;
        porMes.set(p, (porMes.get(p) ?? ZERO).minus(m.C));
      }
    }
    for (const [mes, provisionado] of porMes) {
      if (provisionado.lessThan(UM)) continue;
      const dctf = declarado.get(`${t.tributo}|${mes}`) ?? ZERO;
      if (dctf.isZero()) {
        totalSem = totalSem.plus(provisionado);
        semDeclaracao.push({
          tipo: "CONFRONTO",
          arquivo: "ECD × DCTF",
          campo: `${t.tributo} ${mesAno(mes)}`,
          valor: `provisionado ${moeda(provisionado)} · DCTF ${mesesComDctf.has(mes) ? "sem este tributo" : "não localizada"}`,
          observacao: contas.map((c) => c.nome).join(", "),
        });
      } else if (provisionado.minus(dctf).abs().greaterThan(UM)) {
        divergentes.push({
          tipo: "CONFRONTO",
          arquivo: "ECD × DCTF",
          campo: `${t.tributo} ${mesAno(mes)}`,
          valor: `provisionado ${moeda(provisionado)} · confessado ${moeda(dctf)}`,
          observacao: `diferença de ${moeda(provisionado.minus(dctf).abs())}`,
        });
      }
    }
  }
  const achados: AchadoProduzido[] = [];
  if (semDeclaracao.length > 0) {
    achados.push({
      codigo: "F21",
      competencia: `${livro.exercicio}-12`,
      confianca: "ALTA",
      descricao: `${semDeclaracao.length} débito(s) de tributo federal provisionado(s) em ${livro.exercicio} sem confissão em DCTF, somando ${moeda(totalSem)}.`,
      textoCliente:
        `A contabilidade reconhece ${moeda(totalSem)} de tributos federais em ${livro.exercicio} que não aparecem em ` +
        `nenhuma DCTF. O débito existe só no balanço, sem declaração — sujeito a lançamento de ofício com multa de 75%.`,
      recomendacao: "Transmitir ou retificar as DCTF das competências apontadas antes de qualquer procedimento fiscal.",
      ressalva: "Confirmar se todas as DCTF do período foram importadas; a ausência do arquivo parece ausência de declaração.",
      valorExposicao: totalSem,
      declarado: false,
      evidencias: semDeclaracao.slice(0, 15),
    });
  }
  if (divergentes.length > 0) {
    achados.push({
      codigo: "F21",
      competencia: `${livro.exercicio}-12`,
      severidade: "MEDIO",
      confianca: "MEDIA",
      descricao: `${divergentes.length} competência(s) de ${livro.exercicio} com tributo provisionado diferente do confessado em DCTF.`,
      textoCliente: `Em ${divergentes.length} competência(s) o tributo contabilizado não é o declarado em DCTF.`,
      recomendacao: "Conciliar a provisão com a DCTF e retificar o lado errado.",
      ressalva: "Juros, multa e parcelamento lançados na mesma conta também geram diferença.",
      declarado: true,
      evidencias: divergentes.slice(0, 15),
    });
  }
  return achados;
}

/**
 * F22 — tributos apurados nos SPED × contabilizados.
 *
 * O débito do E110 (ICMS) e as contribuições do M210/M610 (PIS/COFINS) são o
 * que a empresa declarou dever no mês; a contabilidade tem de reconhecer o
 * mesmo valor na conta a recolher. Só competências presentes nos dois lados.
 */
async function f22TributosSpedContabil(livro: Livro, ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const [icms, contrib] = await Promise.all([
    prisma.apuracaoFiscal.findMany({ where: { documento: { auditoriaId: ctx.auditoriaId }, competencia: { startsWith: livro.exercicio } } }),
    prisma.apuracaoContribuicoes.findMany({ where: { documento: { auditoriaId: ctx.auditoriaId }, competencia: { startsWith: livro.exercicio } } }),
  ]);
  const sped = new Map<string, Prisma.Decimal>();
  for (const a of icms) sped.set(`ICMS|${a.competencia}`, (sped.get(`ICMS|${a.competencia}`) ?? ZERO).plus(a.debitos));
  for (const a of contrib) sped.set(`${a.contribuicao}|${a.competencia}`, a.valorApurado);
  if (sped.size === 0) return [];

  const padroes: Record<string, RegExp> = { ICMS: /\bICMS\b/, PIS: /\bPIS\b/, COFINS: /COFINS/ };
  const casos: Evidencia[] = [];
  let total = ZERO;
  for (const [tributo, padrao] of Object.entries(padroes)) {
    const contas = analiticas(livro, (c) => c.natureza === "02" && padrao.test(semAcento(c.nome)) && !/ST\b|SUBSTITUI|DIFAL|PARCELAMENTO|RETID|ANTECIPA/.test(semAcento(c.nome)));
    if (contas.length === 0) continue;
    for (const mes of livro.meses) {
      const declarado = sped.get(`${tributo}|${mes}`);
      if (declarado === undefined) continue;
      const contabil = contas.reduce((s, c) => s.plus(livro.movimento.get(c.codigo)?.get(mes)?.C ?? ZERO), ZERO);
      const dif = contabil.minus(declarado);
      if (dif.abs().greaterThan(UM)) {
        total = total.plus(dif.abs());
        casos.push({
          tipo: "CONFRONTO",
          arquivo: tributo === "ICMS" ? "EFD ICMS/IPI (E110) × ECD" : "EFD-Contribuições × ECD",
          campo: `${tributo} ${mesAno(mes)}`,
          valor: `apurado ${moeda(declarado)} · contabilizado ${moeda(contabil)}`,
          observacao: `diferença de ${moeda(dif.abs())} · ${contas.map((c) => c.nome).join(", ")}`,
        });
      }
    }
  }
  if (casos.length === 0) return [];
  return [
    {
      codigo: "F22",
      competencia: `${livro.exercicio}-12`,
      confianca: "ALTA",
      descricao: `${casos.length} competência(s) de ${livro.exercicio} com ICMS, PIS ou COFINS contabilizado diferente do apurado nos SPED (diferenças de ${moeda(total)}).`,
      textoCliente:
        `O imposto que a contabilidade reconhece não é o que a empresa declarou nos SPED em ${casos.length} ` +
        `competência(s). O passivo tributário do balanço está errado.`,
      recomendacao: "Conciliar mês a mês a conta a recolher com a apuração do SPED e lançar os ajustes.",
      declarado: true,
      evidencias: casos.slice(0, 15),
    },
  ];
}

/**
 * F19 — estoque do balanço × inventário.
 *
 * O saldo das contas de estoque em 31/12 é o inventário do Bloco H (H005) da
 * EFD que o informa. Diferença distorce o custo e o lucro do exercício.
 */
async function f19EstoqueInventario(livro: Livro, ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const fim = new Date(Date.UTC(Number(livro.exercicio), 11, 31));
  const inventario = await prisma.inventario.findFirst({
    where: { documento: { auditoriaId: ctx.auditoriaId }, dataInventario: fim },
    include: { documento: { select: { nomeArquivo: true } } },
    orderBy: { documento: { createdAt: "desc" } },
  });
  if (!inventario?.valor) return [];
  const contas = analiticas(livro, (c) => c.natureza === "01" && (c.referencial?.startsWith("1.01.03") ?? /ESTOQUE/.test(c.caminho)) && !REDUTORA.test(c.caminho));
  const mes = `${livro.exercicio}-12`;
  const saldo = contas.reduce((s, c) => {
    const x = livro.saldos.get(c.codigo)?.find((y) => y.competencia === mes);
    return x ? s.plus(assinado(x.saldoFinal, x.naturezaSaldo)) : s;
  }, ZERO);
  const dif = saldo.minus(inventario.valor);
  if (dif.abs().lessThanOrEqualTo(UM)) return [];
  return [
    {
      codigo: "F19",
      competencia: mes,
      confianca: "ALTA",
      descricao: `Estoque de ${moeda(saldo)} no balanço de 31/12/${livro.exercicio} e inventário de ${moeda(inventario.valor)} no Bloco H: diferença de ${moeda(dif.abs())}.`,
      textoCliente:
        `O estoque do balanço de ${livro.exercicio} não é o inventário declarado ao fisco. A diferença de ` +
        `${moeda(dif.abs())} altera o custo das vendas e o lucro tributável.`,
      recomendacao: "Conciliar o inventário com o saldo contábil e ajustar o lado incorreto, refazendo o custo do período.",
      declarado: true,
      evidencias: [
        {
          tipo: "CONFRONTO",
          arquivo: `${livro.arquivo} × ${inventario.documento.nomeArquivo}`,
          registro: "I155 × H005",
          valor: `balanço ${moeda(saldo)} · inventário ${moeda(inventario.valor)}`,
          observacao: contas.map((c) => c.nome).join(", "),
        },
      ],
    },
  ];
}

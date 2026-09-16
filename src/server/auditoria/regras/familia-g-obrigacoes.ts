import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { mesAno, moeda } from "../texto";

/**
 * Família G — obrigações acessórias.
 *
 *   G05 — escrituração mensal não entregue em mês com faturamento
 *   G06 — EFD ICMS/IPI entregue depois do dia 15 (RCTE-GO, art. 356-N)
 *   G07 — EFD-Contribuições entregue depois do 10º dia útil do 2º mês
 *   G08 — Bloco K sem dados em estabelecimento industrial
 *   G09 — inventário zerado ou sem itens
 *   G10 — lacuna na numeração das NF-e emitidas
 *   G04 — NF-e sem IBS/CBS a partir de 03/08/2026
 *
 * Multa de obrigação acessória não depende de haver imposto devido — e é o
 * primeiro indício que a fiscalização usa para escolher quem fiscalizar.
 */

const ZERO = new Prisma.Decimal(0);

export const familiaG: Regra = {
  codigos: ["G04", "G05", "G06", "G07", "G08", "G09", "G10"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    const achados: AchadoProduzido[] = [];
    achados.push(...(await g05EscrituracaoNaoEntregue(ctx)));
    if (ctx.fontesDisponiveis.has("SPED_FISCAL")) {
      achados.push(...(await g06PrazoEfdIcms(ctx)));
      achados.push(...(await g08BlocoK(ctx)));
      achados.push(...(await g09Inventario(ctx)));
    }
    if (ctx.fontesDisponiveis.has("SPED_CONTRIBUICOES")) {
      achados.push(...(await g07PrazoEfdContribuicoes(ctx)));
    }
    achados.push(...(await g10Numeracao(ctx)));
    if (ctx.fontesDisponiveis.has("NFE_XML")) {
      achados.push(...(await g04IbsCbs(ctx)));
    }
    return achados;
  },
};

// ---------------------------------------------------------------------------
// Calendário
// ---------------------------------------------------------------------------

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher). */
function pascoa(ano: number): Date {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(ano, mes - 1, dia));
}

function somarDias(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

/**
 * Dias sem expediente considerados na contagem de dias úteis: feriados
 * nacionais e, por prudência, também Carnaval e Corpus Christi, que são ponto
 * facultativo. Contar esses dias como não úteis alonga o prazo: só se aponta
 * atraso que existe até na leitura mais favorável ao contribuinte.
 */
function naoUteis(ano: number): Set<string> {
  const p = pascoa(ano);
  const datas = [
    new Date(Date.UTC(ano, 0, 1)),
    somarDias(p, -48), // segunda de Carnaval
    somarDias(p, -47), // terça de Carnaval
    somarDias(p, -2), // Sexta-feira Santa
    new Date(Date.UTC(ano, 3, 21)),
    new Date(Date.UTC(ano, 4, 1)),
    somarDias(p, 60), // Corpus Christi
    new Date(Date.UTC(ano, 8, 7)),
    new Date(Date.UTC(ano, 9, 12)),
    new Date(Date.UTC(ano, 10, 2)),
    new Date(Date.UTC(ano, 10, 15)),
    new Date(Date.UTC(ano, 10, 20)),
    new Date(Date.UTC(ano, 11, 25)),
  ];
  return new Set(datas.map((d) => d.toISOString().slice(0, 10)));
}

/** N-ésimo dia útil de um mês (mês 1–12), em UTC à meia-noite. */
export function enesimoDiaUtil(ano: number, mes: number, n: number): Date {
  const feriados = naoUteis(ano);
  let d = new Date(Date.UTC(ano, mes - 1, 1));
  let conta = 0;
  for (;;) {
    const semana = d.getUTCDay();
    if (semana !== 0 && semana !== 6 && !feriados.has(d.toISOString().slice(0, 10))) {
      conta += 1;
      if (conta === n) return d;
    }
    d = somarDias(d, 1);
  }
}

/** "2026-03" + k meses → [ano, mês]. */
function mesAdiante(competencia: string, k: number): [number, number] {
  const [a, m] = competencia.split("-").map(Number);
  const total = a * 12 + (m - 1) + k;
  return [Math.floor(total / 12), (total % 12) + 1];
}

/** Data/hora UTC convertida para o dia civil de Brasília (UTC−3, sem horário de verão). */
function diaBrasilia(d: Date): string {
  return new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10);
}

function dataBr(iso: string): string {
  const [a, m, d] = iso.split("-");
  return `${d}/${m}/${a}`;
}

// ---------------------------------------------------------------------------

/**
 * G05 — escrituração mensal não entregue em mês com faturamento.
 *
 * Só aponta quando a empresa entrega aquela escrituração em outros meses do
 * período (está obrigada a ela) e o mês faltante tem NF-e de saída autorizada
 * (houve atividade). Mês sem arquivo e sem nota é lacuna de coleta, não erro.
 */
async function g05EscrituracaoNaoEntregue(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const [arquivos, saidas] = await Promise.all([
    prisma.escrituracaoArquivo.findMany({
      where: { documento: { auditoriaId: ctx.auditoriaId } },
      select: { competencia: true, documento: { select: { tipo: true } } },
    }),
    prisma.notaFiscal.groupBy({
      by: ["competencia"],
      where: {
        documento: { auditoriaId: ctx.auditoriaId },
        origem: "XML_AUTORIZADO",
        situacao: "AUTORIZADA",
        cnpjEmitente: ctx.empresaCnpj,
      },
      _count: { _all: true },
      _sum: { valorTotal: true },
    }),
  ]);

  const nomes: Record<string, { nome: string; base: string[] }> = {
    SPED_FISCAL: {
      nome: "EFD ICMS/IPI",
      base: ["Ajuste SINIEF nº 02/2009", "RCTE-GO, art. 356-N"],
    },
    SPED_CONTRIBUICOES: {
      nome: "EFD-Contribuições",
      base: ["IN RFB nº 1.252/2012, art. 4º", "Guia Prático da EFD-Contribuições, seção 3"],
    },
  };

  const achados: AchadoProduzido[] = [];
  for (const [tipo, info] of Object.entries(nomes)) {
    const entregues = new Set(arquivos.filter((a) => a.documento.tipo === tipo).map((a) => a.competencia));
    if (entregues.size === 0) continue;
    for (const s of saidas) {
      if (entregues.has(s.competencia)) continue;
      if (s.competencia < ctx.competenciaIni || s.competencia > ctx.competenciaFim) continue;
      const valor = s._sum.valorTotal ?? ZERO;
      achados.push({
        codigo: "G05",
        competencia: s.competencia,
        confianca: "MEDIA",
        descricao:
          `${info.nome} de ${mesAno(s.competencia)} ausente, com ${s._count._all} NF-e de saída ` +
          `somando ${moeda(valor)} no mês.`,
        textoCliente:
          `Não há ${info.nome} de ${mesAno(s.competencia)} entre os arquivos, embora a empresa tenha ` +
          `faturado ${moeda(valor)} no mês e entregue a escrituração dos demais meses.`,
        recomendacao:
          `Confirmar no portal do SPED se a ${info.nome} de ${mesAno(s.competencia)} foi transmitida. ` +
          "Não tendo sido, transmitir de imediato: a multa por atraso é mensal e independe de imposto devido.",
        ressalva:
          "O arquivo pode ter sido transmitido e apenas não veio no pacote. Confirmar pelo recibo antes de levar ao cliente.",
        declarado: false,
        evidencias: [
          {
            tipo: "EXEMPLO",
            arquivo: "Arquivos importados",
            campo: `${info.nome} entregues no período`,
            valor: `${entregues.size} competência(s)`,
            observacao: `ausente: ${mesAno(s.competencia)}`,
          },
          {
            tipo: "EXEMPLO",
            arquivo: "XML das NF-e",
            campo: `NF-e de saída autorizadas em ${mesAno(s.competencia)}`,
            valor: `${s._count._all} nota(s) · ${moeda(valor)}`,
            observacao: info.base.join(" · "),
          },
        ],
      });
    }
  }
  return achados;
}

/**
 * G06 — EFD ICMS/IPI depois do dia 15.
 *
 * O arquivo não é transmitido antes de assinado; assinatura depois do prazo
 * prova transmissão depois do prazo. A data vem do próprio arquivo.
 */
async function g06PrazoEfdIcms(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const arquivos = await prisma.escrituracaoArquivo.findMany({
    where: { documento: { auditoriaId: ctx.auditoriaId, tipo: "SPED_FISCAL" }, dataAssinatura: { not: null } },
    include: { documento: { select: { nomeArquivo: true } } },
    orderBy: { competencia: "asc" },
  });

  const atrasados = arquivos
    .map((a) => {
      const [ano, mes] = mesAdiante(a.competencia, 1);
      const prazo = `${ano}-${String(mes).padStart(2, "0")}-15`;
      const assinado = diaBrasilia(a.dataAssinatura!);
      const dias = Math.round((Date.parse(assinado) - Date.parse(prazo)) / 86_400_000);
      return { a, prazo, assinado, dias };
    })
    .filter((x) => x.dias > 0);

  if (atrasados.length === 0) return [];
  return [
    {
      codigo: "G06",
      competencia: atrasados[atrasados.length - 1].a.competencia,
      confianca: "ALTA",
      descricao:
        `${atrasados.length} de ${arquivos.length} EFD ICMS/IPI assinada(s) depois do dia 15 do mês seguinte.`,
      textoCliente:
        `${atrasados.length} das ${arquivos.length} EFD ICMS/IPI foram assinadas depois do prazo de Goiás ` +
        `(dia 15 do mês seguinte): ${atrasados.map((x) => `${mesAno(x.a.competencia)} em ${dataBr(x.assinado)}`).join("; ")}. ` +
        `Cada entrega em atraso está sujeita a multa.`,
      recomendacao:
        "Ajustar o fechamento fiscal para transmitir até o dia 15. Conferir nos recibos a data exata de " +
        "transmissão e se houve autuação pelo atraso.",
      declarado: true,
      evidencias: atrasados.map((x) => ({
        tipo: "EXEMPLO" as const,
        arquivo: x.a.documento.nomeArquivo,
        campo: `EFD de ${mesAno(x.a.competencia)} — prazo ${dataBr(x.prazo)}`,
        valor: `assinada em ${dataBr(x.assinado)}`,
        observacao: `${x.dias} dia(s) de atraso · data da assinatura digital do arquivo`,
      })),
    },
  ];
}

/**
 * G07 — EFD-Contribuições depois do 10º dia útil do 2º mês subsequente.
 *
 * A data vem do recibo (nome do arquivo .rec, gerado na transmissão) ou, sem
 * ele, da assinatura digital do arquivo.
 */
async function g07PrazoEfdContribuicoes(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const [arquivos, recibos] = await Promise.all([
    prisma.escrituracaoArquivo.findMany({
      where: { documento: { auditoriaId: ctx.auditoriaId, tipo: "SPED_CONTRIBUICOES" } },
      include: { documento: { select: { nomeArquivo: true } } },
      orderBy: { competencia: "asc" },
    }),
    prisma.documento.findMany({
      where: { auditoriaId: ctx.auditoriaId, tipo: "RECIBO_ENTREGA" },
      select: { nomeArquivo: true },
    }),
  ]);

  // PISCOFINS_AAAAMMDD_AAAAMMDD_CNPJ_Original_AAAAMMDDhhmmss_hash.rec
  const transmissao = new Map<string, { data: string; arquivo: string }>();
  for (const r of recibos) {
    const m = /PISCOFINS_(\d{4})(\d{2})\d{2}_\d{8}_\d{14}_\w+?_(\d{4})(\d{2})(\d{2})\d{6}/i.exec(r.nomeArquivo);
    if (m) transmissao.set(`${m[1]}-${m[2]}`, { data: `${m[3]}-${m[4]}-${m[5]}`, arquivo: r.nomeArquivo });
  }

  const atrasados = [];
  for (const a of arquivos) {
    const recibo = transmissao.get(a.competencia);
    const entregue = recibo?.data ?? (a.dataAssinatura ? diaBrasilia(a.dataAssinatura) : undefined);
    if (!entregue) continue;
    const [ano, mes] = mesAdiante(a.competencia, 2);
    const prazo = enesimoDiaUtil(ano, mes, 10).toISOString().slice(0, 10);
    const dias = Math.round((Date.parse(entregue) - Date.parse(prazo)) / 86_400_000);
    if (dias > 0) atrasados.push({ a, prazo, entregue, dias, fonte: recibo ? "recibo de transmissão" : "assinatura digital" });
  }
  if (atrasados.length === 0) return [];

  return [
    {
      codigo: "G07",
      competencia: atrasados[atrasados.length - 1].a.competencia,
      confianca: "ALTA",
      descricao: `${atrasados.length} EFD-Contribuições entregue(s) depois do 10º dia útil do 2º mês subsequente.`,
      textoCliente:
        `${atrasados.length} EFD-Contribuições foram entregues fora do prazo: ` +
        `${atrasados.map((x) => `${mesAno(x.a.competencia)} em ${dataBr(x.entregue)} (prazo ${dataBr(x.prazo)})`).join("; ")}.`,
      recomendacao: "Conferir se houve lançamento da multa por atraso e ajustar o calendário de fechamento.",
      ressalva:
        "O prazo foi contado tratando Carnaval e Corpus Christi como dias não úteis, a leitura mais favorável " +
        "ao contribuinte: o atraso apontado existe em qualquer contagem.",
      declarado: true,
      evidencias: atrasados.map((x) => ({
        tipo: "EXEMPLO" as const,
        arquivo: x.a.documento.nomeArquivo,
        campo: `EFD-Contribuições de ${mesAno(x.a.competencia)} — prazo ${dataBr(x.prazo)}`,
        valor: `entregue em ${dataBr(x.entregue)}`,
        observacao: `${x.dias} dia(s) de atraso · ${x.fonte}`,
      })),
    },
  ];
}

/**
 * G08 — Bloco K sem dados em estabelecimento industrial.
 *
 * O Bloco K é o controle de produção e estoque da indústria. Sua obrigatoriedade
 * é escalonada por faturamento e atividade, por isso a confiança é média: o
 * apontamento pede a confirmação do enquadramento, não afirma a infração.
 */
async function g08BlocoK(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const arquivos = await prisma.escrituracaoArquivo.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId, tipo: "SPED_FISCAL" },
      indAtividade: "0",
      blocoK: "SEM_DADOS",
    },
    include: { documento: { select: { nomeArquivo: true } } },
    orderBy: { competencia: "asc" },
  });
  if (arquivos.length === 0) return [];
  return [
    {
      codigo: "G08",
      competencia: arquivos[arquivos.length - 1].competencia,
      confianca: "MEDIA",
      descricao: `${arquivos.length} EFD de estabelecimento industrial (IND_ATIV 0) com o Bloco K sem dados.`,
      textoCliente:
        `A empresa se declara industrial na EFD, mas o controle de produção e estoque (Bloco K) está vazio em ` +
        `${arquivos.length} competência(s). Sem ele, o fisco não consegue confrontar insumos consumidos com a produção.`,
      recomendacao:
        "Confirmar a obrigatoriedade do Bloco K pelo faturamento e pela atividade e, sendo obrigatória, " +
        "retificar as EFD com a produção e o estoque escriturados.",
      ressalva:
        "A obrigatoriedade do Bloco K é escalonada por faturamento e CNAE (Ajuste SINIEF 02/2009 e alterações). " +
        "Confirmar o enquadramento da empresa antes de tratar como infração.",
      declarado: true,
      evidencias: arquivos.map((a) => ({
        tipo: "EXEMPLO" as const,
        arquivo: a.documento.nomeArquivo,
        registro: "K001",
        campo: `Bloco K de ${mesAno(a.competencia)}`,
        valor: "IND_MOV 1 — sem dados",
        observacao: "registro 0000 com IND_ATIV 0 (industrial ou equiparado)",
      })),
    },
  ];
}

/**
 * G09 — inventário zerado ou sem itens.
 *
 * Empresa com compras e vendas não fecha o exercício com estoque zero. O
 * inventário é a base do custo das mercadorias vendidas: zerado, o custo do
 * exercício seguinte parte de um número falso, e o do exercício encerrado também.
 */
async function g09Inventario(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const inventarios = await prisma.inventario.findMany({
    where: { documento: { auditoriaId: ctx.auditoriaId } },
    include: { documento: { select: { nomeArquivo: true } } },
  });
  const suspeitos = inventarios.filter((i) => (i.valor ?? ZERO).isZero() || i.itens === 0);
  if (suspeitos.length === 0) return [];

  const entradas = await prisma.notaFiscal.count({
    where: { documento: { auditoriaId: ctx.auditoriaId }, direcao: "ENTRADA" },
  });
  if (entradas === 0) return [];

  return suspeitos.map((i) => {
    const data = i.dataInventario?.toLocaleDateString("pt-BR", { timeZone: "UTC" }) ?? "data não informada";
    return {
      codigo: "G09",
      competencia: i.competencia,
      confianca: "ALTA" as const,
      descricao: `Inventário de ${data} com valor de ${moeda(i.valor ?? ZERO)} e ${i.itens} item(ns).`,
      textoCliente:
        `O inventário de ${data} foi declarado zerado, embora a empresa compre e venda mercadorias. O estoque ` +
        `é a base do custo: inventário zerado distorce o resultado e o IRPJ/CSLL do exercício.`,
      recomendacao:
        "Levantar o estoque real na data do inventário, retificar o Bloco H e avaliar o reflexo no custo e no " +
        "lucro do exercício encerrado.",
      declarado: true,
      evidencias: [
        {
          tipo: "EXEMPLO",
          arquivo: i.documento.nomeArquivo,
          registro: "H005",
          campo: `Inventário de ${data}`,
          valor: moeda(i.valor ?? ZERO),
          observacao: `${i.itens} item(ns) no H010 · motivo ${i.motivo ?? "?"} · ${entradas} nota(s) de entrada no período`,
        },
      ],
    };
  });
}

/**
 * G10 — lacuna na numeração das NF-e emitidas.
 *
 * Número pulado dentro de uma série, sem nota autorizada, cancelada ou
 * escriturada com aquele número, precisa de inutilização registrada. Sem ela,
 * o fisco presume nota emitida e não apresentada.
 */
async function g10Numeracao(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const notas = await prisma.notaFiscal.findMany({
    where: { documento: { auditoriaId: ctx.auditoriaId }, cnpjEmitente: ctx.empresaCnpj, modelo: "55" },
    select: { serie: true, numero: true, competencia: true },
  });

  const porSerie = new Map<string, Map<number, string>>();
  for (const n of notas) {
    const num = Number.parseInt(n.numero, 10);
    if (!Number.isFinite(num)) continue;
    const serie = String(Number.parseInt(n.serie ?? "0", 10) || 0);
    const m = porSerie.get(serie) ?? new Map<number, string>();
    if (!m.has(num)) m.set(num, n.competencia);
    porSerie.set(serie, m);
  }

  const achados: AchadoProduzido[] = [];
  for (const [serie, numeros] of porSerie) {
    const ordenados = [...numeros.keys()].sort((a, b) => a - b);
    const primeiro = ordenados[0];
    const ultimo = ordenados[ordenados.length - 1];
    const faltantes: number[] = [];
    for (let i = 1; i < ordenados.length; i++) {
      for (let k = ordenados[i - 1] + 1; k < ordenados[i]; k++) faltantes.push(k);
    }
    // Muitos saltos seguidos indicam período sem coleta, não nota sumida.
    if (faltantes.length > 50) continue;
    // Série que começa em número baixo (até 20) e não no 1: sinal de série nova
    // cujas primeiras notas não aparecem. Pode ser período anterior ao analisado,
    // por isso só a confiança baixa.
    const inicioAusente = primeiro > 1 && primeiro <= 20 ? primeiro - 1 : 0;
    if (faltantes.length === 0 && inicioAusente === 0) continue;

    const partes: string[] = [];
    if (faltantes.length > 0) {
      partes.push(`${faltantes.length} número(s) sem nota entre ${primeiro} e ${ultimo}`);
    }
    if (inicioAusente > 0) {
      partes.push(`numeração começa no nº ${primeiro}, sem as notas 1 a ${primeiro - 1}`);
    }
    const listaTexto = faltantes.length > 0
      ? `faltam os números ${faltantes.slice(0, 20).join(", ")}${faltantes.length > 20 ? "…" : ""}`
      : "";
    const inicioTexto = inicioAusente > 0 ? `a numeração começa no nº ${primeiro}` : "";
    achados.push({
      codigo: "G10",
      competencia: numeros.get(ultimo),
      severidade: "BAIXO",
      confianca: faltantes.length > 0 ? "MEDIA" : "BAIXA",
      descricao: `Série ${serie}: ${partes.join("; ")}.`,
      textoCliente:
        `Na série ${serie} das NF-e ${[listaTexto, inicioTexto].filter(Boolean).join(" e ")}. ` +
        `Número pulado precisa de inutilização registrada na SEFAZ.`,
      recomendacao: "Conferir na SEFAZ se os números foram inutilizados; se não, inutilizar ou apresentar as notas.",
      ressalva: "As notas podem existir e apenas não ter vindo nos arquivos, ou os números podem estar inutilizados.",
      declarado: true,
      evidencias: [
        {
          tipo: "EXEMPLO",
          arquivo: "XML e EFD",
          campo: `Série ${serie} — números sem nota`,
          valor: [
            faltantes.slice(0, 50).join(", "),
            inicioAusente > 0 ? `1 a ${primeiro - 1} (antes da primeira nota do período)` : "",
          ].filter(Boolean).join(" · "),
          observacao: `menor número encontrado: ${primeiro}${primeiro > 1 ? ` (números 1 a ${primeiro - 1} fora do período analisado)` : ""}`,
        },
      ],
    });
  }
  return achados;
}

/**
 * G04 — NF-e sem IBS/CBS a partir de 03/08/2026.
 */
async function g04IbsCbs(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
  const inicio = new Date(Date.UTC(2026, 7, 3));
  const notas = await prisma.notaFiscal.findMany({
    where: {
      documento: { auditoriaId: ctx.auditoriaId },
      origem: "XML_AUTORIZADO",
      situacao: "AUTORIZADA",
      cnpjEmitente: ctx.empresaCnpj,
      dataEmissao: { gte: inicio },
      itens: { some: { temIbsCbs: false } },
    },
    include: { documento: { select: { nomeArquivo: true } } },
    orderBy: { dataEmissao: "asc" },
  });
  const porComp = new Map<string, typeof notas>();
  for (const n of notas) porComp.set(n.competencia, [...(porComp.get(n.competencia) ?? []), n]);

  return [...porComp].map(([competencia, lista]) => ({
    codigo: "G04",
    competencia,
    confianca: "ALTA" as const,
    descricao: `${lista.length} NF-e emitida(s) a partir de 03/08/2026 sem o grupo IBS/CBS em algum item.`,
    textoCliente:
      `Em ${mesAno(competencia)}, ${lista.length} nota(s) saíram sem os campos de IBS e CBS: ` +
      `${lista.map((n) => n.numero).join(", ")}.`,
    recomendacao: "Atualizar o emissor com os grupos de IBS e CBS e corrigir o cadastro tributário dos produtos.",
    valorExposicao: undefined,
    declarado: true,
    evidencias: lista.slice(0, 15).map((n) => ({
      tipo: "EXEMPLO" as const,
      arquivo: n.documento.nomeArquivo,
      documentoNumero: n.numero,
      chave: n.chave ?? undefined,
      dataDocumento: n.dataEmissao.toLocaleDateString("pt-BR", { timeZone: "UTC" }),
      valor: moeda(n.valorTotal),
      observacao: "item sem o grupo IBSCBS",
    })),
  }));
}

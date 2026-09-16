import { Prisma } from "@prisma/client";
import type { Achado, ApontamentoIa, Evidencia, Lacuna } from "@prisma/client";
import { ApontamentoIaCard } from "./ApontamentoIaCard";
import { competencia as fmtComp, moeda } from "@/lib/formato";
import { definicaoDe } from "@/server/auditoria/catalogo";

/**
 * Lista de achados de uma área, com a declaração do que não foi analisado.
 *
 * Usada nas abas Fiscal e Contábil. A lacuna vem junto de propósito: separar
 * "o que achei" de "o que não pude olhar" em telas diferentes faria o leitor
 * tomar a primeira lista como completa.
 */

const ORDEM_SEVERIDADE = ["CRITICO", "ALTO", "MEDIO", "BAIXO", "OPORTUNIDADE"];

const CLASSE_SEV: Record<string, string> = {
  CRITICO: "sev sev-critico",
  ALTO: "sev sev-alto",
  MEDIO: "sev sev-medio",
  BAIXO: "sev sev-baixo",
  OPORTUNIDADE: "sev sev-oportunidade",
};

const ROTULO_PRESCRICAO: Record<string, string> = {
  EXIGIVEL: "Exigível",
  A_DECAIR: "Decai em menos de 12 meses",
  DECAIDO: "Decaído",
};

const ROTULO_CONFIANCA: Record<string, string> = {
  ALTA: "alta",
  MEDIA: "média",
  BAIXA: "baixa",
};

type AchadoComEvidencias = Achado & { evidencias: Evidencia[] };

/**
 * O caso concreto do erro.
 *
 * O total não convence: a nota 3001, emitida em 20/01, de R$ 625,00, que não
 * está no SPED, convence — porque o cliente confere no sistema dele enquanto
 * conversa.
 *
 * Fica recolhido. Aberto, cada achado ocupava meia tela e a lista deixava de
 * ser percorrível: com 18 achados não dava para ver quantos eram nem de que
 * gravidade. O resumo diz o que há dentro, e quem vai conferir aquele achado
 * abre só ele. No relatório impresso é o contrário — lá o exemplo sai sempre,
 * porque no papel não há o que clicar.
 */
function ExemploDoErro({
  evidencias,
  severidade,
  competencia,
  criterio,
}: {
  evidencias: Evidencia[];
  severidade: string;
  /**
   * Preenchida quando o erro se repete: o exemplo é de UMA competência, e
   * omitir qual seria deixar o leitor supor que os números valem para o
   * conjunto inteiro.
   */
  competencia?: string | null;
  /** Como o exemplo foi escolhido entre as ocorrências. */
  criterio?: "maior valor" | "mais recente";
}) {
  const exemplos = evidencias.filter((e) => e.tipo === "EXEMPLO");
  const confrontos = evidencias.filter((e) => e.tipo === "CONFRONTO");
  const contexto = evidencias.filter((e) => e.tipo === "CONTEXTO");

  if (evidencias.length === 0) return null;

  const temDocumento = exemplos.some((e) => e.documentoNumero);

  // Oportunidade não é erro: chamar de "exemplo do erro" a base de uma
  // recomendação de planejamento faria o relatório acusar o cliente de algo
  // que ele não fez.
  const oportunidade = severidade === "OPORTUNIDADE";
  const rotulo = oportunidade
    ? "Base da recomendação"
    : "Exemplo do erro encontrado";

  // O que o resumo promete: quantas linhas, de que natureza. Sem isso o
  // usuário não sabe se vale o clique.
  const partes: string[] = [];
  if (exemplos.length > 0) {
    partes.push(
      temDocumento
        ? `${exemplos.length} documento(s)`
        : `${exemplos.length} linha(s) de cálculo`,
    );
  }
  if (confrontos.length > 0) partes.push(`${confrontos.length} número(s) confrontado(s)`);

  return (
    <details className="mt-2 rounded-md border border-surface-border">
      <summary className="cursor-pointer px-2 py-1 text-[10px] font-medium text-content-muted">
        {oportunidade ? "Ver a base da recomendação" : "Ver o exemplo deste erro"}
        {competencia ? (
          <span className="font-normal"> em {fmtComp(competencia)}</span>
        ) : null}
        {partes.length > 0 ? (
          <span className="font-normal"> — {partes.join(" · ")}</span>
        ) : null}
      </summary>

      <div className="space-y-2 border-t border-surface-border p-2">
      {confrontos.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-surface-border">
          <div className="border-b border-surface-border bg-[#f8fafc] px-2 py-1 text-[9px] font-bold uppercase tracking-[0.4px] text-content-muted">
            Números confrontados
          </div>
          <table className="tbl !text-[10px]">
            <tbody>
              {confrontos.map((e) => (
                <tr key={e.id}>
                  <td>
                    <span className="font-medium">{e.arquivo}</span>
                    {e.registro ? (
                      <span className="text-content-muted"> · {e.registro}</span>
                    ) : null}
                    {e.campo ? (
                      <div className="text-[10px] text-content-muted">{e.campo}</div>
                    ) : null}
                  </td>
                  <td className="num w-40 font-semibold">{e.valor}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {exemplos.length > 0 ? (
        <div className="overflow-hidden rounded-md border border-surface-border">
          <div className="border-b border-surface-border bg-[#f8fafc] px-2 py-1 text-[9px] font-bold uppercase tracking-[0.4px] text-content-muted">
            {rotulo}
          </div>

          <div className="max-h-64 overflow-y-auto">
            {temDocumento ? (
              <table className="tbl !text-[10px]">
                <thead>
                  <tr>
                    <th className="w-24">Documento</th>
                    <th className="w-24">Emissão</th>
                    <th>Chave de acesso</th>
                    <th className="w-28">Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {exemplos.map((e) => (
                    <tr key={e.id}>
                      <td className="font-semibold">{e.documentoNumero ?? "—"}</td>
                      <td>{e.dataDocumento ?? "—"}</td>
                      <td className="break-all font-mono text-[9px]">
                        {e.chave ?? e.campo ?? "—"}
                      </td>
                      <td className="num">{e.valor ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="tbl !text-[10px]">
                <tbody>
                  {exemplos.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <span className="font-medium">{e.campo ?? e.arquivo}</span>
                        {e.observacao ? (
                          <div className="text-content-muted">{e.observacao}</div>
                        ) : null}
                      </td>
                      <td className="num w-40 font-semibold">{e.valor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="border-t border-surface-border px-2 py-1 text-[9px] text-content-muted">
            {competencia
              ? `Exemplo de ${fmtComp(competencia)}, a ocorrência de ${criterio ?? "maior valor"}. `
              : ""}
            {[...new Set(exemplos.map((e) => e.arquivo))].join(" · ")}
            {temDocumento && exemplos[0]?.observacao
              ? ` — ${exemplos[0].observacao}`
              : ""}
          </div>
        </div>
      ) : null}

      {contexto.length > 0 ? (
        <div className="text-[10px] text-content-muted">
          {contexto
            .map((e) =>
              [e.arquivo, e.registro, e.campo, e.valor, e.observacao]
                .filter(Boolean)
                .join(" · "),
            )
            .join("; ")}
        </div>
      ) : null}
      </div>
    </details>
  );
}

/**
 * Um card por tipo de erro, não por ocorrência.
 *
 * O mesmo erro costuma se repetir competência a competência — oito meses de
 * B05, oito de C02. Repetir o card inteiro oito vezes enterra os outros
 * achados e faz a auditoria parecer maior do que é: são dois problemas, não
 * dezesseis. O card passa a dizer o tipo do erro, em quantas competências
 * apareceu e quanto soma; dentro, a distribuição mês a mês e UM exemplo.
 *
 * Decaído fica fora do agrupamento: mistura de exigível com decaído no mesmo
 * total diria que há dinheiro em risco onde já não há.
 */
interface GrupoAchado {
  codigo: string;
  titulo: string;
  severidade: string;
  /** A ocorrência escolhida para ilustrar: a de maior valor. */
  representante: AchadoComEvidencias;
  ocorrencias: AchadoComEvidencias[];
  total: Prisma.Decimal;
  /** A menor confiança do grupo: o card não pode prometer mais que a pior. */
  confianca: string;
  /** Por que esta ocorrência foi escolhida para ilustrar. */
  criterio: "maior valor" | "mais recente";
}

function agrupar(achados: AchadoComEvidencias[]): GrupoAchado[] {
  const mapa = new Map<string, AchadoComEvidencias[]>();
  for (const a of achados) {
    const lista = mapa.get(a.codigo) ?? [];
    lista.push(a);
    mapa.set(a.codigo, lista);
  }

  const grupos: GrupoAchado[] = [];
  for (const [codigo, lista] of mapa) {
    const ordenadas = [...lista].sort((x, y) =>
      (x.competencia ?? "").localeCompare(y.competencia ?? ""),
    );
    const total = lista.reduce(
      (soma, a) => soma.plus(a.valorExposicao ?? 0),
      new Prisma.Decimal(0),
    );
    // Ilustra o de maior valor — é o que o cliente quer entender primeiro.
    // Sem valor nenhum (achado que não gera exposição, como o CST genérico),
    // maior valor não quer dizer nada: vale a ocorrência mais recente, que é
    // a que ainda dá para corrigir dentro do prazo.
    const semValor = total.isZero();
    const representante = semValor
      ? ordenadas[ordenadas.length - 1]
      : [...lista].sort((x, y) =>
          new Prisma.Decimal(y.valorExposicao ?? 0)
            .minus(x.valorExposicao ?? 0)
            .toNumber(),
        )[0];
    const confianca = lista.some((a) => a.confianca === "BAIXA")
      ? "BAIXA"
      : lista.some((a) => a.confianca === "MEDIA")
        ? "MEDIA"
        : "ALTA";

    grupos.push({
      codigo,
      titulo: representante.titulo,
      severidade: representante.severidade,
      representante,
      ocorrencias: ordenadas,
      total,
      confianca,
      criterio: semValor ? "mais recente" : "maior valor",
    });
  }

  return grupos.sort(
    (a, b) =>
      ORDEM_SEVERIDADE.indexOf(a.severidade) -
        ORDEM_SEVERIDADE.indexOf(b.severidade) ||
      b.total.comparedTo(a.total),
  );
}

/** "01/2026, 02/2026 e mais 6" — o período coberto, sem listar tudo no topo. */
function resumoCompetencias(ocorrencias: AchadoComEvidencias[]): string | null {
  const comps = ocorrencias
    .map((o) => o.competencia)
    .filter((c): c is string => Boolean(c))
    .sort();
  if (comps.length === 0) return null;
  if (comps.length === 1) return fmtComp(comps[0]);
  return `${comps.length} competências · ${fmtComp(comps[0])} a ${fmtComp(comps[comps.length - 1])}`;
}

export function ListaAchados({
  achados,
  lacunas,
  vazio,
  apontamentosIa = [],
}: {
  achados: AchadoComEvidencias[];
  lacunas: Lacuna[];
  /** Texto exibido quando a área não produziu achado. */
  vazio: string;
  /** Apontamentos da análise do Claude desta área. */
  apontamentosIa?: ApontamentoIa[];
}) {
  const ordenados = [...achados].sort(
    (a, b) =>
      ORDEM_SEVERIDADE.indexOf(a.severidade) -
        ORDEM_SEVERIDADE.indexOf(b.severidade) ||
      (a.competencia ?? "").localeCompare(b.competencia ?? ""),
  );

  const exigiveis = ordenados.filter((a) => a.situacaoPrescricional !== "DECAIDO");
  const decaidos = ordenados.filter((a) => a.situacaoPrescricional === "DECAIDO");
  const aDecair = ordenados.filter((a) => a.situacaoPrescricional === "A_DECAIR");
  const grupos = agrupar(exigiveis);

  // Uma lista só, por gravidade: o crítico apontado pelo Claude não pode ficar
  // abaixo de um achado baixo das regras só por ter vindo de outra fonte. No
  // empate, a regra vem antes — é o número já testado.
  type Item =
    | { tipo: "regra"; severidade: string; grupo: GrupoAchado }
    | { tipo: "ia"; severidade: string; apontamento: ApontamentoIa };
  const itens: Item[] = [
    ...grupos.map((g) => ({ tipo: "regra" as const, severidade: g.severidade, grupo: g })),
    ...apontamentosIa.map((a) => ({ tipo: "ia" as const, severidade: a.severidade, apontamento: a })),
  ].sort(
    (x, y) =>
      ORDEM_SEVERIDADE.indexOf(x.severidade) - ORDEM_SEVERIDADE.indexOf(y.severidade),
  );

  return (
    <>
      {aDecair.length > 0 ? (
        <div
          className="mb-3 rounded-md px-3 py-2 text-[11px]"
          style={{ background: "#fef3c7", color: "#92400e" }}
        >
          <strong>{aDecair.length} achado(s) decaem em menos de 12 meses.</strong>{" "}
          Passada a janela, a Receita não pode mais constituir o crédito — e a
          chance de regularizar com denúncia espontânea também se fecha.
        </div>
      ) : null}

      {itens.length === 0 ? (
        <div className="card py-10 text-center">
          <div className="text-[13px] font-semibold">Nenhum achado nesta área</div>
          <p className="mx-auto mt-1 max-w-lg text-[11px] text-content-muted">
            {vazio}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {itens.map((item) => {
            if (item.tipo === "ia") {
              return (
                <ApontamentoIaCard
                  key={item.apontamento.id}
                  apontamento={item.apontamento}
                />
              );
            }
            const g = item.grupo;
            const a = g.representante;
            const repetido = g.ocorrencias.length > 1;
            const periodo = resumoCompetencias(g.ocorrencias);
            return (
              <article key={g.codigo} className="achado" data-sev={g.severidade}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] font-bold">{g.codigo}</span>
                  <span className={CLASSE_SEV[g.severidade]}>{g.severidade}</span>
                  <span className="text-[12px] font-semibold">{g.titulo}</span>
                  {periodo ? (
                    <span className="font-mono text-[10px] text-content-muted">
                      {periodo}
                    </span>
                  ) : null}
                  {g.confianca !== "ALTA" ? (
                    <span className="sev sev-baixo">
                      confiança {ROTULO_CONFIANCA[g.confianca] ?? g.confianca}
                    </span>
                  ) : null}
                  {!g.total.isZero() ? (
                    <span className="ml-auto font-mono text-[13px] font-bold">
                      {moeda(g.total)}
                    </span>
                  ) : null}
                </div>

                {/*
                  Com uma ocorrência só, o texto do achado já descreve o caso.
                  Com várias, ele fala de um mês específico e enganaria no card
                  do conjunto — então o conjunto é descrito aqui, e o texto de
                  cada mês vai para a tabela de competências.
                */}
                {/*
                  A descrição do achado traz os números da competência dele.
                  No card do conjunto isso engana: o leitor toma o valor de um
                  mês pelo total. Aqui entra a descrição genérica do catálogo,
                  que vale para todas as ocorrências; os números de cada mês
                  ficam na tabela de competências.
                */}
                <p className="mt-2 text-[11px]">
                  {repetido
                    ? `O mesmo erro se repete em ${g.ocorrencias.length} competências${
                        g.total.isZero() ? "" : `, somando ${moeda(g.total)}`
                      }. ${definicaoDe(g.codigo).descricao}`
                    : (a.textoCliente ?? a.descricao)}
                </p>

                {!repetido && a.textoCliente ? (
                  <p className="mt-1 text-[10px] text-content-muted">
                    {a.descricao}
                  </p>
                ) : null}

                {a.recomendacao ? (
                  <p className="mt-2 text-[10px]">
                    <strong>O que fazer:</strong> {a.recomendacao}
                  </p>
                ) : null}

                {a.ressalva ? (
                  <p
                    className="mt-2 rounded px-2 py-1 text-[10px]"
                    style={{ background: "#f1f5f9" }}
                  >
                    <strong>Ressalva:</strong> {a.ressalva}
                  </p>
                ) : null}

                {repetido ? (
                  <details className="mt-2 rounded-md border border-surface-border">
                    <summary className="cursor-pointer px-2 py-1 text-[10px] font-medium text-content-muted">
                      Ver as {g.ocorrencias.length} competências afetadas
                    </summary>
                    <div className="border-t border-surface-border">
                      <table className="tbl !text-[10px]">
                        <thead>
                          <tr>
                            <th className="w-24">Competência</th>
                            <th>O que foi encontrado</th>
                            {g.total.isZero() ? null : (
                              <th className="w-32">Valor</th>
                            )}
                          </tr>
                        </thead>
                        <tbody>
                          {g.ocorrencias.map((o) => (
                            <tr key={o.id}>
                              <td className="font-mono">
                                {o.competencia ? fmtComp(o.competencia) : "—"}
                              </td>
                              <td>{o.textoCliente ?? o.descricao}</td>
                              {g.total.isZero() ? null : (
                                <td className="num">{moeda(o.valorExposicao)}</td>
                              )}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                ) : null}

                <ExemploDoErro
                  evidencias={a.evidencias}
                  severidade={g.severidade}
                  competencia={repetido ? a.competencia : null}
                  criterio={g.criterio}
                />

                <div className="mt-2 flex flex-wrap gap-3 text-[9px] text-content-muted">
                  <span>{a.baseLegal.join(" · ")}</span>
                  <span className="ml-auto">
                    {ROTULO_PRESCRICAO[a.situacaoPrescricional]}
                    {a.decaiEm
                      ? ` até ${a.decaiEm.toLocaleDateString("pt-BR", { timeZone: "UTC" })}`
                      : ""}
                    {a.regraDecadencia ? ` · ${a.regraDecadencia}` : ""}
                  </span>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {decaidos.length > 0 ? (
        <section className="mt-4">
          <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.5px] text-content-muted">
            Fora da janela de 5 anos — histórico, não risco
          </h2>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-14">Código</th>
                  <th>Achado</th>
                  <th className="w-24">Competência</th>
                  <th className="w-32">Valor</th>
                </tr>
              </thead>
              <tbody>
                {decaidos.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono">{a.codigo}</td>
                    <td>{a.titulo}</td>
                    <td className="font-mono">{fmtComp(a.competencia)}</td>
                    <td className="num">{moeda(a.valorExposicao)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/*
        A lista do que não pôde ser avaliado fica recolhida.

        A página é a dos erros encontrados: uma tabela de dezenas de linhas
        dizendo "não avaliei isto" empurrava os achados reais para fora da tela
        e, pior, parecia uma segunda lista de erros — os itens trazem código e
        título de achado. Mas a informação não pode sumir: sem ela, quem lê
        conclui que o que não está apontado está certo. Por isso vira um resumo
        de uma linha, que abre quando alguém quiser conferir o alcance.
      */}
      <section className="mt-4">
        {lacunas.length === 0 ? (
          <div className="text-[10px] text-content-muted">
            Todas as regras desta área puderam ser avaliadas com os arquivos
            entregues.
          </div>
        ) : (
          <details className="rounded-md border border-surface-border">
            <summary className="cursor-pointer px-3 py-2 text-[10px] text-content-muted">
              <strong>{lacunas.length} verificação(ões) sem os arquivos
              necessários.</strong>{" "}
              Não são erros — é o que ficou fora do alcance desta auditoria. Não
              significa que esteja correto. Abrir para ver a lista e o documento
              que falta em cada uma.
            </summary>

            <div className="border-t border-surface-border">
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Não avaliado</th>
                      <th className="w-40">Documento que falta</th>
                      <th className="w-24">Competência</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lacunas.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <div className="font-medium">{l.escopo}</div>
                          <div className="mt-0.5 text-[10px] text-content-muted">
                            {l.descricao}
                          </div>
                        </td>
                        <td className="font-mono text-[10px]">
                          {l.documentoFaltante ?? "— (não automatizada)"}
                        </td>
                        <td className="font-mono text-[10px]">
                          {l.competencia ? fmtComp(l.competencia) : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </details>
        )}
      </section>
    </>
  );
}

import type { Achado, Evidencia, Lacuna } from "@prisma/client";
import { competencia as fmtComp, moeda } from "@/lib/formato";

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
 * conversa. Fica aberto por padrão, não escondido atrás de "ver evidência":
 * é a parte mais útil do achado.
 */
function ExemploDoErro({ evidencias }: { evidencias: Evidencia[] }) {
  const exemplos = evidencias.filter((e) => e.tipo === "EXEMPLO");
  const confrontos = evidencias.filter((e) => e.tipo === "CONFRONTO");
  const contexto = evidencias.filter((e) => e.tipo === "CONTEXTO");

  if (evidencias.length === 0) return null;

  const temDocumento = exemplos.some((e) => e.documentoNumero);

  return (
    <div className="mt-2 space-y-2">
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
            Exemplo do erro encontrado
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
  );
}

export function ListaAchados({
  achados,
  lacunas,
  vazio,
}: {
  achados: AchadoComEvidencias[];
  lacunas: Lacuna[];
  /** Texto exibido quando a área não produziu achado. */
  vazio: string;
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

      {exigiveis.length === 0 ? (
        <div className="card py-10 text-center">
          <div className="text-[13px] font-semibold">Nenhum achado nesta área</div>
          <p className="mx-auto mt-1 max-w-lg text-[11px] text-content-muted">
            {vazio}
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {exigiveis.map((a) => (
            <article key={a.id} className="achado" data-sev={a.severidade}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] font-bold">{a.codigo}</span>
                <span className={CLASSE_SEV[a.severidade]}>{a.severidade}</span>
                <span className="text-[12px] font-semibold">{a.titulo}</span>
                {a.competencia ? (
                  <span className="font-mono text-[10px] text-content-muted">
                    {fmtComp(a.competencia)}
                  </span>
                ) : null}
                {a.confianca !== "ALTA" ? (
                  <span className="sev sev-baixo">
                    confiança {ROTULO_CONFIANCA[a.confianca] ?? a.confianca}
                  </span>
                ) : null}
                {a.valorExposicao ? (
                  <span className="ml-auto font-mono text-[13px] font-bold">
                    {moeda(a.valorExposicao)}
                  </span>
                ) : null}
              </div>

              <p className="mt-2 text-[11px]">{a.textoCliente ?? a.descricao}</p>

              {a.textoCliente ? (
                <p className="mt-1 text-[10px] text-content-muted">{a.descricao}</p>
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

              <ExemploDoErro evidencias={a.evidencias} />

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
          ))}
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

      <section className="mt-4">
        <h2 className="mb-1 text-[11px] font-bold uppercase tracking-[0.5px] text-content-muted">
          O que não foi analisado, e por quê
        </h2>
        <p className="mb-2 text-[10px] text-content-muted">
          Os itens abaixo não puderam ser avaliados com os documentos entregues.
          Não significa que estejam corretos.
        </p>

        {lacunas.length === 0 ? (
          <div className="card text-[10px] text-content-muted">
            Todas as regras desta área puderam ser avaliadas.
          </div>
        ) : (
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
                    <td className="font-mono text-[10px]">{l.documentoFaltante}</td>
                    <td className="font-mono text-[10px]">
                      {l.competencia ? fmtComp(l.competencia) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

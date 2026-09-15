import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { cnpj as fmtCnpj, competencia as fmtComp, moeda } from "@/lib/formato";

export const dynamic = "force-dynamic";

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

const ROTULO_NIVEL: Record<string, string> = {
  DIAGNOSTICO_RAPIDO: "Diagnóstico rápido",
  FISCAL: "Auditoria fiscal",
  COMPLETA: "Auditoria completa",
};

export default async function AchadosPage({
  params,
}: {
  params: { id: string };
}) {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: params.id },
    include: {
      empresa: true,
      achados: {
        include: { evidencias: true },
        orderBy: [{ competencia: "asc" }, { codigo: "asc" }],
      },
      lacunas: { orderBy: { escopo: "asc" } },
    },
  });

  if (!auditoria) notFound();

  const achados = [...auditoria.achados].sort(
    (a, b) =>
      ORDEM_SEVERIDADE.indexOf(a.severidade) -
        ORDEM_SEVERIDADE.indexOf(b.severidade) ||
      (a.competencia ?? "").localeCompare(b.competencia ?? ""),
  );

  const exigiveis = achados.filter((a) => a.situacaoPrescricional !== "DECAIDO");
  const decaidos = achados.filter((a) => a.situacaoPrescricional === "DECAIDO");
  const aDecair = achados.filter((a) => a.situacaoPrescricional === "A_DECAIR");

  return (
    <>
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-[15px] font-bold">
            Achados · {auditoria.empresa.razaoSocial}
          </h1>
          <p className="mt-0.5 text-[11px] text-content-muted">
            <span className="font-mono">{fmtCnpj(auditoria.empresa.cnpj)}</span> ·{" "}
            {fmtComp(auditoria.competenciaIni)} a {fmtComp(auditoria.competenciaFim)}
            {auditoria.nivelAlcancado
              ? ` · ${ROTULO_NIVEL[auditoria.nivelAlcancado]}`
              : ""}
          </p>
        </div>
        <Link href={`/auditorias/${auditoria.id}`} className="btn-ghost">
          Voltar à auditoria
        </Link>
      </div>

      {/* Página 1 do relatório: os três números que ganham a reunião. */}
      <div className="mb-4 grid gap-3 md:grid-cols-3">
        <div className="kpi" style={{ borderLeftColor: "var(--danger)" }}>
          <div className="kpi-label">Débito em aberto</div>
          <div className="kpi-val">{moeda(auditoria.totalDebitoAberto)}</div>
          <div className="kpi-sub">já declarado e não pago</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--warning)" }}>
          <div className="kpi-label">Risco de autuação</div>
          <div className="kpi-val">{moeda(auditoria.totalRiscoAutuacao)}</div>
          <div className="kpi-sub">exposição a lançamento de ofício</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--success)" }}>
          <div className="kpi-label">A recuperar</div>
          <div className="kpi-val">{moeda(auditoria.totalRecuperavel)}</div>
          <div className="kpi-sub">pago a maior ou crédito não aproveitado</div>
        </div>
      </div>

      {aDecair.length > 0 ? (
        <div
          className="mb-3 rounded-md px-3 py-2 text-[11px]"
          style={{ background: "#fef3c7", color: "#92400e" }}
        >
          <strong>{aDecair.length} achado(s) decaem em menos de 12 meses.</strong>{" "}
          Passada a janela, a Receita não pode mais constituir o crédito — e a
          oportunidade de regularizar com denúncia espontânea também se fecha.
        </div>
      ) : null}

      {achados.length === 0 ? (
        <div className="card py-10 text-center">
          <div className="text-[13px] font-semibold">Nenhum achado</div>
          <p className="mx-auto mt-1 max-w-lg text-[11px] text-content-muted">
            Com os documentos importados até aqui, as regras aplicáveis não
            encontraram inconsistência. Isso não significa que a empresa esteja
            regular: veja abaixo o que não pôde ser avaliado por falta de
            documento.
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

              {a.evidencias.length > 0 ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] font-semibold text-azuos-primary">
                    Evidência ({a.evidencias.length})
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-[10px] text-content-muted">
                    {a.evidencias.map((e) => (
                      <li key={e.id}>
                        · <span className="font-mono">{e.arquivo}</span>
                        {e.registro ? ` · registro ${e.registro}` : ""}
                        {e.campo ? ` · ${e.campo}` : ""}
                        {e.valor ? `: ${e.valor}` : ""}
                        {e.observacao ? ` — ${e.observacao}` : ""}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}

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

      {/* O que NÃO foi analisado. Auditoria que esconde a própria lacuna não
          serve como peça técnica. */}
      <section className="mt-4">
        <h2 className="mb-1 text-[11px] font-bold uppercase tracking-[0.5px] text-content-muted">
          O que não foi analisado, e por quê
        </h2>
        <p className="mb-2 text-[10px] text-content-muted">
          Esta auditoria foi feita com os documentos entregues. Os itens abaixo
          não puderam ser avaliados — não significa que estejam corretos.
        </p>

        {auditoria.lacunas.length === 0 ? (
          <div className="card text-[10px] text-content-muted">
            Todas as regras do catálogo puderam ser avaliadas com os documentos
            importados.
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
                {auditoria.lacunas.map((l) => (
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

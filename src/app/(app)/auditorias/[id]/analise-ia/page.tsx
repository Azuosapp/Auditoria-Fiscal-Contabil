import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AbasAuditoria } from "@/components/AbasAuditoria";
import { CabecalhoAuditoria } from "@/components/CabecalhoAuditoria";
import {
  AcompanharAnaliseIa,
  BotaoAnaliseIa,
} from "@/components/AnaliseIaControles";
import { competencia as fmtComp, moeda } from "@/lib/formato";

export const dynamic = "force-dynamic";
export const metadata = { title: "Análise do Claude · Auditoria Azuos" };

const ORDEM_SEVERIDADE = ["CRITICO", "ALTO", "MEDIO", "BAIXO", "OPORTUNIDADE"];

const CLASSE_SEV: Record<string, string> = {
  CRITICO: "sev sev-critico",
  ALTO: "sev sev-alto",
  MEDIO: "sev sev-medio",
  BAIXO: "sev sev-baixo",
  OPORTUNIDADE: "sev sev-oportunidade",
};

const ROTULO_CONFIANCA: Record<string, string> = {
  ALTA: "confiança alta",
  MEDIA: "confiança média",
  BAIXA: "confiança baixa",
};

interface Evidencia {
  arquivo: string;
  localizacao: string;
  detalhe: string;
  valor: string;
}

function periodo(comps: string[]): string | null {
  if (comps.length === 0) return null;
  if (comps.length === 1) return fmtComp(comps[0]);
  return `${comps.length} competências · ${fmtComp(comps[0])} a ${fmtComp(comps[comps.length - 1])}`;
}

function duracao(seg: number | null): string {
  if (seg === null) return "—";
  const m = Math.floor(seg / 60);
  return m > 0 ? `${m} min ${seg % 60} s` : `${seg} s`;
}

export default async function AnaliseIaPage({
  params,
}: {
  params: { id: string };
}) {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: params.id },
    include: { empresa: true },
  });
  if (!auditoria) notFound();

  const [ultima, rodadas] = await Promise.all([
    prisma.analiseIa.findFirst({
      where: { auditoriaId: params.id },
      orderBy: { iniciadaEm: "desc" },
      include: { apontamentos: true },
    }),
    prisma.analiseIa.count({ where: { auditoriaId: params.id } }),
  ]);

  // Enquanto a nova roda, a anterior concluída continua visível: a tela não
  // fica vazia durante os minutos da análise.
  const ultimaConcluida =
    ultima && ultima.status !== "CONCLUIDA"
      ? await prisma.analiseIa.findFirst({
          where: { auditoriaId: params.id, status: "CONCLUIDA" },
          orderBy: { iniciadaEm: "desc" },
          include: { apontamentos: true },
        })
      : ultima;

  const emAndamento = ultima?.status === "EM_ANDAMENTO";
  const exibida = ultimaConcluida;

  const apontamentos = [...(exibida?.apontamentos ?? [])].sort(
    (a, b) =>
      ORDEM_SEVERIDADE.indexOf(a.severidade) - ORDEM_SEVERIDADE.indexOf(b.severidade) ||
      a.ordem - b.ordem,
  );

  const somar = (filtro: (a: (typeof apontamentos)[number]) => boolean) =>
    apontamentos
      .filter(filtro)
      .reduce((s, a) => s.plus(a.valorEstimado ?? 0), new Prisma.Decimal(0));

  const exposicao = somar((a) => a.severidade !== "OPORTUNIDADE");
  const recuperar = somar((a) => a.severidade === "OPORTUNIDADE");
  const criticos = apontamentos.filter((a) => a.severidade === "CRITICO").length;

  return (
    <>
      <CabecalhoAuditoria auditoria={auditoria} empresa={auditoria.empresa} />
      <AbasAuditoria auditoriaId={params.id} />
      <AcompanharAnaliseIa emAndamento={emAndamento} />

      <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="text-[13px] font-bold">Análise tributária do Claude</h2>
          <p className="mt-0.5 max-w-3xl text-[10px] text-content-muted">
            Leitura completa dos arquivos importados, feita pelo Claude com os agentes
            tributários do escritório, a cada nova importação. É análise de auditor, a
            confirmar: <strong>não entra nos totais da auditoria</strong>, que vêm só
            das regras programadas. Confira as evidências antes de levar ao cliente.
          </p>
        </div>
        <BotaoAnaliseIa
          auditoriaId={params.id}
          desabilitado={emAndamento}
          rotulo={rodadas === 0 ? "Rodar análise do Claude" : "Rodar novamente"}
        />
      </div>

      {emAndamento ? (
        <div
          className="mb-3 rounded-md px-3 py-2 text-[11px]"
          style={{ background: "#eff6ff", color: "#1e3a8a" }}
        >
          <strong>Análise em andamento</strong> desde{" "}
          {ultima!.iniciadaEm.toLocaleTimeString("pt-BR")}. Costuma levar de 5 a 20
          minutos, conforme o volume de arquivos. Esta página se atualiza sozinha
          {exibida ? " — até lá, abaixo está a análise anterior." : "."}
        </div>
      ) : null}

      {ultima && (ultima.status === "ERRO" || ultima.status === "LIMITE_ATINGIDO") ? (
        <div
          className="mb-3 rounded-md px-3 py-2 text-[11px]"
          style={{ background: "#fee2e2", color: "#b91c1c" }}
        >
          <strong>
            {ultima.status === "LIMITE_ATINGIDO"
              ? "A última análise parou no teto de consumo."
              : "A última análise não terminou."}
          </strong>{" "}
          {ultima.erro}
          {exibida ? " Abaixo está a última análise concluída." : ""}
        </div>
      ) : null}

      {!ultima ? (
        <div className="card py-10 text-center">
          <div className="text-[13px] font-semibold">Nenhuma análise ainda</div>
          <p className="mx-auto mt-1 max-w-lg text-[11px] text-content-muted">
            A análise roda sozinha depois de cada importação processada. Para esta
            auditoria, que já tinha arquivos antes da integração, use o botão acima.
          </p>
        </div>
      ) : null}

      {exibida ? (
        <>
          <div className="kpis mb-3">
            <div className="kpi" style={{ borderLeftColor: "var(--danger)" }}>
              <div className="kpi-label">Exposição estimada</div>
              <div className="kpi-val">{moeda(exposicao)}</div>
              <div className="kpi-sub">a confirmar</div>
            </div>
            <div className="kpi" style={{ borderLeftColor: "var(--success)" }}>
              <div className="kpi-label">A recuperar</div>
              <div className="kpi-val">{moeda(recuperar)}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Apontamentos</div>
              <div className="kpi-val">{apontamentos.length}</div>
              <div className="kpi-sub">{criticos} crítico(s)</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Analisado em</div>
              <div className="kpi-val !text-[13px]">
                {exibida.concluidaEm?.toLocaleDateString("pt-BR")}{" "}
                {exibida.concluidaEm?.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              </div>
              <div className="kpi-sub">
                {duracao(exibida.duracaoSeg)}
                {exibida.custoUsd ? ` · consumo ≈ US$ ${Number(exibida.custoUsd).toFixed(2)}` : ""}
              </div>
            </div>
          </div>

          {exibida.resumo ? (
            <div className="card mb-3 text-[11px] leading-relaxed">{exibida.resumo}</div>
          ) : null}

          {apontamentos.length === 0 ? (
            <div className="card py-8 text-center text-[11px] text-content-muted">
              A análise não encontrou erro além dos já apontados pelas regras.
            </div>
          ) : (
            <div className="space-y-3">
              {apontamentos.map((a) => {
                const evidencias = (a.evidencias ?? []) as unknown as Evidencia[];
                return (
                  <article key={a.id} className="achado" data-sev={a.severidade}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={CLASSE_SEV[a.severidade]}>{a.severidade}</span>
                      <span className="text-[12px] font-semibold">{a.titulo}</span>
                      <span className="sev sev-baixo">{a.area === "FISCAL" ? "fiscal" : "contábil"}</span>
                      {a.tributo ? (
                        <span className="text-[10px] text-content-muted">{a.tributo}</span>
                      ) : null}
                      {periodo(a.competencias) ? (
                        <span className="font-mono text-[10px] text-content-muted">
                          {periodo(a.competencias)}
                        </span>
                      ) : null}
                      <span className="sev sev-baixo">{ROTULO_CONFIANCA[a.confianca]}</span>
                      {a.valorEstimado ? (
                        <span className="ml-auto font-mono text-[13px] font-bold">
                          {moeda(a.valorEstimado)}
                        </span>
                      ) : null}
                    </div>

                    <p className="mt-2 whitespace-pre-line text-[11px]">{a.descricao}</p>

                    {a.recomendacao ? (
                      <p className="mt-2 text-[10px]">
                        <strong>O que fazer:</strong> {a.recomendacao}
                      </p>
                    ) : null}

                    {evidencias.length > 0 ? (
                      <details className="mt-2 rounded-md border border-surface-border">
                        <summary className="cursor-pointer px-2 py-1 text-[10px] font-medium text-content-muted">
                          Ver as evidências — {evidencias.length} ponto(s) para conferir
                        </summary>
                        <div className="border-t border-surface-border">
                          <table className="tbl !text-[10px]">
                            <thead>
                              <tr>
                                <th className="w-48">Arquivo</th>
                                <th className="w-56">Onde</th>
                                <th>O que mostra</th>
                                <th className="w-32">Valor</th>
                              </tr>
                            </thead>
                            <tbody>
                              {evidencias.map((e, i) => (
                                <tr key={i}>
                                  <td className="break-all">{e.arquivo}</td>
                                  <td className="break-all font-mono text-[9px]">{e.localizacao}</td>
                                  <td>{e.detalhe}</td>
                                  <td className="num">{e.valor}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </details>
                    ) : null}

                    {a.baseLegal.length > 0 ? (
                      <div className="mt-2 text-[9px] text-content-muted">
                        {a.baseLegal.join(" · ")}
                      </div>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}

          {exibida.documentosFaltantes.length > 0 ? (
            <section className="mt-4">
              <h3 className="mb-1 text-[11px] font-bold uppercase tracking-[0.5px] text-content-muted">
                Para confirmar ou ampliar a análise
              </h3>
              <ul className="card list-disc space-y-1 pl-6 text-[10px]">
                {exibida.documentosFaltantes.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </>
  );
}

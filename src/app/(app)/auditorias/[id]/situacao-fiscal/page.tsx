import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AbasAuditoria } from "@/components/AbasAuditoria";
import { contagensDasAbas } from "@/server/claude/consulta";
import { CabecalhoAuditoria } from "@/components/CabecalhoAuditoria";
import { cnpj as fmtCnpj, moeda } from "@/lib/formato";

export const dynamic = "force-dynamic";
export const metadata = { title: "Situação fiscal · Auditoria Azuos" };

const ROTULO_NATUREZA: Record<string, string> = {
  DEBITO: "Débito",
  OMISSAO_DECLARACAO: "Declaração omissa",
  PARCELAMENTO: "Parcelamento",
  DIVIDA_ATIVA: "Inscrição em dívida ativa",
  IRREGULARIDADE_CADASTRAL: "Irregularidade cadastral",
  OUTRA: "Outra",
};

const COR_NATUREZA: Record<string, string> = {
  DEBITO: "sev sev-critico",
  DIVIDA_ATIVA: "sev sev-critico",
  OMISSAO_DECLARACAO: "sev sev-alto",
  IRREGULARIDADE_CADASTRAL: "sev sev-alto",
  PARCELAMENTO: "sev sev-medio",
  OUTRA: "sev sev-baixo",
};

interface Socio {
  documento: string;
  nome: string;
  qualificacao?: string;
  situacaoCadastral?: string;
  participacao?: string;
}

export default async function SituacaoFiscalPage({
  params,
}: {
  params: { id: string };
}) {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: params.id },
    include: { empresa: true },
  });
  if (!auditoria) notFound();

  const [retrato, pendencias, contagens] = await Promise.all([
    // O relatório é uma fotografia de uma data: vale o mais recente importado.
    prisma.retratoSituacaoFiscal.findFirst({
      where: { documento: { auditoriaId: params.id } },
      orderBy: { criadoEm: "desc" },
      include: { documento: { select: { nomeArquivo: true } } },
    }),
    prisma.pendenciaFiscal.findMany({
      where: { documento: { auditoriaId: params.id } },
      orderBy: [{ natureza: "asc" }, { receita: "asc" }],
    }),
    contagensDasAbas(params.id),
  ]);

  const porArea = contagens;

  const totalConsolidado = pendencias.reduce(
    (s, p) => s.plus(p.saldoConsolidado ?? p.saldoDevedor ?? 0),
    new Prisma.Decimal(0),
  );

  const porNatureza = new Map<string, number>();
  for (const p of pendencias) {
    porNatureza.set(p.natureza, (porNatureza.get(p.natureza) ?? 0) + 1);
  }

  const socios = (retrato?.socios as unknown as Socio[] | null) ?? [];

  return (
    <>
      <CabecalhoAuditoria auditoria={auditoria} empresa={auditoria.empresa} />
      <AbasAuditoria auditoriaId={params.id} contagens={porArea} />

      <div className="mb-3">
        <h2 className="text-[13px] font-bold">Situação fiscal na Receita e na PGFN</h2>
        <p className="mt-0.5 text-[10px] text-content-muted">
          Extraído do Relatório de Situação Fiscal do e-CAC. <strong>Não é
          conclusão da auditoria</strong>: é o que os próprios órgãos registram
          sobre a empresa — e é por isso que vale na conversa com o cliente.
        </p>
      </div>

      {!retrato ? (
        <div className="card py-10 text-center">
          <div className="text-[13px] font-semibold">
            Relatório de Situação Fiscal não importado
          </div>
          <p className="mx-auto mt-1 max-w-xl text-[11px] text-content-muted">
            Emita no e-CAC em <strong>Certidões e Situação Fiscal → Consulta
            Pendências &ndash; Situação Fiscal</strong> e importe o PDF. É o
            documento que mostra débito em cobrança, declaração omissa, inscrição
            em dívida ativa e parcelamento — muitas vezes desconhecidos pelo
            próprio cliente.
          </p>
        </div>
      ) : (
        <>
          {retrato.semPendencias ? (
            <div
              className="mb-3 rounded-md px-3 py-2 text-[11px]"
              style={{ background: "#dcfce7", color: "#166534" }}
            >
              <strong>Sem pendências.</strong> O relatório afirma que não foram
              detectadas pendências nem exigibilidades suspensas nos controles da
              Receita Federal e da PGFN
              {retrato.emitidoEm ? ` em ${retrato.emitidoEm}` : ""}.
            </div>
          ) : null}

          <div className="kpis mb-3">
            <div
              className="kpi"
              style={{
                borderLeftColor:
                  pendencias.length > 0 ? "var(--danger)" : "var(--success)",
              }}
            >
              <div className="kpi-label">Pendências</div>
              <div className="kpi-val">{pendencias.length}</div>
            </div>
            <div className="kpi" style={{ borderLeftColor: "var(--danger)" }}>
              <div className="kpi-label">Saldo consolidado</div>
              <div className="kpi-val">{moeda(totalConsolidado)}</div>
              <div className="kpi-sub">principal + multa + juros</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Situação cadastral</div>
              <div className="kpi-val text-[15px]">
                {retrato.situacaoCadastral ?? "—"}
              </div>
              {retrato.motivoSituacao ? (
                <div className="kpi-sub">{retrato.motivoSituacao}</div>
              ) : null}
            </div>
            <div className="kpi">
              <div className="kpi-label">Certidão</div>
              <div className="kpi-val text-[15px]">
                {retrato.certidaoNumero ? "Negativa" : "—"}
              </div>
              {retrato.certidaoValidade ? (
                <div className="kpi-sub">até {retrato.certidaoValidade}</div>
              ) : null}
            </div>
            <div className="kpi">
              <div className="kpi-label">Porte</div>
              <div className="kpi-val text-[13px]">{retrato.porte ?? "—"}</div>
            </div>
            <div className="kpi">
              <div className="kpi-label">Emitido em</div>
              <div className="kpi-val text-[13px]">{retrato.emitidoEm ?? "—"}</div>
            </div>
          </div>

          {pendencias.length > 0 ? (
            <section className="mb-3">
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.5px] text-content-muted">
                Pendências registradas
                {[...porNatureza.entries()].map(([n, q]) => (
                  <span key={n} className="ml-2 font-normal normal-case">
                    <span className={COR_NATUREZA[n] ?? "sev sev-baixo"}>
                      {ROTULO_NATUREZA[n] ?? n} {q}
                    </span>
                  </span>
                ))}
              </h3>

              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th className="w-16">Órgão</th>
                      <th className="w-40">Natureza</th>
                      <th>Receita / descrição</th>
                      <th className="w-24">Período</th>
                      <th className="w-24">Vencimento</th>
                      <th className="w-28">Principal</th>
                      <th className="w-24">Multa</th>
                      <th className="w-24">Juros</th>
                      <th className="w-32">Consolidado</th>
                      <th className="w-28">Situação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendencias.map((p) => (
                      <tr key={p.id}>
                        <td className="font-mono text-[10px]">{p.orgao}</td>
                        <td>
                          <span className={COR_NATUREZA[p.natureza] ?? "sev sev-baixo"}>
                            {ROTULO_NATUREZA[p.natureza] ?? p.natureza}
                          </span>
                        </td>
                        <td>
                          <div className="font-medium">{p.receita ?? p.descricao}</div>
                          {p.identificacao ? (
                            <div className="font-mono text-[10px] text-content-muted">
                              {p.identificacao}
                            </div>
                          ) : null}
                        </td>
                        <td className="font-mono text-[10px]">{p.periodo ?? "—"}</td>
                        <td className="font-mono text-[10px]">{p.vencimento ?? "—"}</td>
                        <td className="num">{moeda(p.valorOriginal)}</td>
                        <td className="num">{moeda(p.multa)}</td>
                        <td className="num">{moeda(p.juros)}</td>
                        <td className="num font-semibold">
                          {moeda(p.saldoConsolidado)}
                        </td>
                        <td className="text-[10px]">{p.situacao ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <p className="mt-1.5 text-[10px] text-content-muted">
                Débito confessado e inscrição em dívida ativa são título executivo:
                a cobrança segue sem necessidade de autuação, e bloqueiam a
                certidão negativa, crédito bancário e participação em licitação.
              </p>
            </section>
          ) : null}

          <div className="grid gap-3 md:grid-cols-2">
            <div className="card">
              <div className="mb-2 text-[11px] font-bold">Dados cadastrais</div>
              <table className="tbl">
                <tbody>
                  <Linha rotulo="CNPJ" valor={retrato.cnpj ? fmtCnpj(retrato.cnpj) : undefined} />
                  <Linha rotulo="Razão social" valor={retrato.razaoSocial} />
                  <Linha rotulo="Natureza jurídica" valor={retrato.naturezaJuridica} />
                  <Linha rotulo="CNAE" valor={retrato.cnae} />
                  <Linha rotulo="Abertura" valor={retrato.dataAbertura} />
                  <Linha
                    rotulo="Município / UF"
                    valor={
                      retrato.municipio
                        ? `${retrato.municipio}${retrato.uf ? ` / ${retrato.uf}` : ""}`
                        : retrato.uf ?? undefined
                    }
                  />
                  <Linha rotulo="Unidade de domicílio" valor={retrato.unidadeAdministrativa} />
                  <Linha rotulo="Responsável" valor={retrato.responsavel} />
                </tbody>
              </table>
            </div>

            <div className="card">
              <div className="mb-2 text-[11px] font-bold">
                Sócios e administradores
              </div>
              {socios.length === 0 ? (
                <p className="text-[10px] text-content-muted">
                  O relatório não lista sócios.
                </p>
              ) : (
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>Nome</th>
                      <th className="w-36">Qualificação</th>
                      <th className="w-24">Situação</th>
                      <th className="w-20">Part.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {socios.map((s) => (
                      <tr key={s.documento + s.nome}>
                        <td>
                          <div className="font-medium">{s.nome}</div>
                          <div className="font-mono text-[10px] text-content-muted">
                            {s.documento}
                          </div>
                        </td>
                        <td className="text-[10px]">{s.qualificacao ?? "—"}</td>
                        <td className="text-[10px]">{s.situacaoCadastral ?? "—"}</td>
                        <td className="num text-[10px]">{s.participacao ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <p className="mt-3 text-[10px] text-content-muted">
            Fonte: <span className="font-mono">{retrato.documento.nomeArquivo}</span>
            {retrato.emitidoEm ? ` · emitido em ${retrato.emitidoEm}` : ""}. O
            relatório é uma fotografia da data de emissão; pendência posterior não
            aparece aqui.
          </p>
        </>
      )}
    </>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor?: string | null }) {
  return (
    <tr>
      <td className="w-40 text-content-muted">{rotulo}</td>
      <td className="font-medium">{valor ?? "—"}</td>
    </tr>
  );
}

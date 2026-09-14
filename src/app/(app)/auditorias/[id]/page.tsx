import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { cnpj as fmtCnpj, competencia as fmtComp, moeda } from "@/lib/formato";

export const dynamic = "force-dynamic";

const ROTULO_TIPO: Record<string, string> = {
  NFE_XML: "XML de NF-e",
  NFCE_XML: "XML de NFC-e",
  NFSE_XML: "XML de NFS-e",
  EVENTO_NFE: "Evento de NF-e",
  SPED_FISCAL: "SPED Fiscal",
  SPED_CONTRIBUICOES: "EFD-Contribuições",
  ECD: "ECD",
  ECF: "ECF",
  DCTF: "DCTF",
  DCTFWEB: "DCTFWeb",
  SITUACAO_FISCAL: "Situação Fiscal",
  PGDAS: "PGDAS-D",
  COMPROVANTE_ARRECADACAO: "Arrecadação",
  ESOCIAL: "eSocial",
  EFD_REINF: "EFD-Reinf",
  CARTAO_CNPJ: "Cartão CNPJ",
  CONTRATO_SOCIAL: "Contrato social",
  PLANILHA: "Planilha",
  DESCONHECIDO: "Não reconhecido",
};

const ROTULO_REGIME: Record<string, string> = {
  SIMPLES_NACIONAL: "Simples Nacional",
  LUCRO_PRESUMIDO: "Lucro Presumido",
  LUCRO_REAL: "Lucro Real",
  MEI: "MEI",
  IMUNE_ISENTA: "Imune / Isenta",
  ARBITRADO: "Arbitrado",
};

export default async function AuditoriaPage({
  params,
}: {
  params: { id: string };
}) {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: params.id },
    include: {
      empresa: { include: { regimes: { orderBy: { exercicio: "asc" } } } },
      achados: { orderBy: { severidade: "asc" }, take: 50 },
      _count: { select: { documentos: true, achados: true } },
    },
  });

  if (!auditoria) notFound();

  const porTipo = await prisma.documento.groupBy({
    by: ["tipo"],
    where: { auditoriaId: auditoria.id },
    _count: { _all: true },
    orderBy: { _count: { tipo: "desc" } },
  });

  return (
    <>
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-[15px] font-bold">{auditoria.empresa.razaoSocial}</h1>
          <p className="mt-0.5 text-[11px] text-content-muted">
            <span className="font-mono">{fmtCnpj(auditoria.empresa.cnpj)}</span>
            {auditoria.empresa.uf ? ` · ${auditoria.empresa.uf}` : ""} ·{" "}
            {fmtComp(auditoria.competenciaIni)} a {fmtComp(auditoria.competenciaFim)}
          </p>
        </div>
        <Link href="/importar" className="btn-ghost">
          Importar mais arquivos
        </Link>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Documentos</div>
          <div className="kpi-val">{auditoria._count.documentos}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Achados</div>
          <div className="kpi-val">{auditoria._count.achados}</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--danger)" }}>
          <div className="kpi-label">Débito em aberto</div>
          <div className="kpi-val text-[15px]">
            {moeda(auditoria.totalDebitoAberto)}
          </div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--warning)" }}>
          <div className="kpi-label">Risco de autuação</div>
          <div className="kpi-val text-[15px]">
            {moeda(auditoria.totalRiscoAutuacao)}
          </div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--success)" }}>
          <div className="kpi-label">A recuperar</div>
          <div className="kpi-val text-[15px]">
            {moeda(auditoria.totalRecuperavel)}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Situação</div>
          <div className="kpi-val text-[15px]">{auditoria.status}</div>
        </div>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="card">
          <div className="mb-2 text-[11px] font-bold">Documentos importados</div>
          {porTipo.length === 0 ? (
            <p className="text-[10px] text-content-muted">
              Nenhum documento nesta auditoria.
            </p>
          ) : (
            <table className="tbl">
              <tbody>
                {porTipo.map((t) => (
                  <tr key={t.tipo}>
                    <td>{ROTULO_TIPO[t.tipo] ?? t.tipo}</td>
                    <td className="num w-20 font-semibold">{t._count._all}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <div className="mb-2 text-[11px] font-bold">Regime por exercício</div>
          {auditoria.empresa.regimes.length === 0 ? (
            <p className="text-[10px] text-content-muted">
              Regime não informado. É ele que define qual motor de regras se
              aplica a cada ano.
            </p>
          ) : (
            <table className="tbl">
              <tbody>
                {auditoria.empresa.regimes.map((r) => (
                  <tr key={r.id}>
                    <td className="w-16 font-mono font-semibold">{r.exercicio}</td>
                    <td>{ROTULO_REGIME[r.regime] ?? r.regime}</td>
                    <td className="text-[10px] text-content-muted">{r.origem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card mt-3">
        <div className="text-[11px] font-bold">Próxima etapa</div>
        <p className="mt-1 text-[10px] text-content-muted">
          Os documentos estão registrados e aguardando processamento. O motor de
          regras — que extrai as apurações, monta a visão apurado × confessado ×
          pago e gera os achados — ainda está em construção. Ver
          docs/CONTINUAR_AQUI.md.
        </p>
      </div>
    </>
  );
}

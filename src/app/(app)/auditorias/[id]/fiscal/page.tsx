import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AbasAuditoria } from "@/components/AbasAuditoria";
import { CabecalhoAuditoria } from "@/components/CabecalhoAuditoria";
import { ListaAchados } from "@/components/ListaAchados";
import { moeda } from "@/lib/formato";

export const dynamic = "force-dynamic";
export const metadata = { title: "Análise fiscal · Auditoria Azuos" };

export default async function FiscalPage({
  params,
}: {
  params: { id: string };
}) {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: params.id },
    include: { empresa: true },
  });
  if (!auditoria) notFound();

  const [achados, lacunas, contagens] = await Promise.all([
    prisma.achado.findMany({
      where: { auditoriaId: params.id, area: "FISCAL" },
      include: { evidencias: true },
    }),
    prisma.lacuna.findMany({
      where: { auditoriaId: params.id, area: "FISCAL" },
      orderBy: { escopo: "asc" },
    }),
    prisma.achado.groupBy({
      by: ["area"],
      where: { auditoriaId: params.id },
      _count: { _all: true },
    }),
  ]);

  const porArea = Object.fromEntries(
    contagens.map((c) => [
      c.area === "FISCAL" ? "/fiscal" : "/contabil",
      c._count._all,
    ]),
  );

  // Achado decaído fica fora dos totais: não é exigível nem recuperável. E
  // achado de confiança não-ALTA entra num número próprio — somá-lo ao risco
  // seria prometer o que ainda depende de conferência documental.
  const exigiveis = achados.filter((a) => a.situacaoPrescricional !== "DECAIDO");
  const somar = (filtro: (a: (typeof exigiveis)[number]) => boolean) =>
    exigiveis
      .filter(filtro)
      .reduce((s, a) => s.plus(a.valorExposicao ?? 0), new Prisma.Decimal(0));

  const confirmado = (a: (typeof exigiveis)[number]) => a.confianca === "ALTA";
  const aConfirmar = somar((a) => !confirmado(a));
  const qtdAConfirmar = exigiveis.filter((a) => !confirmado(a)).length;

  return (
    <>
      <CabecalhoAuditoria auditoria={auditoria} empresa={auditoria.empresa} />
      <AbasAuditoria auditoriaId={params.id} contagens={porArea} />

      <div className="mb-3">
        <h2 className="text-[13px] font-bold">Análise fiscal e tributária</h2>
        <p className="mt-0.5 text-[10px] text-content-muted">
          Erros de apuração, de escrituração e de documento fiscal. Recolhimento,
          confissão e escrituração contábil ficam na aba <strong>Contábil</strong>.
        </p>
      </div>

      <div className="kpis mb-3">
        <div className="kpi" style={{ borderLeftColor: "var(--danger)" }}>
          <div className="kpi-label">Risco de autuação</div>
          <div className="kpi-val">
            {moeda(somar((a) => confirmado(a) && a.severidade !== "OPORTUNIDADE"))}
          </div>
          <div className="kpi-sub">confirmado</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--success)" }}>
          <div className="kpi-label">A recuperar</div>
          <div className="kpi-val">
            {moeda(somar((a) => confirmado(a) && a.severidade === "OPORTUNIDADE"))}
          </div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--info)" }}>
          <div className="kpi-label">A confirmar</div>
          <div className="kpi-val">{moeda(aConfirmar)}</div>
          <div className="kpi-sub">
            {qtdAConfirmar} achado(s) com ressalva
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Achados fiscais</div>
          <div className="kpi-val">{achados.length}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Não avaliados</div>
          <div className="kpi-val">{lacunas.length}</div>
        </div>
      </div>

      <ListaAchados
        achados={achados}
        lacunas={lacunas}
        vazio="Com os documentos importados, as regras fiscais aplicáveis não encontraram inconsistência. Veja abaixo o que não pôde ser avaliado."
      />
    </>
  );
}

import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { AbasAuditoria } from "@/components/AbasAuditoria";
import { CabecalhoAuditoria } from "@/components/CabecalhoAuditoria";
import { ListaAchados } from "@/components/ListaAchados";
import { AcompanharAnaliseIa } from "@/components/AnaliseIaControles";
import { analiseIaDaArea, contagensDasAbas } from "@/server/claude/consulta";
import { moeda } from "@/lib/formato";
import { ConfrontoDeclarado } from "@/components/ConfrontoDeclarado";
import { confrontoApuradoDeclarado } from "@/server/confronto/apurado-declarado";

export const dynamic = "force-dynamic";
export const metadata = { title: "Análise contábil · Auditoria Azuos" };

export default async function ContabilPage({
  params,
}: {
  params: { id: string };
}) {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: params.id },
    include: { empresa: true },
  });
  if (!auditoria) notFound();

  const [achados, lacunas, porArea, ia, confronto] = await Promise.all([
    prisma.achado.findMany({
      where: { auditoriaId: params.id, area: "CONTABIL" },
      include: { evidencias: true },
    }),
    prisma.lacuna.findMany({
      where: { auditoriaId: params.id, area: "CONTABIL" },
      orderBy: { escopo: "asc" },
    }),
    contagensDasAbas(params.id),
    analiseIaDaArea(params.id, "CONTABIL"),
    confrontoApuradoDeclarado(params.id),
  ]);

  // Fora dos totais acima: é leitura a confirmar, não cálculo testado.
  const iaExposicao = ia.apontamentos
    .filter((a) => a.severidade !== "OPORTUNIDADE")
    .reduce((s, a) => s.plus(a.valorEstimado ?? 0), new Prisma.Decimal(0));

  const exigiveis = achados.filter((a) => a.situacaoPrescricional !== "DECAIDO");

  // Débito em aberto é o que a empresa já declarou e não pagou — dívida líquida
  // e certa (família A). O resto é exposição a lançamento de ofício. Somar os
  // dois seria desonesto: têm naturezas jurídicas diferentes.
  const somar = (
    filtro: (codigo: string, severidade: string, confianca: string) => boolean,
  ) =>
    exigiveis
      .filter((a) => filtro(a.codigo, a.severidade, a.confianca))
      .reduce((s, a) => s.plus(a.valorExposicao ?? 0), new Prisma.Decimal(0));

  const debitoAberto = somar(
    (c, s, conf) => conf === "ALTA" && c.startsWith("A") && s !== "OPORTUNIDADE",
  );
  const risco = somar(
    (c, s, conf) => conf === "ALTA" && !c.startsWith("A") && s !== "OPORTUNIDADE",
  );
  const recuperavel = somar((_, s, conf) => conf === "ALTA" && s === "OPORTUNIDADE");
  const aConfirmar = somar((_c, _s, conf) => conf !== "ALTA");
  const qtdAConfirmar = exigiveis.filter((a) => a.confianca !== "ALTA").length;

  return (
    <>
      <CabecalhoAuditoria auditoria={auditoria} empresa={auditoria.empresa} />
      <AbasAuditoria auditoriaId={params.id} contagens={porArea} />

      <div className="mb-3">
        <h2 className="text-[13px] font-bold">Análise contábil e de recolhimento</h2>
        <p className="mt-0.5 text-[10px] text-content-muted">
          Pagamento — tributo declarado ou confessado e não recolhido — e escrituração
          contábil. Erros de apuração, declaração e obrigação acessória ficam na aba{" "}
          <strong>Fiscal</strong>.
        </p>
      </div>

      <div className="kpis mb-3">
        <div className="kpi" style={{ borderLeftColor: "var(--danger)" }}>
          <div className="kpi-label">Débito em aberto</div>
          <div className="kpi-val">{moeda(debitoAberto)}</div>
          <div className="kpi-sub">declarado e não pago</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--warning)" }}>
          <div className="kpi-label">Risco de autuação</div>
          <div className="kpi-val">{moeda(risco)}</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--success)" }}>
          <div className="kpi-label">A recuperar</div>
          <div className="kpi-val">{moeda(recuperavel)}</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--info)" }}>
          <div className="kpi-label">A confirmar</div>
          <div className="kpi-val">{moeda(aConfirmar)}</div>
          <div className="kpi-sub">{qtdAConfirmar} achado(s) com ressalva</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Achados contábeis</div>
          <div className="kpi-val">{achados.length}</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "#7c3aed" }}>
          <div className="kpi-label">Apontado pelo Claude</div>
          <div className="kpi-val">{moeda(iaExposicao)}</div>
          <div className="kpi-sub">
            {ia.apontamentos.length} apontamento(s) · a confirmar
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Não avaliados</div>
          <div className="kpi-val">{lacunas.length}</div>
        </div>
      </div>

      <ConfrontoDeclarado resumo={confronto} />

      <AcompanharAnaliseIa emAndamento={ia.emAndamento} />
      {ia.emAndamento || ia.apontamentos.length > 0 ? (
        <p className="mb-2 text-[10px] text-content-muted">
          {ia.emAndamento ? (
            <>
              <strong>Análise do Claude em andamento</strong> — os apontamentos novos
              aparecem aqui ao terminar, e a página se atualiza sozinha.{" "}
            </>
          ) : null}
          {ia.concluidaEm && ia.apontamentos.length > 0 ? (
            <>
              A lista inclui os apontamentos {"contábeis"} da análise do Claude de{" "}
              {ia.concluidaEm.toLocaleDateString("pt-BR")} às{" "}
              {ia.concluidaEm.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })},
              marcados <strong>Claude · a confirmar</strong> e fora dos totais.
            </>
          ) : null}
        </p>
      ) : null}

      <ListaAchados
        apontamentosIa={ia.apontamentos}
        achados={achados}
        lacunas={lacunas}
        vazio="Nenhuma inconsistência contábil encontrada com os documentos importados. Veja abaixo o que não pôde ser avaliado — os achados de recolhimento dependem dos comprovantes de arrecadação e da DCTF."
      />
    </>
  );
}

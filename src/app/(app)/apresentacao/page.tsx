import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { cnpj, competencia } from "@/lib/formato";

export const dynamic = "force-dynamic";
export const metadata = { title: "Apresentação · Auditoria Azuos" };

export default async function ApresentacaoIndexPage() {
  const auditorias = await prisma.auditoria.findMany({
    include: {
      empresa: { select: { razaoSocial: true, cnpj: true, uf: true } },
      _count: { select: { achados: true } },
    },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <>
      <div className="mb-3">
        <h1 className="text-[15px] font-bold">Apresentação ao cliente</h1>
        <p className="mt-0.5 text-[11px] text-content-muted">
          Selecione a empresa. A apresentação abre em tela própria, com o resumo da auditoria e os principais
          apontamentos — o detalhe completo fica reservado ao relatório contratado.
        </p>
      </div>

      {auditorias.length === 0 ? (
        <div className="card text-[12px] text-content-muted">
          Nenhuma auditoria ainda. Importe os arquivos de uma empresa para começar.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {auditorias.map((a) => (
            <Link
              key={a.id}
              href={`/apresentacao/${a.id}`}
              className="card block transition hover:-translate-y-0.5 hover:shadow-md"
              style={{ borderLeft: "3px solid var(--azuos-primary)" }}
            >
              <div className="text-[13px] font-bold">{a.empresa.razaoSocial}</div>
              <div className="mt-0.5 font-mono text-[11px] text-content-muted">
                {cnpj(a.empresa.cnpj)}
                {a.empresa.uf ? ` · ${a.empresa.uf}` : ""}
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px]">
                <span className="text-content-muted">
                  {competencia(a.competenciaIni)} a {competencia(a.competenciaFim)}
                </span>
                <span className="rounded-full bg-azuos-light px-2 py-0.5 font-semibold text-azuos">
                  {a._count.achados} apontamento(s)
                </span>
              </div>
              <div className="mt-2 text-[12px] font-semibold text-azuos">Apresentar →</div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

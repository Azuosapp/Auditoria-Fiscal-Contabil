import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { moeda, competencia, cnpj as fmtCnpj } from "@/lib/formato";

export const metadata = { title: "Auditorias · Auditoria Azuos" };
export const dynamic = "force-dynamic";

const ROTULO_STATUS: Record<string, string> = {
  RASCUNHO: "Rascunho",
  IMPORTANDO: "Importando",
  PROCESSANDO: "Processando",
  PRONTA: "Pronta",
  ENTREGUE: "Entregue",
  ARQUIVADA: "Arquivada",
};

export default async function AuditoriasPage() {
  const auditorias = await prisma.auditoria.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      empresa: true,
      _count: { select: { documentos: true, achados: true } },
    },
  });

  return (
    <>
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-[15px] font-bold">Auditorias</h1>
          <p className="mt-0.5 text-[11px] text-content-muted">
            Diagnóstico fiscal e contábil dos últimos 5 exercícios a partir dos
            arquivos do cliente.
          </p>
        </div>
        <Link href="/auditorias/nova" className="btn-primary">
          Nova auditoria
        </Link>
      </div>

      {auditorias.length === 0 ? (
        <div className="card flex flex-col items-center gap-2 py-12 text-center">
          <div className="text-[13px] font-semibold">Nenhuma auditoria ainda</div>
          <p className="max-w-md text-[11px] text-content-muted">
            Cadastre a empresa, informe o regime tributário de cada exercício e
            importe os arquivos. O sistema cruza SPED, XML, ECD, ECF, DCTF e
            comprovantes de arrecadação e aponta o que a contabilidade atual errou.
          </p>
          <Link href="/auditorias/nova" className="btn-primary mt-2">
            Começar
          </Link>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Empresa</th>
                <th className="w-32">CNPJ</th>
                <th className="w-36">Período</th>
                <th className="w-24">Status</th>
                <th className="w-20">Docs</th>
                <th className="w-20">Achados</th>
                <th className="w-32">Exposição</th>
                <th className="w-24"></th>
              </tr>
            </thead>
            <tbody>
              {auditorias.map((a) => (
                <tr key={a.id}>
                  <td>
                    <Link
                      href={`/auditorias/${a.id}`}
                      className="font-medium text-azuos-primary hover:underline"
                    >
                      {a.empresa.razaoSocial}
                    </Link>
                  </td>
                  <td className="font-mono text-[10px]">
                    {fmtCnpj(a.empresa.cnpj)}
                  </td>
                  <td className="text-[10px]">
                    {competencia(a.competenciaIni)} a {competencia(a.competenciaFim)}
                  </td>
                  <td className="text-[10px]">
                    {ROTULO_STATUS[a.status] ?? a.status}
                  </td>
                  <td className="num">{a._count.documentos}</td>
                  <td className="num">{a._count.achados}</td>
                  <td className="num font-semibold">
                    {moeda(a.totalDebitoAberto)}
                  </td>
                  <td>
                    {/* O relatório é o produto final da auditoria: precisa
                        estar a um clique da lista, não escondido lá dentro. */}
                    <Link
                      href={`/auditorias/${a.id}/relatorio`}
                      className="btn-ghost !px-2 !py-1 !text-[10px]"
                    >
                      Gerar PDF
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

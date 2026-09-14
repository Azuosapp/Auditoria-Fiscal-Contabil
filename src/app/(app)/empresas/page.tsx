import { prisma } from "@/lib/prisma";
import { cnpj as fmtCnpj } from "@/lib/formato";

export const metadata = { title: "Empresas · Auditoria Azuos" };
export const dynamic = "force-dynamic";

export default async function EmpresasPage() {
  const empresas = await prisma.empresa.findMany({
    where: { deletedAt: null },
    orderBy: { razaoSocial: "asc" },
    include: {
      regimes: { orderBy: { exercicio: "desc" } },
      _count: { select: { auditorias: true } },
    },
  });

  return (
    <>
      <div className="mb-4">
        <h1 className="text-[15px] font-bold">Empresas</h1>
        <p className="mt-0.5 text-[11px] text-content-muted">
          Clientes e prospectos com auditoria cadastrada.
        </p>
      </div>

      {empresas.length === 0 ? (
        <div className="card py-12 text-center">
          <div className="text-[13px] font-semibold">Nenhuma empresa cadastrada</div>
          <p className="mt-1 text-[11px] text-content-muted">
            A empresa é criada junto com a primeira auditoria.
          </p>
        </div>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Razão social</th>
                <th className="w-32">CNPJ</th>
                <th className="w-16">UF</th>
                <th className="w-24">CNAE</th>
                <th className="w-44">Regimes</th>
                <th className="w-20">Auditorias</th>
              </tr>
            </thead>
            <tbody>
              {empresas.map((e) => (
                <tr key={e.id}>
                  <td className="font-medium">{e.razaoSocial}</td>
                  <td className="font-mono text-[10px]">{fmtCnpj(e.cnpj)}</td>
                  <td>{e.uf ?? "—"}</td>
                  <td className="font-mono text-[10px]">{e.cnaePrincipal ?? "—"}</td>
                  <td className="text-[10px] text-content-muted">
                    {e.regimes.length === 0
                      ? "não informado"
                      : e.regimes
                          .map((r) => `${r.exercicio}: ${r.regime}`)
                          .join(" · ")}
                  </td>
                  <td className="num">{e._count.auditorias}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

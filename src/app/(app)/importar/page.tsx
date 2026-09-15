import { PainelImportacao } from "@/components/PainelImportacao";

export const metadata = { title: "Importar arquivos · Auditoria Azuos" };

export default function ImportarPage({
  searchParams,
}: {
  searchParams: { auditoria?: string };
}) {
  return (
    <>
      <div className="mb-4">
        <h1 className="text-[15px] font-bold">Importar arquivos</h1>
        <p className="mt-0.5 text-[11px] text-content-muted">
          Solte os documentos do cliente. A empresa, o período e o regime de cada
          exercício são lidos dos próprios arquivos — não é preciso cadastrar nada
          antes.
        </p>
      </div>

      <PainelImportacao auditoriaAlvo={searchParams.auditoria} />
    </>
  );
}

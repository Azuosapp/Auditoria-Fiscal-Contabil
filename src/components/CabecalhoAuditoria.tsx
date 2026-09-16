import Link from "next/link";
import { cnpj as fmtCnpj, competencia as fmtComp } from "@/lib/formato";

const ROTULO_NIVEL: Record<string, string> = {
  DIAGNOSTICO_RAPIDO: "Diagnóstico rápido",
  FISCAL: "Auditoria fiscal",
  COMPLETA: "Auditoria completa",
};

export function CabecalhoAuditoria({
  auditoria,
  empresa,
}: {
  auditoria: {
    id: string;
    competenciaIni: string;
    competenciaFim: string;
    nivelAlcancado: string | null;
  };
  empresa: { razaoSocial: string; cnpj: string; uf: string | null };
}) {
  return (
    <div className="mb-3 flex items-end justify-between">
      <div>
        <h1 className="text-[15px] font-bold">{empresa.razaoSocial}</h1>
        <p className="mt-0.5 text-[11px] text-content-muted">
          <span className="font-mono">{fmtCnpj(empresa.cnpj)}</span>
          {empresa.uf ? ` · ${empresa.uf}` : ""} ·{" "}
          {fmtComp(auditoria.competenciaIni)} a {fmtComp(auditoria.competenciaFim)}
          {auditoria.nivelAlcancado
            ? ` · ${ROTULO_NIVEL[auditoria.nivelAlcancado] ?? auditoria.nivelAlcancado}`
            : ""}
        </p>
      </div>
      <div className="flex gap-2">
        <Link href={`/apresentacao/${auditoria.id}`} className="btn-primary">
          Apresentar
        </Link>
        <Link href={`/auditorias/${auditoria.id}/relatorio`} className="btn-ghost">
          Gerar PDF
        </Link>
        <Link href={`/importar?auditoria=${auditoria.id}`} className="btn-ghost">
          Importar mais arquivos
        </Link>
      </div>
    </div>
  );
}

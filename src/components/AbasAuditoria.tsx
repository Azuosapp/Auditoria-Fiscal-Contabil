"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Abas da auditoria.
 *
 * Fiscal e contábil são conversas diferentes com o cliente: erro de apuração e
 * de documento fiscal de um lado; pagamento, confissão e escrituração contábil
 * do outro. A situação fiscal fica à parte porque não é conclusão nossa — é o
 * registro do próprio Fisco, e vale na apresentação exatamente por isso.
 */

const ABAS = [
  { sufixo: "", rotulo: "Visão geral" },
  { sufixo: "/fiscal", rotulo: "Fiscal" },
  { sufixo: "/contabil", rotulo: "Contábil" },
  { sufixo: "/situacao-fiscal", rotulo: "Situação fiscal" },
  { sufixo: "/relatorio", rotulo: "Relatório" },
];

export function AbasAuditoria({
  auditoriaId,
  contagens,
}: {
  auditoriaId: string;
  contagens?: Record<string, number>;
}) {
  const caminho = usePathname();
  const base = `/auditorias/${auditoriaId}`;

  return (
    <div className="tabs">
      {ABAS.map((aba) => {
        const href = `${base}${aba.sufixo}`;
        const n = contagens?.[aba.sufixo];
        return (
          <Link
            key={aba.sufixo}
            href={href}
            className="tab"
            data-ativo={caminho === href}
          >
            {aba.rotulo}
            {typeof n === "number" && n > 0 ? (
              <span className="ml-1.5 opacity-70">{n}</span>
            ) : null}
          </Link>
        );
      })}
    </div>
  );
}

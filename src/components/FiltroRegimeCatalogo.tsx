import Link from "next/link";

/**
 * Filtro de regime do catálogo.
 *
 * O padrão não é "todos": é o regime das empresas já cadastradas. Quem audita só
 * empresa do Lucro Real não deveria precisar escolher nada para deixar de ver
 * regra do Simples — e ver a regra que não se aplica passa a impressão errada de
 * que o sistema vai procurá-la.
 */

const REGIMES = [
  { valor: "LUCRO_REAL", rotulo: "Lucro Real" },
  { valor: "LUCRO_PRESUMIDO", rotulo: "Lucro Presumido" },
  { valor: "SIMPLES_NACIONAL", rotulo: "Simples Nacional" },
];

export function FiltroRegimeCatalogo({
  selecionado,
  regimesCadastrados,
  rotuloAtual,
  ocultos,
}: {
  selecionado?: string;
  regimesCadastrados: string[];
  rotuloAtual: string;
  ocultos: number;
}) {
  const semSelecao = !selecionado;

  return (
    <div className="card mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-[0.5px] text-content-muted">
          Regime
        </span>

        {regimesCadastrados.length > 0 ? (
          <Link
            href="/catalogo"
            className="tab"
            data-ativo={semSelecao}
            style={{ border: "1px solid var(--border)" }}
          >
            Das minhas empresas
          </Link>
        ) : null}

        {REGIMES.map((r) => (
          <Link
            key={r.valor}
            href={`/catalogo?regime=${r.valor}`}
            className="tab"
            data-ativo={selecionado === r.valor}
            style={{ border: "1px solid var(--border)" }}
          >
            {r.rotulo}
          </Link>
        ))}

        <Link
          href="/catalogo?regime=todos"
          className="tab"
          data-ativo={selecionado === "todos"}
          style={{ border: "1px solid var(--border)" }}
        >
          Ver todos
        </Link>
      </div>

      <p className="mt-2 text-[10px] text-content-muted">
        Mostrando o que se aplica a: <strong>{rotuloAtual}</strong>
        {ocultos > 0
          ? ` · ${ocultos} achado(s) de outros regimes estão ocultos.`
          : "."}
      </p>
    </div>
  );
}

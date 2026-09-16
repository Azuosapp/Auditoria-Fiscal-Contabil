import type { ApontamentoIa } from "@prisma/client";
import { competencia as fmtComp, moeda } from "@/lib/formato";

/**
 * Cartão de um apontamento da análise do Claude.
 *
 * Mesmo desenho do cartão de achado, para a aba ler como uma lista só. A
 * diferença fica no selo "Claude · a confirmar": não é cálculo testado, é a
 * leitura de um auditor sobre os arquivos, e a evidência precisa ser conferida
 * antes de ir para o cliente. As evidências abrem no clique, como os exemplos
 * dos achados.
 */

const CLASSE_SEV: Record<string, string> = {
  CRITICO: "sev sev-critico",
  ALTO: "sev sev-alto",
  MEDIO: "sev sev-medio",
  BAIXO: "sev sev-baixo",
  OPORTUNIDADE: "sev sev-oportunidade",
};

const ROTULO_CONFIANCA: Record<string, string> = {
  ALTA: "confiança alta",
  MEDIA: "confiança média",
  BAIXA: "confiança baixa",
};

interface Evidencia {
  arquivo: string;
  localizacao: string;
  detalhe: string;
  valor: string;
}

function periodo(comps: string[]): string | null {
  if (comps.length === 0) return null;
  if (comps.length === 1) return fmtComp(comps[0]);
  return `${comps.length} competências · ${fmtComp(comps[0])} a ${fmtComp(comps[comps.length - 1])}`;
}

export function ApontamentoIaCard({ apontamento: a }: { apontamento: ApontamentoIa }) {
  const evidencias = (a.evidencias ?? []) as unknown as Evidencia[];
  const quando = periodo(a.competencias);

  return (
    <article className="achado" data-sev={a.severidade}>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-[0.3px]"
          style={{ background: "#ede9fe", color: "#5b21b6" }}
          title="Apontado pela análise do Claude. Confira as evidências antes de levar ao cliente."
        >
          Claude · a confirmar
        </span>
        <span className={CLASSE_SEV[a.severidade]}>{a.severidade}</span>
        <span className="text-[12px] font-semibold">{a.titulo}</span>
        {a.tributo ? (
          <span className="text-[10px] text-content-muted">{a.tributo}</span>
        ) : null}
        {quando ? (
          <span className="font-mono text-[10px] text-content-muted">{quando}</span>
        ) : null}
        <span className="sev sev-baixo">{ROTULO_CONFIANCA[a.confianca]}</span>
        {a.valorEstimado ? (
          <span className="ml-auto font-mono text-[13px] font-bold">
            {moeda(a.valorEstimado)}
          </span>
        ) : null}
      </div>

      <p className="mt-2 whitespace-pre-line text-[11px]">{a.descricao}</p>

      {a.recomendacao ? (
        <p className="mt-2 text-[10px]">
          <strong>O que fazer:</strong> {a.recomendacao}
        </p>
      ) : null}

      {evidencias.length > 0 ? (
        <details className="mt-2 rounded-md border border-surface-border">
          <summary className="cursor-pointer px-2 py-1 text-[10px] font-medium text-content-muted">
            Ver as evidências — {evidencias.length} ponto(s) para conferir
          </summary>
          <div className="border-t border-surface-border">
            <table className="tbl !text-[10px]">
              <thead>
                <tr>
                  <th className="w-48">Arquivo</th>
                  <th className="w-56">Onde</th>
                  <th>O que mostra</th>
                  <th className="w-32">Valor</th>
                </tr>
              </thead>
              <tbody>
                {evidencias.map((e, i) => (
                  <tr key={i}>
                    <td className="break-all">{e.arquivo}</td>
                    <td className="break-all font-mono text-[9px]">{e.localizacao}</td>
                    <td>{e.detalhe}</td>
                    <td className="num">{e.valor}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      ) : null}

      {a.baseLegal.length > 0 ? (
        <div className="mt-2 text-[9px] text-content-muted">{a.baseLegal.join(" · ")}</div>
      ) : null}
    </article>
  );
}

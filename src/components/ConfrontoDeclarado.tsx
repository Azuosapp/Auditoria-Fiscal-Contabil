import type { LinhaConfronto, ResumoConfronto, SituacaoConfronto, TributoFederal } from "@/server/confronto/apurado-declarado";
import { moeda } from "@/lib/formato";

/**
 * Imposto apurado nas escriturações × declarado à Receita, por tributo e período.
 *
 * Duas variantes: "painel" (aba Contábil, densa) e "apresentacao" (tela do
 * cliente, maior e só com o que diverge em destaque).
 */

const NOME: Record<TributoFederal, string> = {
  IRPJ: "IRPJ",
  CSLL: "CSLL",
  PIS: "PIS",
  COFINS: "COFINS",
  IPI: "IPI",
};

const SITUACAO: Record<SituacaoConfronto, { rotulo: string; cor: string; fundo: string }> = {
  CONFERE: { rotulo: "Confere", cor: "#047857", fundo: "#d1fae5" },
  DECLARADO_A_MENOR: { rotulo: "Declarou a menor", cor: "#b91c1c", fundo: "#fee2e2" },
  NAO_DECLARADO: { rotulo: "Não declarado", cor: "#b91c1c", fundo: "#fee2e2" },
  DECLARADO_A_MAIOR: { rotulo: "Declarou a maior", cor: "#1d4ed8", fundo: "#dbeafe" },
  SEM_ESCRITURACAO: { rotulo: "Declarado sem apuração", cor: "#1d4ed8", fundo: "#dbeafe" },
};

function Selo({ situacao }: { situacao: SituacaoConfronto }) {
  const s = SITUACAO[situacao];
  return (
    <span
      className="inline-block whitespace-nowrap rounded-full px-2 py-0.5 font-semibold"
      style={{ color: s.cor, background: s.fundo, fontSize: "0.85em" }}
    >
      {s.rotulo}
    </span>
  );
}

function Diferenca({ l }: { l: LinhaConfronto }) {
  if (l.situacao === "CONFERE") return <span className="text-content-muted">—</span>;
  const menor = l.situacao === "DECLARADO_A_MENOR" || l.situacao === "NAO_DECLARADO";
  return (
    <span className="font-bold" style={{ color: menor ? "#b91c1c" : "#1d4ed8" }}>
      {menor ? "− " : "+ "}
      {moeda(l.diferenca.abs())}
    </span>
  );
}

export function ConfrontoDeclarado({
  resumo,
  variante = "painel",
}: {
  resumo: ResumoConfronto;
  variante?: "painel" | "apresentacao";
}) {
  const grande = variante === "apresentacao";
  if (!resumo.temDctf) {
    return grande ? null : (
      <div className="card mb-3">
        <h3 className="text-[12px] font-bold">Imposto apurado × declarado à Receita</h3>
        <p className="mt-1 text-[11px] text-content-muted">
          Sem DCTF ou DCTFWeb (MIT) importada: o confronto com a ECF, a EFD-Contribuições e a EFD ICMS/IPI não pôde ser feito.
        </p>
      </div>
    );
  }
  if (resumo.linhas.length === 0) return null;

  const tributos = [...new Set(resumo.linhas.map((l) => l.tributo))];

  return (
    <section className={grande ? "" : "card mb-3"}>
      {!grande ? (
        <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-[12px] font-bold">Imposto apurado × declarado à Receita</h3>
            <p className="text-[10px] text-content-muted">
              IRPJ e CSLL da ECF, PIS e COFINS da EFD-Contribuições e IPI da EFD ICMS/IPI, contra a última DCTF ou DCTFWeb (MIT) de cada período. ICMS é estadual e não entra.
            </p>
          </div>
          <div className="flex gap-3 text-[11px]">
            <span>
              Não declarado: <strong style={{ color: "#b91c1c" }}>{moeda(resumo.naoDeclarado)}</strong>
            </span>
            <span>
              Declarado a maior: <strong style={{ color: "#1d4ed8" }}>{moeda(resumo.declaradoAMaior)}</strong>
            </span>
            <span className="text-content-muted">
              {resumo.periodosDivergentes} de {resumo.periodosConferidos} período(s) divergem
            </span>
          </div>
        </div>
      ) : null}

      <div className={grande ? "grid gap-4" : "grid gap-3 2xl:grid-cols-2"}>
        {tributos.map((t) => {
          const linhas = resumo.linhas.filter((l) => l.tributo === t);
          const temBase = linhas.some((l) => l.base);
          return (
            <div
              key={t}
              className="overflow-hidden rounded-lg border border-surface-border bg-white"
              style={grande ? { boxShadow: "0 1px 3px rgba(0,0,0,.08)" } : undefined}
            >
              <div
                className="flex items-center justify-between px-3 py-2 text-white"
                style={{ background: "linear-gradient(135deg, var(--azuos-dark), var(--azuos-primary))" }}
              >
                <span className={grande ? "text-[16px] font-bold" : "text-[12px] font-bold"}>{NOME[t]}</span>
                <span className="text-white/70" style={{ fontSize: grande ? 12 : 10 }}>
                  apurado na {linhas[0].fonteApurado} × declarado em DCTF
                </span>
              </div>
              <div className="overflow-x-auto">
              <table className="w-full" style={{ fontSize: grande ? 14 : 11 }}>
                <thead>
                  <tr className="text-left text-content-muted" style={{ fontSize: grande ? 11 : 9.5 }}>
                    <th className="px-3 py-1.5 font-semibold">Período</th>
                    {temBase ? <th className="px-2 py-1.5 text-right font-semibold">Lucro / base</th> : null}
                    <th className="px-2 py-1.5 text-right font-semibold">Apurado</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Declarado</th>
                    <th className="px-2 py-1.5 text-right font-semibold">Diferença</th>
                    <th className="px-3 py-1.5 text-right font-semibold">Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {linhas.map((l) => (
                    <tr key={l.competencia} className="border-t border-surface-border">
                      <td className="whitespace-nowrap px-3 py-1.5 font-medium">{l.periodo}</td>
                      {temBase ? <td className="whitespace-nowrap px-2 py-1.5 text-right">{l.base ? moeda(l.base) : "—"}</td> : null}
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">{moeda(l.apurado)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">{moeda(l.declarado)}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-right">
                        <Diferenca l={l} />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Selo situacao={l.situacao} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

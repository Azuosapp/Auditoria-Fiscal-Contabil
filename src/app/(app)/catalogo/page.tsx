import type { RegimeTributario } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CATALOGO,
  aplicavelAoRegime,
  type AreaAchado,
  type DefinicaoAchado,
} from "@/server/auditoria/catalogo";

export const metadata = { title: "Catálogo de achados · Auditoria Azuos" };
export const dynamic = "force-dynamic";

const NOME_FAMILIA: Record<string, string> = {
  DIVERGENCIA_PAGAMENTO: "A · Apurado × Confessado × Pago",
  RECEITA: "B · Receita e omissão",
  CREDITO: "C · Crédito indevido e crédito perdido",
  REGIME: "D · Regime e enquadramento",
  ICMS_OPERACIONAL: "E · ICMS operacional",
  CONTABIL: "F · Contábil (ECD e ECF)",
  ACESSORIA: "G · Obrigações acessórias",
};

const AREAS: { chave: AreaAchado; titulo: string; descricao: string }[] = [
  {
    chave: "FISCAL",
    titulo: "Análise fiscal e tributária",
    descricao:
      "Erros de apuração, de escrituração e de documento fiscal. É o que a " +
      "empresa declarou, escriturou e emitiu — sem entrar no recolhimento.",
  },
  {
    chave: "CONTABIL",
    titulo: "Análise contábil e de recolhimento",
    descricao:
      "Tributo apurado × confessado × pago, escrituração contábil e obrigações " +
      "acessórias. É aqui que mora tudo sobre pagamento e confissão de débito.",
  },
];

const CLASSE_SEVERIDADE: Record<string, string> = {
  CRITICO: "sev sev-critico",
  ALTO: "sev sev-alto",
  MEDIO: "sev sev-medio",
  BAIXO: "sev sev-baixo",
  OPORTUNIDADE: "sev sev-oportunidade",
};


const ROTULO_REGIME: Record<string, string> = {
  SIMPLES_NACIONAL: "Simples Nacional",
  LUCRO_PRESUMIDO: "Lucro Presumido",
  LUCRO_REAL: "Lucro Real",
  MEI: "MEI",
  IMUNE_ISENTA: "Imune / Isenta",
  ARBITRADO: "Arbitrado",
};

function agruparPorFamilia(itens: DefinicaoAchado[]) {
  const mapa = new Map<string, DefinicaoAchado[]>();
  for (const item of itens) {
    const lista = mapa.get(item.familia) ?? [];
    lista.push(item);
    mapa.set(item.familia, lista);
  }
  return mapa;
}

export default async function CatalogoPage() {
  /**
   * O catálogo mostra apenas o que existe no regime em que as empresas estão
   * enquadradas. Não há como escolher outro regime: regra de regime alheio não
   * é informação útil aqui — passa a impressão de que o sistema vai procurar
   * aquilo, e polui a referência com o que nunca vai rodar.
   *
   * Sem empresa cadastrada ainda, mostra tudo: não há contexto para filtrar.
   */
  const regimesCadastrados = await prisma.regimePorExercicio.findMany({
    select: { regime: true },
    distinct: ["regime"],
  });

  const regimes = new Set<RegimeTributario>(
    regimesCadastrados.map((r) => r.regime),
  );

  const visiveis = CATALOGO.filter((d) => aplicavelAoRegime(d, regimes));

  const criticos = visiveis.filter((d) => d.severidade === "CRITICO").length;
  const oportunidades = visiveis.filter(
    (d) => d.severidade === "OPORTUNIDADE",
  ).length;
  const fiscais = visiveis.filter((d) => d.area === "FISCAL").length;
  const contabeis = visiveis.filter((d) => d.area === "CONTABIL").length;

  const regimeAtual =
    regimes.size > 0
      ? [...regimes].map((r) => ROTULO_REGIME[r] ?? r).join(", ")
      : null;

  return (
    <>
      <div className="mb-3">
        <h1 className="text-[15px] font-bold">Catálogo de achados</h1>
        <p className="mt-0.5 text-[11px] text-content-muted">
          Referência do que a auditoria procura — <strong>não é o resultado de
          nenhuma empresa</strong>. Os exemplos são ilustrativos, com valores
          fictícios, e servem para reconhecer o erro quando ele aparecer.
          {regimeAtual
            ? ` Lista aplicável ao ${regimeAtual}, regime em que as empresas cadastradas estão enquadradas.`
            : " Cadastre o regime de uma empresa para a lista se ajustar a ele."}
        </p>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Achados aplicáveis</div>
          <div className="kpi-val">{visiveis.length}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Fiscais</div>
          <div className="kpi-val">{fiscais}</div>
          <div className="kpi-sub">apuração e documento fiscal</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Contábeis</div>
          <div className="kpi-val">{contabeis}</div>
          <div className="kpi-sub">recolhimento e escrituração</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--danger)" }}>
          <div className="kpi-label">Críticos</div>
          <div className="kpi-val">{criticos}</div>
        </div>
        <div className="kpi" style={{ borderLeftColor: "var(--success)" }}>
          <div className="kpi-label">Oportunidades</div>
          <div className="kpi-val">{oportunidades}</div>
          <div className="kpi-sub">dinheiro a recuperar</div>
        </div>
      </div>

      {AREAS.map((area) => {
        const daArea = visiveis.filter((d) => d.area === area.chave);
        if (daArea.length === 0) return null;
        const porFamilia = agruparPorFamilia(daArea);

        return (
          <section key={area.chave} className="mb-6">
            <div
              className="mb-3 rounded-card p-3"
              style={{ background: "var(--azuos-light)" }}
            >
              <h2 className="text-[13px] font-bold">{area.titulo}</h2>
              <p className="mt-0.5 text-[10px]">{area.descricao}</p>
            </div>

            {[...porFamilia.entries()].map(([familia, itens]) => (
              <div key={familia} className="mb-4">
                <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.5px] text-content-muted">
                  {NOME_FAMILIA[familia] ?? familia}
                </h3>

                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th className="w-14">Código</th>
                        <th>Achado</th>
                        <th className="w-28">Severidade</th>
                        <th className="w-24">Tributo</th>
                        <th className="w-40">Documentos necessários</th>
                      </tr>
                    </thead>
                    <tbody>
                      {itens.map((d) => (
                        <tr key={d.codigo}>
                          <td className="font-mono font-semibold">{d.codigo}</td>
                          <td>
                            <div className="font-medium">{d.titulo}</div>
                            <div className="mt-0.5 text-[10px] text-content-muted">
                              {d.descricao}
                            </div>

                            {/* O exemplo é o que torna a regra reconhecível:
                                "divergência entre escriturações" é abstrato;
                                ver os dois números é o que faz a pessoa
                                identificar o caso no cliente dela. */}
                            <div
                              className="mt-1.5 rounded border-l-2 px-2 py-1 text-[10px]"
                              style={{
                                background: "#f8fafc",
                                borderLeftColor: "var(--azuos-accent)",
                              }}
                            >
                              <span className="font-semibold uppercase tracking-[0.3px] text-content-muted">
                                Como aparece
                              </span>
                              <div className="mt-0.5">{d.exemplo}</div>
                            </div>

                            <div className="mt-1 text-[10px] text-content-muted">
                              {d.baseLegal.join(" · ")}
                            </div>
                          </td>
                          <td>
                            <span className={CLASSE_SEVERIDADE[d.severidade]}>
                              {d.severidade}
                            </span>
                          </td>
                          <td className="text-[10px]">{d.tributo ?? "—"}</td>
                          <td className="text-[10px] text-content-muted">
                            {d.fontesNecessarias.join(", ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </>
  );
}

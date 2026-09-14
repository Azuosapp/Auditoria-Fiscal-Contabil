import { CATALOGO, type DefinicaoAchado } from "@/server/auditoria/catalogo";

export const metadata = { title: "Catálogo de achados · Auditoria Azuos" };

const NOME_FAMILIA: Record<string, string> = {
  DIVERGENCIA_PAGAMENTO: "A · Apurado × Confessado × Pago",
  RECEITA: "B · Receita e omissão",
  CREDITO: "C · Crédito indevido e crédito perdido",
  REGIME: "D · Regime e enquadramento",
  ICMS_OPERACIONAL: "E · ICMS operacional",
  CONTABIL: "F · Contábil (ECD e ECF)",
  ACESSORIA: "G · Obrigações acessórias",
};

const CLASSE_SEVERIDADE: Record<string, string> = {
  CRITICO: "sev sev-critico",
  ALTO: "sev sev-alto",
  MEDIO: "sev sev-medio",
  BAIXO: "sev sev-baixo",
  OPORTUNIDADE: "sev sev-oportunidade",
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

export default function CatalogoPage() {
  const porFamilia = agruparPorFamilia(CATALOGO);

  const criticos = CATALOGO.filter((d) => d.severidade === "CRITICO").length;
  const oportunidades = CATALOGO.filter(
    (d) => d.severidade === "OPORTUNIDADE",
  ).length;

  return (
    <>
      <div className="mb-4">
        <h1 className="text-[15px] font-bold">Catálogo de achados</h1>
        <p className="mt-0.5 text-[11px] text-content-muted">
          Tudo que a auditoria procura nos arquivos do cliente. Cada achado é uma
          regra determinística, com base legal e evidência rastreável até o documento.
        </p>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Achados catalogados</div>
          <div className="kpi-val">{CATALOGO.length}</div>
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
        <div className="kpi">
          <div className="kpi-label">Famílias</div>
          <div className="kpi-val">{porFamilia.size}</div>
        </div>
      </div>

      {[...porFamilia.entries()].map(([familia, itens]) => (
        <section key={familia} className="mb-4">
          <h2 className="mb-2 text-[11px] font-bold uppercase tracking-[0.5px] text-content-muted">
            {NOME_FAMILIA[familia] ?? familia}
          </h2>

          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-14">Código</th>
                  <th>Achado</th>
                  <th className="w-28">Severidade</th>
                  <th className="w-24">Tributo</th>
                  <th>Documentos necessários</th>
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
        </section>
      ))}
    </>
  );
}

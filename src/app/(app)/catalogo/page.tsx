import {
  CATALOGO,
  type AreaAchado,
  type DefinicaoAchado,
} from "@/server/auditoria/catalogo";

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

const AREAS: {
  chave: AreaAchado;
  titulo: string;
  descricao: string;
}[] = [
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
  SIMPLES_NACIONAL: "Simples",
  LUCRO_PRESUMIDO: "Presumido",
  LUCRO_REAL: "Real",
  MEI: "MEI",
  IMUNE_ISENTA: "Imune/Isenta",
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

export default function CatalogoPage() {
  const criticos = CATALOGO.filter((d) => d.severidade === "CRITICO").length;
  const oportunidades = CATALOGO.filter(
    (d) => d.severidade === "OPORTUNIDADE",
  ).length;
  const fiscais = CATALOGO.filter((d) => d.area === "FISCAL").length;
  const contabeis = CATALOGO.filter((d) => d.area === "CONTABIL").length;

  return (
    <>
      <div className="mb-4">
        <h1 className="text-[15px] font-bold">Catálogo de achados</h1>
        <p className="mt-0.5 text-[11px] text-content-muted">
          Referência geral do que a auditoria procura — <strong>não é o
          resultado de nenhuma empresa</strong>. Numa auditoria concreta, só
          aparecem os achados aplicáveis ao regime dela, e cada um cai na aba
          Fiscal ou Contábil conforme a divisão abaixo.
        </p>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Achados catalogados</div>
          <div className="kpi-val">{CATALOGO.length}</div>
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
        const daArea = CATALOGO.filter((d) => d.area === area.chave);
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
                        <th className="w-32">Só nos regimes</th>
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
                            {d.regimesAplicaveis
                              ? d.regimesAplicaveis
                                  .map((r) => ROTULO_REGIME[r] ?? r)
                                  .join(", ")
                              : "todos"}
                          </td>
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

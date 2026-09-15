import type { RegimeTributario } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  CATALOGO,
  aplicavelAoRegime,
  type AreaAchado,
  type DefinicaoAchado,
} from "@/server/auditoria/catalogo";
import {
  CatalogoComExemplos,
  type AreaCatalogo,
} from "@/components/CatalogoComExemplos";

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

  const areasMontadas: AreaCatalogo[] = AREAS.map((area) => {
    const daArea = visiveis.filter((d) => d.area === area.chave);
    const porFamilia = agruparPorFamilia(daArea);

    return {
      chave: area.chave,
      titulo: area.titulo,
      descricao: area.descricao,
      familias: [...porFamilia.entries()].map(([chave, itens]) => ({
        chave,
        nome: NOME_FAMILIA[chave] ?? chave,
        itens: itens.map((d) => ({
          codigo: d.codigo,
          titulo: d.titulo,
          descricao: d.descricao,
          exemplo: d.exemplo,
          severidade: d.severidade,
          tributo: d.tributo,
          fontesNecessarias: d.fontesNecessarias,
          baseLegal: d.baseLegal,
        })),
      })),
    };
  }).filter((a) => a.familias.length > 0);

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

      <CatalogoComExemplos areas={areasMontadas} />
    </>
  );
}

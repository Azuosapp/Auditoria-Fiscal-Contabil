import Link from "next/link";
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

/** Enumeração corrida em português: "A, B e C". */
function enumerar(itens: string[]): string {
  if (itens.length <= 1) return itens[0] ?? "";
  return `${itens.slice(0, -1).join(", ")} e ${itens[itens.length - 1]}`;
}

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
  const empresas = await prisma.empresa.findMany({
    select: { razaoSocial: true, regimes: { select: { regime: true } } },
    orderBy: { razaoSocial: "asc" },
  });

  const regimes = new Set<RegimeTributario>(
    empresas.flatMap((e) => e.regimes.map((r) => r.regime)),
  );

  // Quem responde pelo filtro. Sem isso a tela parece o catálogo de uma
  // empresa só — foi exatamente o que confundiu na primeira leitura.
  const comRegime = empresas.filter((e) => e.regimes.length > 0);
  const nomesFiltrantes =
    comRegime.length <= 3
      ? enumerar(comRegime.map((e) => e.razaoSocial))
      : `${comRegime.length} empresas cadastradas`;

  const visiveis = CATALOGO.filter((d) => aplicavelAoRegime(d, regimes));

  const criticos = visiveis.filter((d) => d.severidade === "CRITICO").length;
  const oportunidades = visiveis.filter(
    (d) => d.severidade === "OPORTUNIDADE",
  ).length;
  const fiscais = visiveis.filter((d) => d.area === "FISCAL").length;
  const contabeis = visiveis.filter((d) => d.area === "CONTABIL").length;

  const rotulosRegime = [...regimes].map((r) => ROTULO_REGIME[r] ?? r).sort();
  const regimeAtual = rotulosRegime.length > 0 ? enumerar(rotulosRegime) : null;

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
          Referência do que a auditoria sabe procurar. Os exemplos são
          ilustrativos, com valores fictícios, e servem para reconhecer o erro
          quando ele aparecer no relatório de uma empresa.
        </p>
      </div>

      <div
        className="mb-3 rounded-md border px-3 py-2 text-[11px]"
        style={{
          background: "#eff6ff",
          borderColor: "#bfdbfe",
          color: "#1e3a8a",
        }}
      >
        <strong>Esta tela não é de nenhuma empresa.</strong> Nenhum número aqui
        veio de documento importado. Para ver os achados de uma empresa, abra a
        auditoria dela em{" "}
        <Link href="/auditorias" className="underline">
          Auditorias
        </Link>{" "}
        e use as abas Fiscal e Contábil — lá o nome e o CNPJ aparecem no topo da
        página.
        {regimeAtual ? (
          <div className="mt-1">
            A lista abaixo está limitada{" "}
            {rotulosRegime.length > 1 ? "aos regimes " : "ao "}
            <strong>{regimeAtual}</strong>, de {nomesFiltrantes}. Regra que não vale em nenhum desses regimes fica
            oculta, porque a auditoria nunca vai executá-la.
          </div>
        ) : (
          <div className="mt-1">
            Cadastre o regime de uma empresa para a lista se ajustar a ele. Sem
            isso, o catálogo mostra todas as regras, de todos os regimes.
          </div>
        )}
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

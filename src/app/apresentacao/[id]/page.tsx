import Link from "next/link";
import { notFound } from "next/navigation";
import { dadosApresentacao, type ItemApresentacao, type NivelApresentacao } from "@/server/apresentacao/dados";
import { ConfrontoDeclarado } from "@/components/ConfrontoDeclarado";
import { BotaoTelaCheia } from "@/components/apresentacao/BotaoTelaCheia";
import { cnpj, competencia, moeda } from "@/lib/formato";

export const dynamic = "force-dynamic";
export const metadata = { title: "Diagnóstico · Auditoria Azuos" };

/** Quantos apontamentos de cada nível aparecem abertos. O resto fica reservado. */
const ABERTOS = 5;

const REGIME: Record<string, string> = {
  SIMPLES_NACIONAL: "Simples Nacional",
  LUCRO_PRESUMIDO: "Lucro Presumido",
  LUCRO_REAL: "Lucro Real",
  LUCRO_ARBITRADO: "Lucro Arbitrado",
  MEI: "MEI",
};

const NIVEL: Record<NivelApresentacao, { titulo: string; subtitulo: string; cor: string; fundo: string }> = {
  GRAVE: {
    titulo: "Apontamentos graves",
    subtitulo: "Imposto não declarado ou não pago e erros que geram autuação",
    cor: "#b91c1c",
    fundo: "#fef2f2",
  },
  MEDIO: {
    titulo: "Apontamentos médios",
    subtitulo: "Inconsistências que o fisco cruza e que precisam de correção",
    cor: "#b45309",
    fundo: "#fffbeb",
  },
  BAIXO: {
    titulo: "Apontamentos baixos",
    subtitulo: "Falhas de forma e controle, de correção simples",
    cor: "#475569",
    fundo: "#f8fafc",
  },
  OPORTUNIDADE: {
    titulo: "Créditos e oportunidades",
    subtitulo: "Valores pagos ou declarados a maior que podem ser recuperados",
    cor: "#1d4ed8",
    fundo: "#eff6ff",
  },
};

function Kpi({ rotulo, valor, sub, cor }: { rotulo: string; valor: string; sub?: string; cor: string }) {
  return (
    <div className="rounded-xl bg-white p-5" style={{ borderLeft: `5px solid ${cor}`, boxShadow: "0 1px 3px rgba(0,0,0,.08)" }}>
      <div className="text-[12px] font-semibold uppercase tracking-wide text-content-muted">{rotulo}</div>
      <div className="mt-1 whitespace-nowrap font-extrabold leading-tight" style={{ color: cor, fontSize: "clamp(18px, 1.7vw, 25px)" }}>
        {valor}
      </div>
      {sub ? <div className="mt-1 text-[13px] text-content-muted">{sub}</div> : null}
    </div>
  );
}

function Cartao({ item, cor }: { item: ItemApresentacao; cor: string }) {
  return (
    <div className="flex flex-col rounded-xl bg-white p-4" style={{ borderTop: `4px solid ${cor}`, boxShadow: "0 1px 3px rgba(0,0,0,.08)" }}>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold">
        <span className="rounded-full px-2 py-0.5 text-white" style={{ background: item.area === "FISCAL" ? "var(--azuos-primary)" : "#0f766e" }}>
          {item.area === "FISCAL" ? "Fiscal" : "Contábil"}
        </span>
        {item.periodo ? <span className="text-content-muted">{item.periodo}</span> : null}
        {item.ocorrencias > 1 ? <span className="text-content-muted">· {item.ocorrencias} ocorrências</span> : null}
        {!item.provado ? <span className="text-content-muted">· a confirmar</span> : null}
      </div>
      <div className="text-[16px] font-bold leading-snug">{item.titulo}</div>
      <p className="mt-1.5 flex-1 text-[14px] leading-relaxed text-content-muted">{item.frase}</p>
      {item.valor.greaterThan(0) ? (
        <div className="mt-3 text-[20px] font-extrabold" style={{ color: cor }}>
          {moeda(item.valor)}
        </div>
      ) : null}
    </div>
  );
}

/** Cartões bloqueados: não levam o texto real, para não vazar pelo código da página. */
function Reservados({ quantidade, cor }: { quantidade: number; cor: string }) {
  if (quantidade <= 0) return null;
  const amostra = Math.min(quantidade, 3);
  return (
    <div className="relative mt-4 overflow-hidden rounded-xl">
      <div className="grid select-none gap-4 md:grid-cols-3" aria-hidden style={{ filter: "blur(5px)" }}>
        {Array.from({ length: amostra }).map((_, i) => (
          <div key={i} className="rounded-xl bg-white p-4" style={{ borderTop: `4px solid ${cor}` }}>
            <div className="mb-3 h-3 w-16 rounded bg-slate-200" />
            <div className="mb-2 h-4 w-4/5 rounded bg-slate-300" />
            <div className="mb-1.5 h-3 w-full rounded bg-slate-200" />
            <div className="mb-1.5 h-3 w-11/12 rounded bg-slate-200" />
            <div className="h-5 w-24 rounded" style={{ background: cor, opacity: 0.35 }} />
          </div>
        ))}
      </div>
      <div className="absolute inset-0 flex items-center justify-center bg-white/40">
        <div className="rounded-xl px-6 py-4 text-center text-white shadow-lg" style={{ background: "linear-gradient(135deg, var(--azuos-dark), var(--azuos-primary))" }}>
          <div className="text-[22px]">🔒</div>
          <div className="text-[16px] font-bold">+ {quantidade} apontamento(s) neste nível</div>
          <div className="text-[12px] text-white/75">Detalhados no relatório completo da auditoria</div>
        </div>
      </div>
    </div>
  );
}

export default async function ApresentacaoPage({ params }: { params: { id: string } }) {
  const d = await dadosApresentacao(params.id);
  if (!d) notFound();

  const regimes = [...new Map(d.regimes.map((r) => [r.regime, r])).values()]
    .map((r) => {
      const anos = d.regimes.filter((x) => x.regime === r.regime).map((x) => x.exercicio);
      return `${REGIME[r.regime] ?? r.regime} (${anos.join(", ")})`;
    })
    .join(" · ");

  const niveis: NivelApresentacao[] = ["GRAVE", "MEDIO", "BAIXO", "OPORTUNIDADE"];
  const totalNivel = (n: NivelApresentacao) => d.grupos[n].length;
  const erros = totalNivel("GRAVE") + totalNivel("MEDIO") + totalNivel("BAIXO");

  return (
    <div className="min-h-screen" style={{ background: "var(--bg)", fontSize: 14 }}>
      {/* Capa */}
      <header className="px-8 pb-10 pt-5 text-white" style={{ background: "linear-gradient(135deg, var(--azuos-dark), var(--azuos-primary))" }}>
        <div className="mx-auto flex max-w-6xl items-center justify-between">
          <div className="text-[13px] font-extrabold tracking-[2px]">
            AZUOS <span className="font-medium text-white/60">· Analyze Auditoria</span>
          </div>
          <div className="flex gap-2 print:hidden">
            <Link href="/apresentacao" className="rounded-md border border-white/25 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-white/10">
              ← Empresas
            </Link>
            <Link href={`/auditorias/${d.auditoria.id}`} className="rounded-md border border-white/25 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-white/10">
              Painel detalhado
            </Link>
            <BotaoTelaCheia />
          </div>
        </div>
        <div className="mx-auto mt-8 max-w-6xl">
          <div className="mb-2 h-1 w-16 rounded" style={{ background: "var(--azuos-gold)" }} />
          <div className="text-[13px] uppercase tracking-[1.5px] text-white/70">Diagnóstico fiscal e contábil</div>
          <h1 className="mt-1 text-[34px] font-extrabold leading-tight">{d.empresa.razaoSocial}</h1>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[14px] text-white/80">
            <span className="font-mono">{cnpj(d.empresa.cnpj)}</span>
            {d.empresa.uf ? <span>{d.empresa.municipio && !/^\d+$/.test(d.empresa.municipio) ? `${d.empresa.municipio} · ` : ""}{d.empresa.uf}</span> : null}
            {regimes ? <span>{regimes}</span> : null}
            <span>
              Período analisado: {competencia(d.auditoria.competenciaIni)} a {competencia(d.auditoria.competenciaFim)}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto -mt-6 max-w-6xl px-8 pb-16">
        {/* Resumo */}
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <Kpi rotulo="Apontamentos" valor={String(d.totais.apontamentos)} sub={`${d.totais.fiscal} fiscais · ${d.totais.contabil} contábeis`} cor="var(--azuos-primary)" />
          <Kpi rotulo="Débitos e riscos" valor={moeda(d.totais.debitos)} sub="imposto a pagar ou sujeito a autuação" cor="#b91c1c" />
          <Kpi rotulo="Créditos a recuperar" valor={moeda(d.totais.creditos)} sub={d.totais.creditosAConfirmar ? "declarados a maior · confirmar recolhimento" : "pagos ou declarados a maior"} cor="#1d4ed8" />
          <Kpi rotulo="Em confirmação" valor={moeda(d.totais.aConfirmar)} sub="depende de documento complementar" cor="#b45309" />
        </div>

        {/* Distribuição */}
        {erros > 0 ? (
          <div className="mt-6 rounded-xl bg-white p-5" style={{ boxShadow: "0 1px 3px rgba(0,0,0,.08)" }}>
            <div className="mb-2 flex flex-wrap justify-between gap-2 text-[13px] font-semibold">
              <span>Gravidade dos apontamentos</span>
              <span className="flex gap-4">
                {(["GRAVE", "MEDIO", "BAIXO"] as const).map((n) => (
                  <span key={n} style={{ color: NIVEL[n].cor }}>
                    ● {totalNivel(n)} {n === "GRAVE" ? "graves" : n === "MEDIO" ? "médios" : "baixos"}
                  </span>
                ))}
              </span>
            </div>
            <div className="flex h-4 overflow-hidden rounded-full bg-slate-100">
              {(["GRAVE", "MEDIO", "BAIXO"] as const).map((n) =>
                totalNivel(n) > 0 ? (
                  <div key={n} style={{ width: `${(totalNivel(n) / erros) * 100}%`, background: NIVEL[n].cor }} />
                ) : null,
              )}
            </div>
          </div>
        ) : null}

        {/* Apurado × declarado */}
        {d.confronto.linhas.length > 0 ? (
          <section className="mt-10">
            <h2 className="text-[22px] font-extrabold">Imposto apurado × declarado à Receita</h2>
            <p className="mb-4 mt-1 text-[14px] text-content-muted">
              Comparamos o imposto que a própria empresa calculou nas escriturações (ECF, EFD-Contribuições e EFD) com o que
              declarou à Receita Federal na DCTF.{" "}
              {d.confronto.naoDeclarado.greaterThan(0) ? (
                <strong style={{ color: "#b91c1c" }}>{moeda(d.confronto.naoDeclarado)} deixaram de ser declarados. </strong>
              ) : null}
              {d.confronto.declaradoAMaior.greaterThan(0) ? (
                <strong style={{ color: "#1d4ed8" }}>{moeda(d.confronto.declaradoAMaior)} foram declarados a maior. </strong>
              ) : null}
            </p>
            <ConfrontoDeclarado resumo={d.confronto} variante="apresentacao" />
          </section>
        ) : null}

        {/* Apontamentos */}
        {niveis.map((n) => {
          const lista = d.grupos[n];
          if (lista.length === 0) return null;
          const cfg = NIVEL[n];
          return (
            <section key={n} className="mt-10">
              <div className="mb-4 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <h2 className="text-[22px] font-extrabold" style={{ color: cfg.cor }}>
                    {cfg.titulo}
                  </h2>
                  <p className="text-[14px] text-content-muted">{cfg.subtitulo}</p>
                </div>
                <span className="rounded-full px-3 py-1 text-[13px] font-bold" style={{ color: cfg.cor, background: cfg.fundo }}>
                  {lista.length} no total
                </span>
              </div>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {lista.slice(0, ABERTOS).map((item) => (
                  <Cartao key={`${item.codigo}-${item.nivel}`} item={item} cor={cfg.cor} />
                ))}
              </div>
              <Reservados quantidade={lista.length - ABERTOS} cor={cfg.cor} />
            </section>
          );
        })}

        {erros === 0 && d.grupos.OPORTUNIDADE.length === 0 ? (
          <div className="mt-10 rounded-xl bg-white p-8 text-center text-[16px]" style={{ boxShadow: "0 1px 3px rgba(0,0,0,.08)" }}>
            Nenhum apontamento com os documentos analisados.
          </div>
        ) : null}

        <footer className="mt-12 rounded-xl p-6 text-white" style={{ background: "linear-gradient(135deg, var(--azuos-dark), var(--azuos-primary))" }}>
          <div className="text-[18px] font-bold">O relatório completo mostra cada apontamento em detalhe</div>
          <p className="mt-1 text-[14px] text-white/80">
            Nota por nota, registro por registro, com o valor, a base legal e o caminho da correção — e o que ainda não pôde
            ser analisado por falta de documento.
          </p>
          <div className="mt-4 text-[12px] text-white/60">
            Analyze Auditoria e Consultoria Tributária · Grupo Azuos
            {d.auditoria.executadaEm ? ` · análise de ${d.auditoria.executadaEm.toLocaleDateString("pt-BR")}` : ""}
          </div>
        </footer>
      </main>
    </div>
  );
}

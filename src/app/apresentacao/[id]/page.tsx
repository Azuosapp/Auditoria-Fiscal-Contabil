import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";
import { dadosApresentacao, type ItemApresentacao, type NivelApresentacao } from "@/server/apresentacao/dados";
import { ConfrontoDeclarado } from "@/components/ConfrontoDeclarado";
import { BotaoTelaCheia } from "@/components/apresentacao/BotaoTelaCheia";
import { cnpj, competencia, moeda } from "@/lib/formato";
import { usuarioDaSessao } from "@/server/auth/sessao";

export const dynamic = "force-dynamic";
export const metadata = { title: "Diagnóstico · Auditoria Azuos" };

/** Quantos apontamentos de cada nível aparecem abertos. O resto fica reservado. */
const ABERTOS = 5;

/**
 * Uma grade só para a página inteira: capa, números e seções começam na mesma
 * margem esquerda. Qualquer bloco novo usa este container.
 */
const CONTAINER = "mx-auto w-full max-w-[1180px] px-6 lg:px-10";

const SOMBRA = "0 2px 12px rgba(27, 58, 140, 0.08)";

const REGIME: Record<string, string> = {
  SIMPLES_NACIONAL: "Simples Nacional",
  LUCRO_PRESUMIDO: "Lucro Presumido",
  LUCRO_REAL: "Lucro Real",
  LUCRO_ARBITRADO: "Lucro Arbitrado",
  MEI: "MEI",
};

const NIVEL: Record<NivelApresentacao, { titulo: string; plural: string; subtitulo: string; cor: string; fundo: string }> = {
  GRAVE: {
    titulo: "Apontamentos graves",
    plural: "graves",
    subtitulo: "Imposto não declarado ou não pago e erros que levam a autuação.",
    cor: "#b91c1c",
    fundo: "#fef2f2",
  },
  MEDIO: {
    titulo: "Apontamentos médios",
    plural: "médios",
    subtitulo: "Inconsistências que o fisco cruza e que precisam de correção.",
    cor: "#b45309",
    fundo: "#fffbeb",
  },
  BAIXO: {
    titulo: "Apontamentos baixos",
    plural: "baixos",
    subtitulo: "Falhas de forma e de controle, de correção simples.",
    cor: "#475569",
    fundo: "#f1f5f9",
  },
  OPORTUNIDADE: {
    titulo: "Créditos e oportunidades",
    plural: "oportunidades",
    subtitulo: "Valores pagos ou declarados a maior que podem ser recuperados.",
    cor: "#1d4ed8",
    fundo: "#eff6ff",
  },
};

// ---------------------------------------------------------------------------

function CabecalhoSecao({
  numero,
  rotulo,
  titulo,
  descricao,
  lado,
}: {
  numero: string;
  rotulo: string;
  titulo: string;
  descricao?: React.ReactNode;
  lado?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 max-w-3xl">
        <div className="flex items-center gap-2 text-[12px] font-bold uppercase tracking-[1.5px] text-azuos">
          <span className="grid h-7 w-7 place-items-center rounded-full bg-azuos text-[12px] tabular-nums text-white">{numero}</span>
          {rotulo}
        </div>
        <h2 className="mt-2 text-[26px] font-extrabold leading-tight text-content">{titulo}</h2>
        {descricao ? <p className="mt-1.5 text-[15px] leading-relaxed text-content-muted">{descricao}</p> : null}
      </div>
      {lado ? <div className="shrink-0">{lado}</div> : null}
    </div>
  );
}

function Numero({
  rotulo,
  valor,
  nota,
  cor,
  apagado,
}: {
  rotulo: string;
  valor: string;
  nota: string;
  cor: string;
  apagado?: boolean;
}) {
  return (
    <div
      className="relative flex flex-col overflow-hidden rounded-2xl bg-white px-6 pb-5 pt-6"
      style={{ boxShadow: SOMBRA, containerType: "inline-size" }}
    >
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: apagado ? "#cbd5e1" : cor }} />
      <div className="text-[12px] font-bold uppercase tracking-[1px] text-content-muted">{rotulo}</div>
      {/* Tamanho pelo próprio cartão (cqi), não pela janela: o valor nunca sai do cartão. */}
      <div
        className="mt-2 whitespace-nowrap font-extrabold leading-none tabular-nums"
        style={{ color: apagado ? "#94a3b8" : cor, fontSize: "clamp(20px, 10.5cqi, 34px)" }}
      >
        {valor}
      </div>
      <div className="mt-3 text-[13px] leading-snug text-content-muted">{nota}</div>
    </div>
  );
}

function Cartao({ item, cor }: { item: ItemApresentacao; cor: string }) {
  return (
    <article className="relative flex h-full flex-col overflow-hidden rounded-2xl bg-white p-5 pt-6" style={{ boxShadow: SOMBRA }}>
      <span className="absolute inset-x-0 top-0 h-1" style={{ background: cor }} />
      <div className="flex flex-wrap items-center gap-2 text-[11px] font-semibold">
        <span
          className="rounded-full px-2.5 py-0.5 text-white"
          style={{ background: item.area === "FISCAL" ? "var(--azuos-blue)" : "#0f766e" }}
        >
          {item.area === "FISCAL" ? "Fiscal" : "Contábil"}
        </span>
        {item.periodo ? <span className="text-content-muted">{item.periodo}</span> : null}
      </div>
      <h3 className="mt-3 line-clamp-2 min-h-[2.6em] text-[17px] font-bold leading-[1.3] text-content">{item.titulo}</h3>
      <div className="mt-2 flex-1">
        <p className="line-clamp-4 text-[14px] leading-relaxed text-content-muted">{item.frase}</p>
      </div>
      <div className="mt-4 flex items-end justify-between gap-3 border-t border-surface-border pt-3">
        {item.valor.greaterThan(0) ? (
          <div className="whitespace-nowrap text-[20px] font-extrabold leading-none tabular-nums" style={{ color: cor }}>
            {moeda(item.valor)}
          </div>
        ) : (
          <div className="text-[13px] font-medium text-slate-400">Sem valor em reais</div>
        )}
        <div className="flex shrink-0 flex-col items-end gap-1 text-[11px] font-semibold">
          {item.ocorrencias > 1 ? <span className="text-content-muted">{item.ocorrencias} ocorrências</span> : null}
          {!item.provado ? (
            <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-700">a confirmar</span>
          ) : null}
        </div>
      </div>
    </article>
  );
}

/** Cartões bloqueados: não levam o texto real, para não vazar pelo código da página. */
function Reservados({ quantidade, cor, href }: { quantidade: number; cor: string; href: string }) {
  if (quantidade <= 0) return null;
  return (
    <Link href={href} className="group relative mt-5 block overflow-hidden rounded-2xl" aria-label={`Ver os outros ${quantidade} apontamentos`}>
      <div className="grid select-none gap-5 sm:grid-cols-2 lg:grid-cols-3" aria-hidden style={{ filter: "blur(6px)" }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="relative overflow-hidden rounded-2xl bg-white p-5 pt-6" style={{ boxShadow: SOMBRA }}>
            <span className="absolute inset-x-0 top-0 h-1" style={{ background: cor }} />
            <div className="mb-4 h-4 w-20 rounded-full bg-slate-200" />
            <div className="mb-2 h-5 w-4/5 rounded bg-slate-300" />
            <div className="mb-2 h-3.5 w-full rounded bg-slate-200" />
            <div className="mb-2 h-3.5 w-11/12 rounded bg-slate-200" />
            <div className="mb-5 h-3.5 w-3/5 rounded bg-slate-200" />
            <div className="h-6 w-28 rounded" style={{ background: cor, opacity: 0.3 }} />
          </div>
        ))}
      </div>
      <div className="absolute inset-0 grid place-items-center bg-white/35 p-4">
        <div
          className="flex items-center gap-4 rounded-2xl px-6 py-4 text-white transition group-hover:-translate-y-0.5"
          style={{ background: "var(--azuos-hero)", boxShadow: "var(--shadow-lg)" }}
        >
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-white/15 text-[20px]">🔒</span>
          <div>
            <div className="text-[17px] font-bold leading-tight">
              + {quantidade} {quantidade === 1 ? "apontamento" : "apontamentos"} neste nível
            </div>
            <div className="mt-0.5 text-[13px] text-white/75">Detalhados no relatório completo da auditoria</div>
          </div>
          <span
            className="ml-2 whitespace-nowrap rounded-xl px-3 py-2 text-[13px] font-bold"
            style={{ background: "var(--azuos-yellow-gradient)", color: "var(--azuos-blue-darkest)" }}
          >
            Ver apontamentos →
          </span>
        </div>
      </div>
    </Link>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-3 py-1 text-[13px] text-white/90">
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------

export default async function ApresentacaoPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { visao?: string };
}) {
  const [d, usuario] = await Promise.all([dadosApresentacao(params.id), usuarioDaSessao()]);
  if (!d) notFound();

  // Visão completa só com login. Logado, o auditor pode voltar à visão do
  // cliente (?visao=cliente) para apresentar sem expor o restante.
  const completo = !!usuario && searchParams.visao !== "cliente";
  const aqui = `/apresentacao/${d.auditoria.id}`;
  const destinoBloqueio = usuario ? aqui : `/entrar?voltar=${encodeURIComponent(aqui)}`;

  const regimes = [...new Set(d.regimes.map((r) => r.regime))].map((regime) => {
    const anos = d.regimes.filter((x) => x.regime === regime).map((x) => x.exercicio);
    return `${REGIME[regime] ?? regime} (${anos.join(", ")})`;
  });

  const totalNivel = (n: NivelApresentacao) => d.grupos[n].length;
  const erros = totalNivel("GRAVE") + totalNivel("MEDIO") + totalNivel("BAIXO");
  const temConfronto = d.confronto.linhas.length > 0;
  const niveis = (["GRAVE", "MEDIO", "BAIXO", "OPORTUNIDADE"] as const).filter((n) => totalNivel(n) > 0);
  const numero = (i: number) => String(i).padStart(2, "0");
  let secao = 1;

  const local = d.empresa.municipio && !/^\d+$/.test(d.empresa.municipio) ? `${d.empresa.municipio} · ${d.empresa.uf}` : d.empresa.uf;

  return (
    <div className="min-h-screen pb-20" style={{ background: "var(--bg)", fontSize: 14 }}>
      {/* ------------------------------------------------------------ Capa */}
      <header className="pb-24 pt-6 text-white" style={{ background: "var(--azuos-hero)" }}>
        <div className={`${CONTAINER} flex items-center justify-between gap-4`}>
          <div className="flex items-center">
            {/* O PNG tem margem interna (≈7% à esquerda, 23% em cima e embaixo): compensada para alinhar as letras à grade. */}
            <Image src="/brand/azuos-branco.png" alt="Grupo Azuos" width={5957} height={2678} priority className="-my-[18px] -ml-[13px] h-20 w-auto" />
            <span className="ml-4 border-l border-white/25 pl-4 text-[12px] font-semibold uppercase tracking-[1.5px] text-white/70">
              Analyze Auditoria
            </span>
          </div>
          {/* Na visão do cliente não há atalho para o painel: ele mostra tudo sem senha. */}
          <nav className="flex flex-wrap items-center justify-end gap-2 print:hidden">
            {completo ? (
              <>
                <span className="mr-1 rounded-full px-3 py-1 text-[12px] font-bold" style={{ background: "var(--azuos-yellow)", color: "var(--azuos-blue-darkest)" }}>
                  Visão completa · {usuario!.nome.split(" ")[0]}
                </span>
                <Link href="/apresentacao" className="rounded-lg border border-white/20 px-3 py-1.5 text-[12px] font-semibold text-white/90 hover:bg-white/10">
                  ← Empresas
                </Link>
                <Link href={`/auditorias/${d.auditoria.id}`} className="rounded-lg border border-white/20 px-3 py-1.5 text-[12px] font-semibold text-white/90 hover:bg-white/10">
                  Painel detalhado
                </Link>
                <Link href={`${aqui}?visao=cliente`} className="rounded-lg border border-white/20 px-3 py-1.5 text-[12px] font-semibold text-white/90 hover:bg-white/10">
                  Visão do cliente
                </Link>
              </>
            ) : usuario ? (
              <Link href={aqui} className="rounded-lg border border-white/20 px-3 py-1.5 text-[12px] font-semibold text-white/90 hover:bg-white/10">
                Visão completa
              </Link>
            ) : null}
            <BotaoTelaCheia />
            {usuario ? (
              <form method="post" action="/api/sair">
                <input type="hidden" name="voltar" value={aqui} />
                <button type="submit" className="rounded-lg border border-white/20 px-3 py-1.5 text-[12px] font-semibold text-white/90 hover:bg-white/10">
                  Sair
                </button>
              </form>
            ) : null}
          </nav>
        </div>

        <div className={`${CONTAINER} mt-12 flex flex-wrap items-end justify-between gap-x-10 gap-y-6`}>
          <div className="min-w-0">
            <div className="flex items-center gap-3 text-[13px] font-semibold uppercase tracking-[2px] text-white/75">
              <span className="h-1 w-10 rounded-full" style={{ background: "var(--azuos-yellow)" }} />
              Diagnóstico fiscal e contábil
            </div>
            <h1 className="mt-3 text-[40px] font-extrabold leading-[1.1] tracking-[-0.5px]">{d.empresa.razaoSocial}</h1>
            <div className="mt-5 flex flex-wrap gap-2">
              <Chip>
                <span className="text-white/60">CNPJ</span>
                <span className="tabular-nums">{cnpj(d.empresa.cnpj)}</span>
              </Chip>
              {local ? <Chip>{local}</Chip> : null}
              {regimes.map((r) => (
                <Chip key={r}>{r}</Chip>
              ))}
            </div>
          </div>
          <dl className="grid shrink-0 grid-cols-2 gap-x-8 gap-y-1 text-[13px]">
            <dt className="text-white/60">Período analisado</dt>
            <dt className="text-white/60">Data da análise</dt>
            <dd className="text-[16px] font-bold tabular-nums">
              {competencia(d.auditoria.competenciaIni)} a {competencia(d.auditoria.competenciaFim)}
            </dd>
            <dd className="text-[16px] font-bold tabular-nums">
              {d.auditoria.executadaEm ? d.auditoria.executadaEm.toLocaleDateString("pt-BR") : "—"}
            </dd>
          </dl>
        </div>
      </header>

      <main className={`${CONTAINER} -mt-14`}>
        {/* ------------------------------------------------------------ Números */}
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Numero
            rotulo="Apontamentos"
            valor={String(d.totais.apontamentos)}
            nota={`${d.totais.fiscal} fiscais · ${d.totais.contabil} contábeis`}
            cor="var(--azuos-blue)"
          />
          <Numero
            rotulo="Débitos e riscos"
            valor={moeda(d.totais.debitos)}
            nota={d.totais.debitos.greaterThan(0) ? "imposto a pagar ou sujeito a autuação" : "nenhum débito confirmado até aqui"}
            cor="#b91c1c"
            apagado={!d.totais.debitos.greaterThan(0)}
          />
          <Numero
            rotulo="Créditos a recuperar"
            valor={moeda(d.totais.creditos)}
            nota={
              !d.totais.creditos.greaterThan(0)
                ? "nenhum crédito identificado"
                : d.totais.creditosAConfirmar
                  ? "declarados a maior · confirmar o recolhimento"
                  : "pagos ou declarados a maior"
            }
            cor="#1d4ed8"
            apagado={!d.totais.creditos.greaterThan(0)}
          />
          <Numero
            rotulo="Valores em análise"
            valor={moeda(d.totais.aConfirmar)}
            nota="dependem de documento complementar para virar débito ou crédito"
            cor="#b45309"
            apagado={!d.totais.aConfirmar.greaterThan(0)}
          />
        </div>

        {/* ------------------------------------------------------------ Gravidade */}
        {erros > 0 ? (
          <div className="mt-5 rounded-2xl bg-white px-6 py-5" style={{ boxShadow: SOMBRA }}>
            <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-4">
              <div className="text-[15px] font-bold text-content">Gravidade dos {erros} apontamentos</div>
              <div className="flex flex-wrap gap-x-8 gap-y-2">
                {(["GRAVE", "MEDIO", "BAIXO"] as const).map((n) => (
                  <div key={n} className="flex items-baseline gap-2">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ background: NIVEL[n].cor }} />
                    <span className="text-[22px] font-extrabold leading-none tabular-nums" style={{ color: NIVEL[n].cor }}>
                      {totalNivel(n)}
                    </span>
                    <span className="text-[13px] font-semibold text-content-muted">{NIVEL[n].plural}</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="mt-4 flex h-3 gap-0.5 overflow-hidden rounded-full bg-slate-100">
              {(["GRAVE", "MEDIO", "BAIXO"] as const).map((n) =>
                totalNivel(n) > 0 ? (
                  <div key={n} style={{ width: `${(totalNivel(n) / erros) * 100}%`, background: NIVEL[n].cor }} />
                ) : null,
              )}
            </div>
          </div>
        ) : null}

        {/* ------------------------------------------------------------ Apurado × declarado */}
        {temConfronto ? (
          <section className="mt-16">
            <CabecalhoSecao
              numero={numero(secao++)}
              rotulo="Tributos federais"
              titulo="Imposto apurado × declarado à Receita"
              descricao="Comparamos o imposto que a própria empresa calculou nas escriturações (ECF, EFD-Contribuições e EFD ICMS/IPI) com o que declarou à Receita Federal na DCTF."
              lado={
                <div className="flex flex-wrap gap-3">
                  {d.confronto.naoDeclarado.greaterThan(0) ? (
                    <div className="rounded-2xl bg-white px-5 py-3" style={{ boxShadow: SOMBRA }}>
                      <div className="text-[11px] font-bold uppercase tracking-[1px] text-content-muted">Não declarado</div>
                      <div className="text-[22px] font-extrabold tabular-nums" style={{ color: "#b91c1c" }}>
                        {moeda(d.confronto.naoDeclarado)}
                      </div>
                    </div>
                  ) : null}
                  {d.confronto.declaradoAMaior.greaterThan(0) ? (
                    <div className="rounded-2xl bg-white px-5 py-3" style={{ boxShadow: SOMBRA }}>
                      <div className="text-[11px] font-bold uppercase tracking-[1px] text-content-muted">Declarado a maior</div>
                      <div className="text-[22px] font-extrabold tabular-nums" style={{ color: "#1d4ed8" }}>
                        {moeda(d.confronto.declaradoAMaior)}
                      </div>
                    </div>
                  ) : null}
                </div>
              }
            />
            <ConfrontoDeclarado resumo={d.confronto} variante="apresentacao" />
          </section>
        ) : null}

        {/* ------------------------------------------------------------ Apontamentos */}
        {niveis.map((n) => {
          const lista = d.grupos[n];
          const cfg = NIVEL[n];
          return (
            <section key={n} className="mt-16">
              <CabecalhoSecao
                numero={numero(secao++)}
                rotulo={n === "OPORTUNIDADE" ? "Recuperação" : "Apontamentos"}
                titulo={cfg.titulo}
                descricao={cfg.subtitulo}
                lado={
                  <span className="inline-flex items-baseline gap-1.5 rounded-full px-4 py-1.5" style={{ color: cfg.cor, background: cfg.fundo }}>
                    <span className="text-[18px] font-extrabold tabular-nums">{lista.length}</span>
                    <span className="text-[13px] font-semibold">
                      {lista.length === 1 ? "apontamento" : "apontamentos"}
                      {!completo && lista.length > ABERTOS ? ` · ${ABERTOS} em destaque` : ""}
                    </span>
                  </span>
                }
              />
              <div className="grid auto-rows-fr gap-5 sm:grid-cols-2 lg:grid-cols-3">
                {lista.slice(0, completo ? lista.length : ABERTOS).map((item) => (
                  <Cartao key={`${item.codigo}-${item.nivel}`} item={item} cor={cfg.cor} />
                ))}
              </div>
              {completo ? null : <Reservados quantidade={lista.length - ABERTOS} cor={cfg.cor} href={destinoBloqueio} />}
            </section>
          );
        })}

        {erros === 0 && totalNivel("OPORTUNIDADE") === 0 ? (
          <div className="mt-16 rounded-2xl bg-white p-10 text-center text-[16px] text-content-muted" style={{ boxShadow: SOMBRA }}>
            Nenhum apontamento com os documentos analisados.
          </div>
        ) : null}

        {/* ------------------------------------------------------------ Fechamento */}
        <footer className="mt-16 overflow-hidden rounded-2xl text-white" style={{ background: "var(--azuos-hero)", boxShadow: "var(--shadow-lg)" }}>
          <div className="flex flex-wrap items-center justify-between gap-6 px-8 py-8">
            <div className="max-w-2xl">
              <div className="h-1 w-10 rounded-full" style={{ background: "var(--azuos-yellow)" }} />
              <div className="mt-3 text-[22px] font-extrabold leading-tight">O relatório completo mostra cada apontamento em detalhe</div>
              <p className="mt-2 text-[15px] leading-relaxed text-white/80">
                Nota por nota, registro por registro, com o valor, a base legal e o caminho da correção — e o que ainda não
                pôde ser analisado por falta de documento.
              </p>
            </div>
            <Image src="/brand/azuos-branco.png" alt="Grupo Azuos" width={5957} height={2678} className="-my-4 h-24 w-auto opacity-95" />
          </div>
          <div className="border-t border-white/10 px-8 py-3 text-[12px] text-white/60">
            Analyze Auditoria e Consultoria Tributária · Grupo Azuos
          </div>
        </footer>
      </main>
    </div>
  );
}

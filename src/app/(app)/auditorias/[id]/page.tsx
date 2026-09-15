import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { BotaoProcessar } from "@/components/BotaoProcessar";
import { cnpj as fmtCnpj, competencia as fmtComp, moeda } from "@/lib/formato";

export const dynamic = "force-dynamic";

const ROTULO_TIPO: Record<string, string> = {
  NFE_XML: "XML de NF-e",
  NFCE_XML: "XML de NFC-e",
  NFSE_XML: "XML de NFS-e",
  EVENTO_NFE: "Evento de NF-e",
  SPED_FISCAL: "SPED Fiscal",
  SPED_CONTRIBUICOES: "EFD-Contribuições",
  ECD: "ECD",
  ECF: "ECF",
  DCTF: "DCTF",
  DCTFWEB: "DCTFWeb",
  SITUACAO_FISCAL: "Situação Fiscal",
  PGDAS: "PGDAS-D",
  COMPROVANTE_ARRECADACAO: "Arrecadação",
  ESOCIAL: "eSocial",
  EFD_REINF: "EFD-Reinf",
  CARTAO_CNPJ: "Cartão CNPJ",
  CONTRATO_SOCIAL: "Contrato social",
  PLANILHA: "Planilha",
  DESCONHECIDO: "Não reconhecido",
};

const ROTULO_REGIME: Record<string, string> = {
  SIMPLES_NACIONAL: "Simples Nacional",
  LUCRO_PRESUMIDO: "Lucro Presumido",
  LUCRO_REAL: "Lucro Real",
  MEI: "MEI",
  IMUNE_ISENTA: "Imune / Isenta",
  ARBITRADO: "Arbitrado",
};

const ROTULO_STATUS: Record<string, string> = {
  PENDENTE: "Aguardando",
  PROCESSANDO: "Processando",
  CONCLUIDO: "Concluído",
  ERRO: "Erro",
  IGNORADO: "Sem parser",
};

export default async function AuditoriaPage({
  params,
}: {
  params: { id: string };
}) {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: params.id },
    include: {
      empresa: { include: { regimes: { orderBy: { exercicio: "asc" } } } },
      _count: { select: { documentos: true, achados: true } },
    },
  });

  if (!auditoria) notFound();

  const onde = { documento: { auditoriaId: auditoria.id } };

  const [
    porTipo,
    porStatus,
    apuracoesIcms,
    apuracoesContrib,
    apuracoesSimples,
    totaisNotas,
    naoEscrituradas,
  ] = await Promise.all([
    prisma.documento.groupBy({
      by: ["tipo"],
      where: { auditoriaId: auditoria.id },
      _count: { _all: true },
    }),
    prisma.documento.groupBy({
      by: ["status"],
      where: { auditoriaId: auditoria.id },
      _count: { _all: true },
    }),
    prisma.apuracaoFiscal.findMany({
      where: onde,
      orderBy: { competencia: "asc" },
      take: 80,
    }),
    prisma.apuracaoContribuicoes.findMany({
      where: onde,
      orderBy: [{ competencia: "asc" }, { contribuicao: "asc" }],
      take: 120,
    }),
    prisma.apuracaoSimples.findMany({
      where: onde,
      orderBy: { competencia: "asc" },
      take: 80,
    }),
    prisma.notaFiscal.groupBy({
      by: ["origem", "direcao", "situacao"],
      where: onde,
      _count: { _all: true },
      _sum: { valorTotal: true },
    }),
    // A contagem que vira o achado B01: XML autorizado, não cancelado, que o
    // SPED Fiscal não escriturou.
    prisma.notaFiscal.count({
      where: {
        ...onde,
        origem: "XML_AUTORIZADO",
        situacao: "AUTORIZADA",
        escriturada: false,
      },
    }),
  ]);

  const pendentes =
    porStatus.find((s) => s.status === "PENDENTE")?._count._all ?? 0;
  const totalNotas = totaisNotas.reduce((s, t) => s + t._count._all, 0);

  const temSpedFiscal = porTipo.some((t) => t.tipo === "SPED_FISCAL");

  return (
    <>
      <div className="mb-4 flex items-end justify-between">
        <div>
          <h1 className="text-[15px] font-bold">{auditoria.empresa.razaoSocial}</h1>
          <p className="mt-0.5 text-[11px] text-content-muted">
            <span className="font-mono">{fmtCnpj(auditoria.empresa.cnpj)}</span>
            {auditoria.empresa.uf ? ` · ${auditoria.empresa.uf}` : ""} ·{" "}
            {fmtComp(auditoria.competenciaIni)} a {fmtComp(auditoria.competenciaFim)}
          </p>
        </div>
        <Link href="/importar" className="btn-ghost">
          Importar mais arquivos
        </Link>
      </div>

      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Documentos</div>
          <div className="kpi-val">{auditoria._count.documentos}</div>
          <div className="kpi-sub">
            {pendentes > 0 ? `${pendentes} aguardando` : "todos processados"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Notas extraídas</div>
          <div className="kpi-val">{totalNotas}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Apurações lidas</div>
          <div className="kpi-val">
            {apuracoesIcms.length + apuracoesContrib.length + apuracoesSimples.length}
          </div>
          <div className="kpi-sub">ICMS · PIS/COFINS · Simples</div>
        </div>
        <div
          className="kpi"
          style={{ borderLeftColor: naoEscrituradas > 0 ? "var(--danger)" : undefined }}
        >
          <div className="kpi-label">XML não escriturado</div>
          <div className="kpi-val">{temSpedFiscal ? naoEscrituradas : "—"}</div>
          <div className="kpi-sub">
            {temSpedFiscal ? "possível omissão" : "exige SPED Fiscal"}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Achados</div>
          <div className="kpi-val">{auditoria._count.achados}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Situação</div>
          <div className="kpi-val text-[15px]">{auditoria.status}</div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="mb-2 text-[11px] font-bold">Extração</div>
        <BotaoProcessar auditoriaId={auditoria.id} pendentes={pendentes} />
      </div>

      <div className="mb-3 grid gap-3 md:grid-cols-3">
        <div className="card">
          <div className="mb-2 text-[11px] font-bold">Documentos por tipo</div>
          <table className="tbl">
            <tbody>
              {porTipo.map((t) => (
                <tr key={t.tipo}>
                  <td>{ROTULO_TIPO[t.tipo] ?? t.tipo}</td>
                  <td className="num w-16 font-semibold">{t._count._all}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="mb-2 text-[11px] font-bold">Situação da extração</div>
          <table className="tbl">
            <tbody>
              {porStatus.map((s) => (
                <tr key={s.status}>
                  <td>{ROTULO_STATUS[s.status] ?? s.status}</td>
                  <td className="num w-16 font-semibold">{s._count._all}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="mb-2 text-[11px] font-bold">Regime por exercício</div>
          {auditoria.empresa.regimes.length === 0 ? (
            <p className="text-[10px] text-content-muted">
              Regime não informado. É ele que define qual motor de regras se
              aplica a cada ano.
            </p>
          ) : (
            <table className="tbl">
              <tbody>
                {auditoria.empresa.regimes.map((r) => (
                  <tr key={r.id}>
                    <td className="w-14 font-mono font-semibold">{r.exercicio}</td>
                    <td>{ROTULO_REGIME[r.regime] ?? r.regime}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {totaisNotas.length > 0 ? (
        <div className="card mb-3">
          <div className="mb-1 text-[11px] font-bold">Notas fiscais extraídas</div>
          <p className="mb-2 text-[10px] text-content-muted">
            <strong>XML autorizado</strong> é o que a empresa realmente emitiu ou
            recebeu. <strong>Escrituração</strong> é o que a contabilidade lançou
            no SPED. A diferença entre os dois é o que vira achado.
          </p>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Origem</th>
                  <th className="w-24">Direção</th>
                  <th className="w-28">Situação</th>
                  <th className="w-20">Qtde</th>
                  <th className="w-36">Valor total</th>
                </tr>
              </thead>
              <tbody>
                {totaisNotas.map((t, i) => (
                  <tr key={i}>
                    <td>
                      {t.origem === "XML_AUTORIZADO"
                        ? "XML autorizado"
                        : "Escrituração (SPED)"}
                    </td>
                    <td>{t.direcao}</td>
                    <td>{t.situacao}</td>
                    <td className="num">{t._count._all}</td>
                    <td className="num">{moeda(t._sum.valorTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {apuracoesIcms.length > 0 ? (
        <div className="card mb-3">
          <div className="mb-2 text-[11px] font-bold">
            Apuração do ICMS — registro E110 do SPED Fiscal
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-24">Competência</th>
                  <th>Débitos</th>
                  <th>Créditos</th>
                  <th>Saldo credor anterior</th>
                  <th>Deduções</th>
                  <th>ICMS a recolher</th>
                  <th>Saldo a transportar</th>
                </tr>
              </thead>
              <tbody>
                {apuracoesIcms.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono">{fmtComp(a.competencia)}</td>
                    <td className="num">{moeda(a.debitos)}</td>
                    <td className="num">{moeda(a.creditos)}</td>
                    <td className="num">{moeda(a.saldoCredorAnterior)}</td>
                    <td className="num">{moeda(a.deducoes)}</td>
                    <td className="num font-semibold">{moeda(a.icmsARecolher)}</td>
                    <td className="num">{moeda(a.saldoCredorTransportar)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-1.5 text-[10px] text-content-muted">
            A coluna <strong>ICMS a recolher</strong> é a que será confrontada com
            os comprovantes de arrecadação — o achado A01.
          </p>
        </div>
      ) : null}

      {apuracoesContrib.length > 0 ? (
        <div className="card mb-3">
          <div className="mb-2 text-[11px] font-bold">
            Apuração de PIS e COFINS — registros M200 e M600
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-24">Competência</th>
                  <th className="w-20">Tributo</th>
                  <th>Base de cálculo</th>
                  <th>Apurado</th>
                  <th>Créditos</th>
                  <th>Retenções</th>
                  <th>A recolher</th>
                </tr>
              </thead>
              <tbody>
                {apuracoesContrib.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono">{fmtComp(a.competencia)}</td>
                    <td>{a.contribuicao}</td>
                    <td className="num">{moeda(a.baseCalculo)}</td>
                    <td className="num">{moeda(a.valorApurado)}</td>
                    <td className="num">{moeda(a.creditos)}</td>
                    <td className="num">{moeda(a.retencoes)}</td>
                    <td className="num font-semibold">{moeda(a.aRecolher)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {apuracoesSimples.length > 0 ? (
        <div className="card mb-3">
          <div className="mb-2 text-[11px] font-bold">
            Apuração do Simples Nacional — PGDAS-D
          </div>
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th className="w-24">Competência</th>
                  <th>Receita do período</th>
                  <th>RBT12</th>
                  <th>Fator R</th>
                  <th>DAS</th>
                </tr>
              </thead>
              <tbody>
                {apuracoesSimples.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono">{fmtComp(a.competencia)}</td>
                    <td className="num">{moeda(a.receitaBruta)}</td>
                    <td className="num">{moeda(a.rbt12)}</td>
                    <td className="num">{a.fatorR ? String(a.fatorR) : "—"}</td>
                    <td className="num font-semibold">{moeda(a.valorDas)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card">
        <div className="text-[11px] font-bold">Próxima etapa</div>
        <p className="mt-1 text-[10px] text-content-muted">
          Com as apurações extraídas, falta o outro lado do cruzamento: o que foi{" "}
          <strong>confessado</strong> (DCTF) e o que foi <strong>pago</strong>{" "}
          (DARF, DAS, DARE). Sem esses dois parsers, a família A do catálogo — os
          oito achados críticos — não tem como se provar. Ver
          docs/CONTINUAR_AQUI.md.
        </p>
      </div>
    </>
  );
}

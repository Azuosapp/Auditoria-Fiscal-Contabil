import { Prisma } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { BotaoImprimir } from "@/components/BotaoImprimir";
import { cnpj as fmtCnpj, competencia as fmtComp, moeda } from "@/lib/formato";

export const dynamic = "force-dynamic";
export const metadata = { title: "Relatório · Auditoria Azuos" };

const ORDEM_SEVERIDADE = ["CRITICO", "ALTO", "MEDIO", "BAIXO", "OPORTUNIDADE"];

const COR_SEV: Record<string, { fundo: string; texto: string }> = {
  CRITICO: { fundo: "#fee2e2", texto: "#b91c1c" },
  ALTO: { fundo: "#fef3c7", texto: "#92400e" },
  MEDIO: { fundo: "#cffafe", texto: "#155e75" },
  BAIXO: { fundo: "#f1f5f9", texto: "#64748b" },
  OPORTUNIDADE: { fundo: "#dcfce7", texto: "#166534" },
};

const ROTULO_NIVEL: Record<string, string> = {
  DIAGNOSTICO_RAPIDO: "Diagnóstico rápido",
  FISCAL: "Auditoria fiscal",
  COMPLETA: "Auditoria fiscal e contábil",
};

const ROTULO_REGIME: Record<string, string> = {
  SIMPLES_NACIONAL: "Simples Nacional",
  LUCRO_PRESUMIDO: "Lucro Presumido",
  LUCRO_REAL: "Lucro Real",
  MEI: "MEI",
  IMUNE_ISENTA: "Imune / Isenta",
  ARBITRADO: "Arbitrado",
};

/**
 * Nome do documento como o cliente o conhece.
 *
 * O pacote .zip de XMLs fica registrado como DESCONHECIDO porque o tipo real
 * está em cada arquivo de dentro — o que é correto no banco, mas ilegível num
 * relatório entregue ao cliente.
 */
const NOME_TIPO: Record<string, string> = {
  NFE_XML: "XML de NF-e",
  NFCE_XML: "XML de NFC-e",
  NFSE_XML: "XML de NFS-e",
  EVENTO_NFE: "Eventos de NF-e",
  SPED_FISCAL: "SPED Fiscal (EFD ICMS/IPI)",
  SPED_CONTRIBUICOES: "SPED EFD-Contribuições",
  ECD: "ECD — Escrituração Contábil Digital",
  ECF: "ECF — Escrituração Contábil Fiscal",
  DCTF: "DCTF",
  DCTFWEB: "DCTFWeb",
  SITUACAO_FISCAL: "Relatório de Situação Fiscal",
  PGDAS: "Extrato do PGDAS-D",
  COMPROVANTE_ARRECADACAO: "Comprovantes de arrecadação",
  ESOCIAL: "eSocial",
  EFD_REINF: "EFD-Reinf",
  CARTAO_CNPJ: "Cartão CNPJ",
  CONTRATO_SOCIAL: "Contrato social",
  CERTIDAO: "Certidões de débitos",
  INSCRICAO_ESTADUAL: "Inscrição estadual",
  RECIBO_ENTREGA: "Recibos de entrega de escrituração",
  PLANILHA: "Planilhas",
  DESCONHECIDO: "Pacotes de documentos fiscais (.zip)",
};

const ROTULO_NATUREZA: Record<string, string> = {
  DEBITO: "Débito",
  OMISSAO_DECLARACAO: "Declaração omissa",
  PARCELAMENTO: "Parcelamento",
  DIVIDA_ATIVA: "Dívida ativa",
  IRREGULARIDADE_CADASTRAL: "Irregularidade cadastral",
  OUTRA: "Outra",
};

export default async function RelatorioPage({
  params,
}: {
  params: { id: string };
}) {
  const auditoria = await prisma.auditoria.findUnique({
    where: { id: params.id },
    include: {
      empresa: { include: { regimes: { orderBy: { exercicio: "asc" } } } },
      achados: { include: { evidencias: true } },
      lacunas: { orderBy: { escopo: "asc" } },
    },
  });
  if (!auditoria) notFound();

  const [retrato, pendencias, porTipo] = await Promise.all([
    prisma.retratoSituacaoFiscal.findFirst({
      where: { documento: { auditoriaId: params.id } },
      orderBy: { criadoEm: "desc" },
    }),
    prisma.pendenciaFiscal.findMany({
      where: { documento: { auditoriaId: params.id } },
      orderBy: [{ natureza: "asc" }, { receita: "asc" }],
    }),
    prisma.documento.groupBy({
      by: ["tipo"],
      where: { auditoriaId: params.id, status: "CONCLUIDO" },
      _count: { _all: true },
    }),
  ]);

  const ordenar = (lista: typeof auditoria.achados) =>
    [...lista].sort(
      (a, b) =>
        ORDEM_SEVERIDADE.indexOf(a.severidade) -
          ORDEM_SEVERIDADE.indexOf(b.severidade) ||
        (a.competencia ?? "").localeCompare(b.competencia ?? ""),
    );

  const exigiveis = auditoria.achados.filter(
    (a) => a.situacaoPrescricional !== "DECAIDO",
  );
  const fiscais = ordenar(exigiveis.filter((a) => a.area === "FISCAL"));
  const contabeis = ordenar(exigiveis.filter((a) => a.area === "CONTABIL"));
  const aDecair = exigiveis.filter((a) => a.situacaoPrescricional === "A_DECAIR");

  /**
   * Os números da capa contam apenas achados de confiança ALTA.
   *
   * Achado que depende de conferência — a divergência de base de PIS/COFINS,
   * por exemplo, que pode ser explicada por exclusão legítima — entra num
   * número à parte. Levá-lo à primeira página como risco seria prometer o que
   * talvez não exista, e a reunião termina quando o contador do cliente
   * explicar a exclusão.
   */
  const somar = (filtro: (a: (typeof exigiveis)[number]) => boolean) =>
    exigiveis
      .filter(filtro)
      .reduce((s, a) => s.plus(a.valorExposicao ?? 0), new Prisma.Decimal(0));

  const confirmado = (a: (typeof exigiveis)[number]) => a.confianca === "ALTA";

  const debitoAberto = somar(
    (a) =>
      confirmado(a) && a.codigo.startsWith("A") && a.severidade !== "OPORTUNIDADE",
  );
  const risco = somar(
    (a) =>
      confirmado(a) && !a.codigo.startsWith("A") && a.severidade !== "OPORTUNIDADE",
  );
  const recuperavel = somar((a) => confirmado(a) && a.severidade === "OPORTUNIDADE");
  const aConfirmar = somar((a) => !confirmado(a));
  const qtdAConfirmar = exigiveis.filter((a) => !confirmado(a)).length;

  const pendenciaTotal = pendencias.reduce(
    (s, p) => s.plus(p.saldoConsolidado ?? p.saldoDevedor ?? 0),
    new Prisma.Decimal(0),
  );

  const emitidoEm = new Date().toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });

  return (
    <>
      <BotaoImprimir />

      <article className="rel">
        {/* ---------- Capa ---------- */}
        <header className="rel-capa">
          <div className="rel-marca">AZUOS</div>
          <div className="rel-sub">Auditoria Fiscal e Contábil</div>

          <div style={{ marginTop: "12mm" }}>
            <div style={{ fontSize: "15pt", fontWeight: 800 }}>
              {auditoria.empresa.razaoSocial}
            </div>
            <div style={{ fontSize: "9.5pt", color: "var(--muted)", marginTop: "1mm" }}>
              CNPJ {fmtCnpj(auditoria.empresa.cnpj)}
              {auditoria.empresa.uf ? ` · ${auditoria.empresa.uf}` : ""}
            </div>
            <div style={{ fontSize: "9.5pt", marginTop: "3mm" }}>
              Período auditado: <strong>{fmtComp(auditoria.competenciaIni)}</strong> a{" "}
              <strong>{fmtComp(auditoria.competenciaFim)}</strong>
            </div>
            {auditoria.empresa.regimes.length > 0 ? (
              <div style={{ fontSize: "9.5pt" }}>
                Regime:{" "}
                <strong>
                  {[
                    ...new Set(
                      auditoria.empresa.regimes.map(
                        (r) => ROTULO_REGIME[r.regime] ?? r.regime,
                      ),
                    ),
                  ].join(", ")}
                </strong>
              </div>
            ) : null}
            <div style={{ fontSize: "9.5pt" }}>
              Alcance:{" "}
              <strong>
                {auditoria.nivelAlcancado
                  ? ROTULO_NIVEL[auditoria.nivelAlcancado]
                  : "não executada"}
              </strong>
            </div>
          </div>
        </header>

        {/* ---------- Os três números ---------- */}
        <section>
          <h2>Resumo</h2>

          <div className="rel-numeros">
            <div
              className="rel-numero"
              style={{ borderLeftColor: "var(--danger)" }}
            >
              <div className="rel-numero-rotulo">Débito em aberto</div>
              <div className="rel-numero-valor">{moeda(debitoAberto)}</div>
              <div className="rel-numero-nota">declarado e não pago</div>
            </div>
            <div
              className="rel-numero"
              style={{ borderLeftColor: "var(--warning)" }}
            >
              <div className="rel-numero-rotulo">Risco de autuação</div>
              <div className="rel-numero-valor">{moeda(risco)}</div>
              <div className="rel-numero-nota">exposição a lançamento de ofício</div>
            </div>
            <div
              className="rel-numero"
              style={{ borderLeftColor: "var(--success)" }}
            >
              <div className="rel-numero-rotulo">A recuperar</div>
              <div className="rel-numero-valor">{moeda(recuperavel)}</div>
              <div className="rel-numero-nota">pago a maior ou crédito perdido</div>
            </div>
          </div>

          {qtdAConfirmar > 0 ? (
            <p
              style={{
                fontSize: "8.5pt",
                background: "#f8fafc",
                borderLeft: "2px solid var(--border)",
                padding: "2mm 3mm",
                marginBottom: "4mm",
              }}
            >
              Há ainda <strong>{moeda(aConfirmar)}</strong> em{" "}
              {qtdAConfirmar} apontamento(s) que dependem de conferência
              documental e <strong>não estão somados acima</strong>. Cada um traz
              a ressalva do que precisa ser verificado antes de ser tratado como
              inconsistência.
            </p>
          ) : null}

          <p style={{ fontSize: "9pt" }}>
            Foram analisados <strong>{porTipo.reduce((s, t) => s + t._count._all, 0)}</strong>{" "}
            documentos, dos quais resultaram <strong>{exigiveis.length}</strong>{" "}
            apontamentos dentro do prazo em que o Fisco ainda pode constituir o
            crédito tributário — {fiscais.length} de natureza fiscal e{" "}
            {contabeis.length} de natureza contábil.
            {aDecair.length > 0 ? (
              <>
                {" "}
                <strong>{aDecair.length}</strong> deles decaem em menos de doze
                meses.
              </>
            ) : null}
          </p>

          <p style={{ fontSize: "9pt" }}>
            Os três valores acima têm naturezas jurídicas distintas e não devem ser
            somados: o <strong>débito em aberto</strong> já foi declarado pela
            própria empresa e é exigível de imediato; o{" "}
            <strong>risco de autuação</strong> depende de lançamento de ofício; e o
            valor <strong>a recuperar</strong> é crédito a favor da empresa.
          </p>

          <h3>Documentos analisados</h3>
          <table>
            <tbody>
              {porTipo.map((t) => (
                <tr key={t.tipo}>
                  <td>{NOME_TIPO[t.tipo] ?? t.tipo.replace(/_/g, " ")}</td>
                  <td className="num" style={{ width: "20mm" }}>
                    {t._count._all}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* ---------- Achados fiscais ---------- */}
        <section className="rel-secao">
          <h2>1. Análise fiscal e tributária</h2>
          <p style={{ fontSize: "8.5pt", color: "var(--muted)" }}>
            Erros de apuração, de escrituração e de documento fiscal.
          </p>
          <Achados lista={fiscais} vazio="Nenhuma inconsistência fiscal identificada nos documentos analisados." />
        </section>

        {/* ---------- Achados contábeis ---------- */}
        <section className="rel-secao">
          <h2>2. Análise contábil e de recolhimento</h2>
          <p style={{ fontSize: "8.5pt", color: "var(--muted)" }}>
            Tributo apurado, confessado e pago; escrituração contábil e obrigações
            acessórias.
          </p>
          <Achados lista={contabeis} vazio="Nenhuma inconsistência contábil identificada nos documentos analisados." />
        </section>

        {/* ---------- Situação fiscal ---------- */}
        <section className="rel-secao">
          <h2>3. Situação fiscal na Receita Federal e na PGFN</h2>
          <p style={{ fontSize: "8.5pt", color: "var(--muted)" }}>
            Não é conclusão desta auditoria: é o que os próprios órgãos registram
            sobre a empresa.
          </p>

          {!retrato ? (
            <p style={{ fontSize: "9pt" }}>
              O Relatório de Situação Fiscal não foi disponibilizado para esta
              auditoria.
            </p>
          ) : retrato.semPendencias ? (
            <p style={{ fontSize: "9pt" }}>
              O relatório emitido
              {retrato.emitidoEm ? ` em ${retrato.emitidoEm}` : ""} declara que{" "}
              <strong>não foram detectadas pendências</strong> nem exigibilidades
              suspensas nos controles da Receita Federal e da Procuradoria-Geral da
              Fazenda Nacional. Situação cadastral:{" "}
              <strong>{retrato.situacaoCadastral ?? "não informada"}</strong>.
            </p>
          ) : (
            <>
              <p style={{ fontSize: "9pt" }}>
                Há <strong>{pendencias.length}</strong> pendência(s) registrada(s),
                somando <strong>{moeda(pendenciaTotal)}</strong> em saldo
                consolidado. Situação cadastral:{" "}
                <strong>{retrato.situacaoCadastral ?? "não informada"}</strong>.
              </p>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: "14mm" }}>Órgão</th>
                    <th style={{ width: "28mm" }}>Natureza</th>
                    <th>Receita</th>
                    <th style={{ width: "20mm" }}>Período</th>
                    <th style={{ width: "26mm" }}>Consolidado</th>
                  </tr>
                </thead>
                <tbody>
                  {pendencias.map((p) => (
                    <tr key={p.id}>
                      <td>{p.orgao}</td>
                      <td>{ROTULO_NATUREZA[p.natureza] ?? p.natureza}</td>
                      <td>{p.receita ?? p.descricao}</td>
                      <td>{p.periodo ?? "—"}</td>
                      <td className="num">{moeda(p.saldoConsolidado)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: "8pt", color: "var(--muted)" }}>
                Débito confessado e inscrição em dívida ativa são títulos
                executivos: a cobrança prossegue sem necessidade de autuação, e
                impedem a emissão de certidão negativa.
              </p>
            </>
          )}
        </section>

        {/* ---------- Lacunas ---------- */}
        <section className="rel-secao">
          <h2>4. Limitações desta auditoria</h2>
          <p style={{ fontSize: "9pt" }}>
            Esta auditoria foi realizada exclusivamente sobre os documentos
            disponibilizados. Os pontos abaixo <strong>não puderam ser
            verificados</strong> por ausência de documento — o que não significa
            que estejam corretos.
          </p>

          {auditoria.lacunas.length === 0 ? (
            <p style={{ fontSize: "9pt" }}>
              Todas as verificações aplicáveis ao regime da empresa puderam ser
              realizadas com os documentos disponibilizados.
            </p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Verificação não realizada</th>
                  <th style={{ width: "42mm" }}>Documento necessário</th>
                </tr>
              </thead>
              <tbody>
                {auditoria.lacunas.map((l) => (
                  <tr key={l.id}>
                    <td>{l.escopo}</td>
                    <td>{l.documentoFaltante.replace(/_/g, " ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <footer className="rel-rodape">
          <p>
            <strong>
              Analyze Auditoria e Consultoria Tributária — Grupo Azuos
            </strong>
            <br />
            Relatório emitido em {emitidoEm}.
          </p>
          <p style={{ marginTop: "2mm" }}>
            Análise realizada com base nos documentos disponibilizados e na
            legislação vigente na data dos fatos geradores. Os apontamentos
            dependem de confirmação documental complementar e não substituem
            consulta formal aos órgãos competentes. Os valores indicados
            correspondem à exposição apurada a partir dos arquivos analisados e não
            incluem multa e juros, salvo quando expressamente indicado.
          </p>
        </footer>
      </article>
    </>
  );
}

function Achados({
  lista,
  vazio,
}: {
  lista: {
    id: string;
    codigo: string;
    titulo: string;
    severidade: string;
    confianca: string;
    competencia: string | null;
    descricao: string;
    textoCliente: string | null;
    recomendacao: string | null;
    ressalva: string | null;
    valorExposicao: Prisma.Decimal | null;
    baseLegal: string[];
    evidencias: { id: string; arquivo: string; registro: string | null; observacao: string | null }[];
  }[];
  vazio: string;
}) {
  if (lista.length === 0) {
    return <p style={{ fontSize: "9pt" }}>{vazio}</p>;
  }

  return (
    <>
      {lista.map((a) => {
        const cor = COR_SEV[a.severidade] ?? COR_SEV.BAIXO;
        return (
          <div key={a.id} className="rel-achado" data-sev={a.severidade}>
            <div className="rel-achado-topo">
              <span className="rel-cod">{a.codigo}</span>
              <span className="rel-titulo">{a.titulo}</span>
              {a.valorExposicao ? (
                <span className="rel-valor">{moeda(a.valorExposicao)}</span>
              ) : null}
            </div>

            <div style={{ marginBottom: "1.5mm" }}>
              <span
                className="rel-tag"
                style={{ background: cor.fundo, color: cor.texto }}
              >
                {a.severidade}
              </span>
              {a.competencia ? (
                <span
                  className="rel-tag"
                  style={{ background: "#f1f5f9", color: "#64748b", marginLeft: "1.5mm" }}
                >
                  {fmtComp(a.competencia)}
                </span>
              ) : null}
              {a.confianca !== "ALTA" ? (
                <span
                  className="rel-tag"
                  style={{ background: "#f1f5f9", color: "#64748b", marginLeft: "1.5mm" }}
                >
                  confiança {a.confianca === "MEDIA" ? "média" : "baixa"}
                </span>
              ) : null}
            </div>

            <div style={{ fontSize: "9pt" }}>{a.textoCliente ?? a.descricao}</div>

            {a.recomendacao ? (
              <div className="rel-obs">
                <strong>Providência recomendada:</strong> {a.recomendacao}
              </div>
            ) : null}

            {a.ressalva ? (
              <div className="rel-ressalva">
                <strong>Ressalva:</strong> {a.ressalva}
              </div>
            ) : null}

            {a.evidencias.length > 0 ? (
              <div className="rel-obs">
                <strong>Origem:</strong>{" "}
                {a.evidencias
                  .map((e) =>
                    [e.arquivo, e.registro, e.observacao].filter(Boolean).join(" · "),
                  )
                  .join("; ")}
              </div>
            ) : null}

            {a.baseLegal.length > 0 ? (
              <div className="rel-obs">{a.baseLegal.join(" · ")}</div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

import { Prisma, type RegimeTributario } from "@prisma/client";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { BotaoImprimir } from "@/components/BotaoImprimir";
import {
  CATALOGO,
  aplicavelAoRegime,
  type AreaAchado,
  type DefinicaoAchado,
} from "@/server/auditoria/catalogo";
import { cnpj as fmtCnpj, competencia as fmtComp, moeda } from "@/lib/formato";

export const dynamic = "force-dynamic";
export const metadata = { title: "Relatório · Auditoria Azuos" };

const COR_SEV: Record<string, { fundo: string; texto: string }> = {
  CRITICO: { fundo: "#fee2e2", texto: "#b91c1c" },
  ALTO: { fundo: "#fef3c7", texto: "#92400e" },
  MEDIO: { fundo: "#cffafe", texto: "#155e75" },
  BAIXO: { fundo: "#f1f5f9", texto: "#64748b" },
  OPORTUNIDADE: { fundo: "#dcfce7", texto: "#166534" },
};

const NOME_FAMILIA: Record<string, string> = {
  DIVERGENCIA_PAGAMENTO: "Apurado × Confessado × Pago",
  RECEITA: "Receita e omissão",
  CREDITO: "Crédito indevido e crédito perdido",
  REGIME: "Regime e enquadramento",
  ICMS_OPERACIONAL: "ICMS operacional",
  CONTABIL: "Escrituração contábil",
  ACESSORIA: "Obrigações acessórias",
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

type Achado = Awaited<
  ReturnType<typeof prisma.achado.findMany<{ include: { evidencias: true } }>>
>[number];

type Lacuna = Awaited<ReturnType<typeof prisma.lacuna.findMany>>[number];

/** Situação de cada verificação do catálogo nesta auditoria. */
type Situacao = "APONTAMENTO" | "SEM_APONTAMENTO" | "NAO_VERIFICADO";

interface ItemVerificado {
  definicao: DefinicaoAchado;
  situacao: Situacao;
  achados: Achado[];
  lacuna?: Lacuna;
}

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
      lacunas: true,
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

  const regimes = new Set<RegimeTributario>(
    auditoria.empresa.regimes.map((r) => r.regime),
  );

  /**
   * O relatório percorre o CATÁLOGO, não a lista de achados.
   *
   * Mostrar só o que deu problema esconde o tamanho do trabalho: o cliente vê
   * três apontamentos e não sabe que trinta verificações foram feitas. Aqui cada
   * item do catálogo aplicável ao regime aparece com o seu resultado — encontrou,
   * não encontrou, ou não pôde ser verificado por falta de documento. É assim
   * que um relatório de auditoria se estrutura, e é o que dá peso à conclusão de
   * que algo está certo.
   */
  const achadosPorCodigo = new Map<string, Achado[]>();
  for (const a of auditoria.achados) {
    const lista = achadosPorCodigo.get(a.codigo) ?? [];
    lista.push(a);
    achadosPorCodigo.set(a.codigo, lista);
  }

  // A lacuna é gravada com o código na frente do escopo ("A01 — título").
  const lacunaPorCodigo = new Map<string, Lacuna>();
  for (const l of auditoria.lacunas) {
    const codigo = /^([A-G]\d{2})\b/.exec(l.escopo)?.[1];
    if (codigo) lacunaPorCodigo.set(codigo, l);
  }

  const verificados: ItemVerificado[] = CATALOGO.filter((d) =>
    aplicavelAoRegime(d, regimes),
  ).map((definicao) => {
    const achados = (achadosPorCodigo.get(definicao.codigo) ?? []).filter(
      (a) => a.situacaoPrescricional !== "DECAIDO",
    );
    const lacuna = lacunaPorCodigo.get(definicao.codigo);

    return {
      definicao,
      achados,
      lacuna,
      situacao: achados.length > 0
        ? "APONTAMENTO"
        : lacuna
          ? "NAO_VERIFICADO"
          : "SEM_APONTAMENTO",
    };
  });

  const comApontamento = verificados.filter((v) => v.situacao === "APONTAMENTO");
  const semApontamento = verificados.filter(
    (v) => v.situacao === "SEM_APONTAMENTO",
  );
  const naoVerificados = verificados.filter(
    (v) => v.situacao === "NAO_VERIFICADO",
  );

  // Lacunas sem código são as de competência sem escrituração.
  const lacunasDeCompetencia = auditoria.lacunas.filter(
    (l) => !/^([A-G]\d{2})\b/.test(l.escopo),
  );

  const exigiveis = auditoria.achados.filter(
    (a) => a.situacaoPrescricional !== "DECAIDO",
  );
  const confirmado = (a: Achado) => a.confianca === "ALTA";
  const somar = (filtro: (a: Achado) => boolean) =>
    exigiveis
      .filter(filtro)
      .reduce((s, a) => s.plus(a.valorExposicao ?? 0), new Prisma.Decimal(0));

  const debitoAberto = somar(
    (a) => confirmado(a) && a.codigo.startsWith("A") && a.severidade !== "OPORTUNIDADE",
  );
  const risco = somar(
    (a) => confirmado(a) && !a.codigo.startsWith("A") && a.severidade !== "OPORTUNIDADE",
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

  const areas: { chave: AreaAchado; numero: number; titulo: string; nota: string }[] = [
    {
      chave: "FISCAL",
      numero: 2,
      titulo: "Verificações fiscais e tributárias",
      nota: "Apuração, escrituração e documento fiscal.",
    },
    {
      chave: "CONTABIL",
      numero: 3,
      titulo: "Verificações contábeis e de recolhimento",
      nota: "Tributo apurado, confessado e pago; escrituração contábil e obrigações acessórias.",
    },
  ];

  return (
    <>
      <BotaoImprimir />

      <article className="rel">
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

        {/* ---------- 1. Resumo ---------- */}
        <section>
          <h2>1. Resumo</h2>

          <div className="rel-numeros">
            <div className="rel-numero" style={{ borderLeftColor: "var(--danger)" }}>
              <div className="rel-numero-rotulo">Débito em aberto</div>
              <div className="rel-numero-valor">{moeda(debitoAberto)}</div>
              <div className="rel-numero-nota">declarado e não pago</div>
            </div>
            <div className="rel-numero" style={{ borderLeftColor: "var(--warning)" }}>
              <div className="rel-numero-rotulo">Risco de autuação</div>
              <div className="rel-numero-valor">{moeda(risco)}</div>
              <div className="rel-numero-nota">exposição a lançamento de ofício</div>
            </div>
            <div className="rel-numero" style={{ borderLeftColor: "var(--success)" }}>
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
              Há ainda <strong>{moeda(aConfirmar)}</strong> em {qtdAConfirmar}{" "}
              apontamento(s) que dependem de conferência documental e{" "}
              <strong>não estão somados acima</strong>. Cada um traz a ressalva do
              que precisa ser verificado.
            </p>
          ) : null}

          <h3>Escopo verificado</h3>
          <p style={{ fontSize: "9pt" }}>
            Foram aplicadas <strong>{verificados.length}</strong> verificações,
            selecionadas entre as {CATALOGO.length} do catálogo Azuos conforme o
            regime tributário da empresa. O resultado de cada uma consta nas seções
            seguintes:
          </p>

          <table>
            <tbody>
              <tr>
                <td style={{ width: "6mm" }}>
                  <span
                    className="rel-tag"
                    style={{ background: "#fee2e2", color: "#b91c1c" }}
                  >
                    ●
                  </span>
                </td>
                <td>
                  <strong>{comApontamento.length}</strong> verificação(ões) com
                  apontamento
                </td>
                <td className="num" style={{ width: "24mm" }}>
                  {comApontamento.length}
                </td>
              </tr>
              <tr>
                <td>
                  <span
                    className="rel-tag"
                    style={{ background: "#dcfce7", color: "#166534" }}
                  >
                    ●
                  </span>
                </td>
                <td>
                  <strong>{semApontamento.length}</strong> verificação(ões) sem
                  apontamento — conferido e nada encontrado
                </td>
                <td className="num">{semApontamento.length}</td>
              </tr>
              <tr>
                <td>
                  <span
                    className="rel-tag"
                    style={{ background: "#f1f5f9", color: "#64748b" }}
                  >
                    ●
                  </span>
                </td>
                <td>
                  <strong>{naoVerificados.length}</strong> verificação(ões) não
                  realizadas por ausência de documento
                </td>
                <td className="num">{naoVerificados.length}</td>
              </tr>
            </tbody>
          </table>

          <p style={{ fontSize: "8.5pt", color: "var(--muted)" }}>
            Os três valores do quadro acima têm naturezas jurídicas distintas e não
            devem ser somados: o débito em aberto já foi declarado pela própria
            empresa e é exigível de imediato; o risco de autuação depende de
            lançamento de ofício; e o valor a recuperar é crédito a favor da
            empresa.
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

        {/* ---------- 2 e 3. As verificações, item a item do catálogo ---------- */}
        {areas.map((area) => {
          const daArea = verificados.filter((v) => v.definicao.area === area.chave);
          if (daArea.length === 0) return null;

          const familias = new Map<string, ItemVerificado[]>();
          for (const v of daArea) {
            const lista = familias.get(v.definicao.familia) ?? [];
            lista.push(v);
            familias.set(v.definicao.familia, lista);
          }

          return (
            <section key={area.chave} className="rel-secao">
              <h2>
                {area.numero}. {area.titulo}
              </h2>
              <p style={{ fontSize: "8.5pt", color: "var(--muted)" }}>{area.nota}</p>

              {[...familias.entries()].map(([familia, itens]) => (
                <div key={familia}>
                  <h3>{NOME_FAMILIA[familia] ?? familia}</h3>
                  {itens.map((item) => (
                    <Verificacao key={item.definicao.codigo} item={item} />
                  ))}
                </div>
              ))}
            </section>
          );
        })}

        {/* ---------- 4. Situação fiscal ---------- */}
        <section className="rel-secao">
          <h2>4. Situação fiscal na Receita Federal e na PGFN</h2>
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

        {/* ---------- 5. Limitações ---------- */}
        <section className="rel-secao">
          <h2>5. Limitações desta auditoria</h2>
          <p style={{ fontSize: "9pt" }}>
            Esta auditoria foi realizada exclusivamente sobre os documentos
            disponibilizados. As verificações marcadas como{" "}
            <strong>não realizadas</strong> nas seções anteriores dependem dos
            documentos indicados em cada uma — a ausência de apontamento nelas{" "}
            <strong>não significa regularidade</strong>.
          </p>

          {lacunasDeCompetencia.length > 0 ? (
            <>
              <h3>Competências sem escrituração disponibilizada</h3>
              <p style={{ fontSize: "9pt" }}>
                Nenhuma conclusão foi tirada sobre as competências abaixo:
              </p>
              <table>
                <tbody>
                  {lacunasDeCompetencia.map((l) => (
                    <tr key={l.id}>
                      <td>{l.escopo}</td>
                      <td style={{ width: "42mm" }}>
                        {NOME_TIPO[l.documentoFaltante] ?? l.documentoFaltante}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : null}

          <h3>Documentos que ampliariam o alcance</h3>
          <p style={{ fontSize: "9pt" }}>
            A obtenção dos documentos abaixo permitiria concluir as{" "}
            {naoVerificados.length} verificações pendentes:
          </p>
          <table>
            <tbody>
              {[
                ...new Set(
                  naoVerificados.map((v) => v.lacuna?.documentoFaltante).filter(Boolean),
                ),
              ].map((tipo) => (
                <tr key={tipo}>
                  <td>{NOME_TIPO[tipo!] ?? tipo}</td>
                  <td className="num" style={{ width: "30mm" }}>
                    {
                      naoVerificados.filter(
                        (v) => v.lacuna?.documentoFaltante === tipo,
                      ).length
                    }{" "}
                    verificação(ões)
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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

/**
 * Uma verificação do catálogo, com o seu resultado.
 *
 * O item existe mesmo quando nada foi encontrado: é a diferença entre "não há
 * problema aqui" e "não olhamos aqui", e o cliente precisa enxergar as duas.
 */
function Verificacao({ item }: { item: ItemVerificado }) {
  const { definicao, situacao, achados, lacuna } = item;

  const marcador =
    situacao === "APONTAMENTO"
      ? { rotulo: "APONTAMENTO", fundo: "#fee2e2", texto: "#b91c1c" }
      : situacao === "SEM_APONTAMENTO"
        ? { rotulo: "SEM APONTAMENTO", fundo: "#dcfce7", texto: "#166534" }
        : { rotulo: "NÃO VERIFICADO", fundo: "#f1f5f9", texto: "#64748b" };

  const severidade =
    situacao === "APONTAMENTO" ? achados[0].severidade : undefined;

  const total = achados.reduce(
    (s, a) => s.plus(a.valorExposicao ?? 0),
    new Prisma.Decimal(0),
  );

  return (
    <div
      className="rel-achado"
      data-sev={severidade}
      style={
        situacao !== "APONTAMENTO"
          ? { borderLeftColor: marcador.texto === "#166534" ? "var(--success)" : "var(--border)" }
          : undefined
      }
    >
      <div className="rel-achado-topo">
        <span className="rel-cod">{definicao.codigo}</span>
        <span className="rel-titulo">{definicao.titulo}</span>
        {situacao === "APONTAMENTO" && !total.isZero() ? (
          <span className="rel-valor">{moeda(total)}</span>
        ) : null}
      </div>

      <div style={{ marginBottom: "1.5mm" }}>
        <span
          className="rel-tag"
          style={{ background: marcador.fundo, color: marcador.texto }}
        >
          {marcador.rotulo}
        </span>
        {severidade ? (
          <span
            className="rel-tag"
            style={{
              background: COR_SEV[severidade].fundo,
              color: COR_SEV[severidade].texto,
              marginLeft: "1.5mm",
            }}
          >
            {severidade}
          </span>
        ) : null}
      </div>

      {/* Sem apontamento: basta dizer o que foi conferido. */}
      {situacao === "SEM_APONTAMENTO" ? (
        <div style={{ fontSize: "8.5pt" }}>
          {definicao.descricao} <strong>Verificado nos documentos
          disponibilizados, sem inconsistência identificada.</strong>
        </div>
      ) : null}

      {situacao === "NAO_VERIFICADO" ? (
        <div style={{ fontSize: "8.5pt" }}>
          {definicao.descricao}{" "}
          <strong>
            Não foi possível verificar: falta{" "}
            {NOME_TIPO[lacuna?.documentoFaltante ?? ""] ??
              lacuna?.documentoFaltante}
            .
          </strong>
        </div>
      ) : null}

      {/* Com apontamento: cada ocorrência, com competência, prova e providência. */}
      {achados.map((a) => (
        <div
          key={a.id}
          style={{
            marginTop: "2mm",
            paddingTop: "1.5mm",
            borderTop: achados.length > 1 ? "1px dotted var(--border)" : "none",
          }}
        >
          <div style={{ fontSize: "9pt" }}>
            {a.competencia ? (
              <strong>{fmtComp(a.competencia)} · </strong>
            ) : null}
            {a.textoCliente ?? a.descricao}
          </div>

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
        </div>
      ))}

      <div className="rel-obs">{definicao.baseLegal.join(" · ")}</div>
    </div>
  );
}

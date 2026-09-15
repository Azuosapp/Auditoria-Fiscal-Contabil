/**
 * Relatório de Situação Fiscal do e-CAC — "Informações de Apoio para Emissão de
 * Certidão", emitido em conjunto pela Receita Federal e pela PGFN.
 *
 * É o documento mais valioso da prospecção: mostra o que o Fisco já sabe e o
 * cliente muitas vezes não. Débito em cobrança, declaração omissa, inscrição em
 * dívida ativa, parcelamento — tudo dito pelo próprio órgão, sem depender de
 * cruzamento nenhum.
 *
 * O leiaute é texto posicional, e o `pdftotext -layout` não preserva a ordem
 * visual das linhas da tabela de débitos: os VALORES saem numa linha e o código
 * da receita a que pertencem sai na LINHA SEGUINTE. Por isso a leitura casa as
 * duas — ignorar isso produziria débito sem tributo ou tributo sem valor.
 */

export interface SocioSituacaoFiscal {
  documento: string;
  nome: string;
  qualificacao?: string;
  situacaoCadastral?: string;
  participacao?: string;
}

export type NaturezaPendencia =
  | "DEBITO"
  | "OMISSAO_DECLARACAO"
  | "PARCELAMENTO"
  | "DIVIDA_ATIVA"
  | "IRREGULARIDADE_CADASTRAL"
  | "OUTRA";

export interface PendenciaSituacaoFiscal {
  natureza: NaturezaPendencia;
  /** Órgão que registra a pendência. */
  orgao: "RFB" | "PGFN";
  descricao: string;
  /** Código e nome da receita, quando houver (ex.: "5952-07 - CSRF"). */
  receita?: string;
  /** Período de apuração ou exercício, como impresso. */
  periodo?: string;
  vencimento?: string;
  valorOriginal?: string;
  saldoDevedor?: string;
  multa?: string;
  juros?: string;
  /** Saldo devedor consolidado — principal + multa + juros. */
  saldoConsolidado?: string;
  situacao?: string;
  /** Número da inscrição em dívida ativa ou do processo. */
  identificacao?: string;
}

export interface SituacaoFiscalExtraida {
  cnpj?: string;
  razaoSocial?: string;
  situacaoCadastral?: string;
  /** Por que a inscrição está nessa situação (ex.: "Omissão de declarações em ..."). */
  motivoSituacao?: string;
  naturezaJuridica?: string;
  cnae?: string;
  porte?: string;
  dataAbertura?: string;
  municipio?: string;
  uf?: string;
  unidadeAdministrativa?: string;
  responsavel?: string;
  emitidoEm?: string;
  /** Certidão vigente, quando o relatório a menciona. */
  certidao?: { numero?: string; emissao?: string; validade?: string };
  socios: SocioSituacaoFiscal[];
  pendencias: PendenciaSituacaoFiscal[];
  /** O relatório afirma, com todas as letras, que não há pendência? */
  semPendencias: boolean;
  avisos: string[];
}

/** O texto é mesmo um Relatório de Situação Fiscal? */
export function ehSituacaoFiscal(texto: string): boolean {
  const t = normalizar(texto);
  return (
    /INFORMACOES DE APOIO PARA EMISSAO DE CERTIDAO/.test(t) ||
    /DIAGNOSTICO FISCAL NA RECEITA FEDERAL/.test(t)
  );
}

export function parseSituacaoFiscal(texto: string): SituacaoFiscalExtraida | null {
  if (!ehSituacaoFiscal(texto)) return null;

  const linhas = texto.split(/\r?\n/);
  const avisos: string[] = [];

  const resultado: SituacaoFiscalExtraida = {
    socios: [],
    pendencias: [],
    semPendencias: false,
    avisos,
  };

  const declaraSemPendencia = /N.o foram detectadas pend.ncias/i.test(texto);

  lerCabecalho(linhas, resultado);
  resultado.socios = lerSocios(linhas);
  resultado.pendencias = lerPendencias(linhas, avisos, declaraSemPendencia);

  resultado.semPendencias =
    declaraSemPendencia && resultado.pendencias.length === 0;

  if (!resultado.cnpj) {
    avisos.push("CNPJ não localizado no relatório.");
  }

  return resultado;
}

// =====================================================================

function normalizar(s: string): string {
  // O PDF do e-CAC vem em Latin-1 e o acento às vezes chega corrompido. Comparar
  // sem acento evita depender de a decodificação ter dado certo.
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase();
}

function capturar(linhas: string[], rotulo: RegExp): string | undefined {
  for (const linha of linhas) {
    const m = rotulo.exec(linha);
    if (m?.[1]) return m[1].trim();
  }
  return undefined;
}

function lerCabecalho(linhas: string[], r: SituacaoFiscalExtraida) {
  // "CNPJ: 30.411.835 - LUMINI CLINICA DERMATOLOGICA LTDA" — o cabeçalho traz a
  // raiz do CNPJ com a razão social; o bloco de dados cadastrais traz o número
  // completo. Os dois são lidos, e o completo prevalece.
  const comRazao = /CNPJ:\s*([\d.]{10,18})\s*-\s*(.+?)\s*$/;
  for (const linha of linhas) {
    const m = comRazao.exec(linha);
    if (m) {
      r.razaoSocial = m[2].trim();
      break;
    }
  }

  const completo = capturar(linhas, /CNPJ:\s*(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})/);
  if (completo) r.cnpj = completo.replace(/\D/g, "");

  r.unidadeAdministrativa = capturar(linhas, /UA de Domic.lio:\s*(.+?)(?:\s{2,}|$)/i);
  r.responsavel = capturar(linhas, /Respons.vel:\s*(.+?)(?:\s{2,}|$)/i);
  r.naturezaJuridica = capturar(linhas, /Natureza Jur.dica:\s*(.+?)(?:\s{2,}|$)/i);
  r.cnae = capturar(linhas, /CNAE:\s*(.+?)(?:\s{2,}|$)/i);
  r.porte = capturar(linhas, /Porte da Empresa:\s*(.+?)(?:\s{2,}|$)/i);
  r.dataAbertura = capturar(linhas, /Data de Abertura:\s*(\d{2}\/\d{2}\/\d{4})/i);
  r.municipio = capturar(linhas, /Munic.pio:\s*(.+?)(?:\s{2,}|UF:|$)/i);
  r.uf = capturar(linhas, /UF:\s*([A-Z]{2})\b/);
  r.emitidoEm = capturar(linhas, /(\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2})/);

  // A situação cadastral aparece como "Situação: ATIVA". Mas o mesmo rótulo é
  // reutilizado adiante para a situação da inscrição em dívida ("Situação:
  // ATIVA EM COBRANCA"), então vale a PRIMEIRA ocorrência, que é a cadastral.
  const situacaoBruta = capturar(linhas, /^\s*Situa..o:\s*(.+?)(?:\s{2,}|$)/i);
  if (situacaoBruta) {
    // Vem como "INAPTA Omissão de declarações em 25/01/2019": a primeira
    // palavra é a situação, o resto é o motivo — e os dois valem separados.
    const m = /^([A-ZÀ-Ú]+(?:\s+EM\s+[A-ZÀ-Ú]+)?)\s*(.*)$/.exec(situacaoBruta.trim());
    r.situacaoCadastral = m ? m[1].trim() : situacaoBruta;
    if (m?.[2]?.trim()) r.motivoSituacao = m[2].trim();
  }

  const numero = capturar(linhas, /Certid.o Negativa:\s*([A-F0-9.]+)/i);
  if (numero) {
    r.certidao = {
      numero,
      emissao: capturar(linhas, /Emiss.o:\s*(\d{2}\/\d{2}\/\d{4})/i),
      validade: capturar(linhas, /Data de Validade:\s*(\d{2}\/\d{2}\/\d{4})/i),
    };
  }
}

function lerSocios(linhas: string[]): SocioSituacaoFiscal[] {
  const socios: SocioSituacaoFiscal[] = [];
  let dentro = false;

  for (const linha of linhas) {
    const t = normalizar(linha);

    if (/SOCIOS E ADMINISTRADORES/.test(t)) {
      dentro = true;
      continue;
    }
    // O bloco termina no próximo título sublinhado do relatório.
    if (dentro && /_{20,}/.test(linha) && !/SOCIOS/.test(t)) {
      if (/CERTIDAO|DIAGNOSTICO|PENDENCIA|PARCELAMENTO/.test(t)) break;
    }
    if (!dentro) continue;

    // "882.119.591-00    NOME    QUALIFICAÇÃO    SITUAÇÃO    50,00%"
    const m = /^\s*([\d.\-/]{11,18})\s{2,}(.+?)(?:\s{2,}(.+?))?(?:\s{2,}(.+?))?(?:\s{2,}([\d,.]+%))?\s*$/.exec(
      linha,
    );
    if (!m) continue;
    const documento = m[1].replace(/\D/g, "");
    if (documento.length !== 11 && documento.length !== 14) continue;

    // "SANDRA ... FIGUEIREDO SÓCIO" — a coluna de qualificação às vezes encosta
    // no nome. O sufixo conhecido é devolvido ao campo certo.
    let nome = m[2].trim();
    let qualificacao = m[3]?.trim();
    const colado = /^(.*?)\s+(S.CIO(?:-ADMINISTRADOR)?|ADMINISTRADOR|TITULAR|PRESIDENTE|DIRETOR)$/i.exec(
      nome,
    );
    if (colado) {
      nome = colado[1].trim();
      qualificacao = [colado[2], qualificacao].filter(Boolean).join(" ").trim();
    }

    socios.push({
      documento,
      nome,
      qualificacao,
      situacaoCadastral: m[4]?.trim(),
      participacao: m[5]?.trim(),
    });
  }

  return socios;
}

/** Linha só com valores monetários da tabela de débitos do SIEF. */
const LINHA_VALORES =
  /^\s*([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+([\d.]+,\d{2})\s+(\S.*?)\s*$/;

/** Linha que abre um débito: "5952-07 - CSRF  08/2025 19/09/2025". */
const LINHA_RECEITA =
  /^\s*(\d{4}-\d{2}\s*-\s*.+?)\s+(\d{2}\/\d{4}|\d{2}\/\d{2}\/\d{4}|\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s*$/;

/** Linha de inscrição em dívida ativa (SIDA). */
const LINHA_INSCRICAO =
  /^\s*(\d{2}\.\d\.\d{2}\.\d{6}-\d{2})\s+(.+?)\s{2,}(?:(\d{2}\/\d{2}\/\d{4})\s+)?(?:(\d{2}\/\d{2}\/\d{4})\s+)?(\S*\d{5,}\S*)?\s*(.*)$/;

function lerPendencias(
  linhas: string[],
  avisos: string[],
  declaraSemPendencia: boolean,
): PendenciaSituacaoFiscal[] {
  const pendencias: PendenciaSituacaoFiscal[] = [];

  let orgao: "RFB" | "PGFN" = "RFB";
  let secao: NaturezaPendencia | null = null;
  let tituloSecao = "";
  // Os valores vêm ANTES do código da receita no texto extraído: guardamos a
  // última linha de valores para casar com a linha de receita que vem depois.
  let valoresPendentes: RegExpExecArray | null = null;

  for (const linha of linhas) {
    const t = normalizar(linha);

    if (/DIAGNOSTICO FISCAL NA PROCURADORIA/.test(t)) {
      orgao = "PGFN";
      secao = null;
      continue;
    }
    if (/DIAGNOSTICO FISCAL NA RECEITA FEDERAL/.test(t)) {
      orgao = "RFB";
      secao = null;
      continue;
    }

    const nova = tipoDeSecao(t);
    if (nova) {
      secao = nova.natureza;
      tituloSecao = nova.titulo;
      valoresPendentes = null;

      // Omissão e irregularidade cadastral são pendências em si: o título já é
      // o fato, sem tabela abaixo. Ficam registradas na hora.
      if (
        nova.natureza === "OMISSAO_DECLARACAO" ||
        nova.natureza === "IRREGULARIDADE_CADASTRAL"
      ) {
        pendencias.push({ natureza: nova.natureza, orgao, descricao: nova.titulo });
      }
      continue;
    }

    if (!secao) continue;

    if (secao === "DEBITO") {
      const valores = LINHA_VALORES.exec(linha);
      if (valores) {
        valoresPendentes = valores;
        continue;
      }

      const receita = LINHA_RECEITA.exec(linha);
      if (receita) {
        pendencias.push({
          natureza: "DEBITO",
          orgao,
          descricao: tituloSecao,
          receita: receita[1].replace(/\s{2,}/g, " ").trim(),
          periodo: receita[2],
          vencimento: receita[3],
          valorOriginal: valoresPendentes?.[1],
          saldoDevedor: valoresPendentes?.[2],
          multa: valoresPendentes?.[3],
          juros: valoresPendentes?.[4],
          saldoConsolidado: valoresPendentes?.[5],
          situacao: valoresPendentes?.[6]?.trim(),
        });
        valoresPendentes = null;
      }
      continue;
    }

    if (secao === "DIVIDA_ATIVA") {
      const insc = LINHA_INSCRICAO.exec(linha);
      if (insc) {
        pendencias.push({
          natureza: "DIVIDA_ATIVA",
          orgao,
          descricao: tituloSecao,
          identificacao: insc[1],
          receita: insc[2]?.trim(),
          periodo: insc[3],
          situacao: insc[6]?.trim() || undefined,
        });
      }
      continue;
    }

    if (secao === "PARCELAMENTO") {
      // "006500000  PROGRAMA DE REESCALONAMENTO ... - RELP"
      const m = /^\s*(\d{6,})\s{2,}(.+?)\s*$/.exec(linha);
      if (m) {
        pendencias.push({
          natureza: "PARCELAMENTO",
          orgao,
          descricao: tituloSecao,
          identificacao: m[1],
          receita: m[2].trim(),
        });
      }
      continue;
    }
  }

  // Relatório que diz "não foram detectadas pendências" e não produz nenhuma
  // está correto — avisar aqui seria alarme falso. O aviso só vale quando o
  // documento não afirma isso e mesmo assim nada foi lido.
  if (pendencias.length === 0 && !declaraSemPendencia) {
    avisos.push(
      "Nenhuma pendência foi extraída e o relatório não afirma estar limpo. " +
        "Confira o PDF: o leiaute pode ter mudado.",
    );
  }

  return pendencias;
}

function tipoDeSecao(
  t: string,
): { natureza: NaturezaPendencia; titulo: string } | null {
  // Os títulos vêm seguidos de uma régua de sublinhados.
  if (!/_{10,}/.test(t) && !/^\s*(PENDENCIA|PARCELAMENTO|OMISSAO)/.test(t)) {
    return null;
  }

  const limpo = t.replace(/_{3,}/g, "").replace(/\s{2,}/g, " ").trim();
  if (limpo.length === 0) return null;

  if (/PENDENCIA - DEBITO/.test(limpo)) {
    return { natureza: "DEBITO", titulo: "Pendência — Débito (SIEF)" };
  }
  if (/PENDENCIA - INSCRICAO|INSCRICAO \(SIDA\)/.test(limpo)) {
    return { natureza: "DIVIDA_ATIVA", titulo: "Pendência — Inscrição em dívida ativa (SIDA)" };
  }
  if (/PARCELAMENTO/.test(limpo)) {
    return {
      natureza: "PARCELAMENTO",
      titulo: limpo.includes("SUSPENSA")
        ? "Parcelamento com exigibilidade suspensa (SISPAR)"
        : "Parcelamento",
    };
  }
  if (/OMISSAO DE ([A-Z\-]+)/.test(limpo)) {
    const qual = /OMISSAO DE ([A-Z\-]+)/.exec(limpo)?.[1] ?? "";
    return {
      natureza: "OMISSAO_DECLARACAO",
      titulo: `Omissão de ${qual.replace(/\*$/, "")}`,
    };
  }
  if (/IRREGULARIDADE CADASTRAL/.test(limpo)) {
    return {
      natureza: "IRREGULARIDADE_CADASTRAL",
      titulo: "Pendência — irregularidade cadastral",
    };
  }

  return null;
}

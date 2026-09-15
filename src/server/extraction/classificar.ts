import type { TipoDocumento } from "@prisma/client";
import { decodeTextBuffer } from "./encoding";
import { ehZip } from "./zip";

/**
 * Classificação do documento pelo CONTEÚDO, nunca pelo nome do arquivo.
 *
 * O arquivo chega do cliente com qualquer nome: "arquivo (3).txt", "sped.txt"
 * para uma ECD, "contabil.txt" para uma EFD. Confiar no nome erra o parser e o
 * erro só aparece lá na frente, como número faltando no relatório.
 *
 * Só os primeiros KB são examinados: todo leiaute fiscal se identifica no
 * começo, e ler 300 MB de zip para descobrir o tipo seria desperdício.
 */

export interface Classificacao {
  tipo: TipoDocumento;
  /** Como foi reconhecido — aparece na tela para o usuário poder discordar. */
  motivo: string;
  /** `false` quando o tipo foi deduzido por pista fraca e merece confirmação. */
  seguro: boolean;
}

/**
 * Amostra lida para classificar.
 *
 * Eram 8 KB, e não bastava: num SPED Fiscal real de uma indústria, o Bloco 0
 * sozinho (participantes, itens, unidades) passa de 8 KB, e o primeiro registro
 * de apuração só aparece bem depois. O arquivo era reconhecido como SPED, mas
 * sem saber QUAL — e caía na classificação insegura.
 *
 * 256 KB cobre o Bloco 0 das empresas reais e ainda é barato: a leitura é de um
 * prefixo do buffer que já está em memória.
 */
const AMOSTRA_BYTES = 256 * 1024;

export function classificar(buffer: Buffer, nomeArquivo: string): Classificacao {
  if (ehZip(buffer)) {
    // XLSX também é ZIP. O que separa é o manifesto do Office na raiz.
    const cabecalho = buffer.subarray(0, 4096).toString("latin1");
    if (cabecalho.includes("[Content_Types].xml") || cabecalho.includes("xl/")) {
      return { tipo: "PLANILHA", motivo: "planilha Excel (XLSX)", seguro: true };
    }
    return {
      tipo: "DESCONHECIDO",
      motivo: "pacote ZIP — o conteúdo é classificado arquivo a arquivo",
      seguro: true,
    };
  }

  if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") {
    return { tipo: "DESCONHECIDO", motivo: "PDF — exige leitura do texto", seguro: true };
  }

  const amostra = decodeTextBuffer(buffer.subarray(0, AMOSTRA_BYTES)).text;

  const xml = classificarXml(amostra);
  if (xml) return xml;

  const sped = classificarSped(amostra);
  if (sped) return sped;

  if (/^[^\n]*[;,][^\n]*[;,]/.test(amostra)) {
    return { tipo: "PLANILHA", motivo: "texto separado por delimitador (CSV)", seguro: false };
  }

  return {
    tipo: "DESCONHECIDO",
    motivo: `não foi possível reconhecer o conteúdo de ${nomeArquivo}`,
    seguro: true,
  };
}

function classificarXml(amostra: string): Classificacao | null {
  if (!/^\s*<\?xml|^\s*</.test(amostra)) return null;

  // Evento vem no MESMO pacote das notas. Tratar evento como nota infla o
  // faturamento; ignorá-lo faz nota cancelada seguir contando como receita.
  if (/<\s*(\w+:)?procEventoNFe|<\s*(\w+:)?evento[\s>]/i.test(amostra)) {
    return { tipo: "EVENTO_NFE", motivo: "evento de NF-e", seguro: true };
  }

  if (/<\s*(\w+:)?(nfeProc|NFe)[\s>]/i.test(amostra)) {
    // O modelo separa NF-e de NFC-e e muda a leitura: NFC-e é sempre saída a
    // consumidor final, o que importa para DIFAL e para a receita de varejo.
    const modelo = /<mod>(\d{2})<\/mod>/i.exec(amostra)?.[1];
    if (modelo === "65") {
      return { tipo: "NFCE_XML", motivo: "NFC-e (modelo 65)", seguro: true };
    }
    return {
      tipo: "NFE_XML",
      motivo: modelo === "55" ? "NF-e (modelo 55)" : "NF-e",
      seguro: true,
    };
  }

  if (/<\s*(\w+:)?(infNFSe|CompNfse|InfNfse|Nfse|infDPS)/i.test(amostra)) {
    return { tipo: "NFSE_XML", motivo: "NFS-e", seguro: true };
  }

  if (/<\s*(\w+:)?(eSocial|evtRemun|evtInfoEmpregador)/i.test(amostra)) {
    return { tipo: "ESOCIAL", motivo: "evento do eSocial", seguro: true };
  }

  if (/<\s*(\w+:)?(Reinf|evtRetPJ|evtServTom|evtServPrest)/i.test(amostra)) {
    return { tipo: "EFD_REINF", motivo: "evento da EFD-Reinf", seguro: true };
  }

  return {
    tipo: "DESCONHECIDO",
    motivo: "XML de leiaute não reconhecido (inutilização, consulta, distribuição)",
    seguro: true,
  };
}

/**
 * SPED — todos os leiautes abrem com `|0000|`, e o campo 2 desse registro é que
 * diz qual é:
 *
 *   ECD  →  |0000|LECD|...
 *   ECF  →  |0000|LECF|...
 *   EFD ICMS/IPI e EFD-Contribuições  →  |0000|<versão numérica>|...
 *
 * Entre as duas EFD, a distinção é pelos registros de apuração: `0110`, `M200` e
 * `M600` só existem na EFD-Contribuições; `E110` e `C190`, na EFD ICMS/IPI.
 */
function classificarSped(amostra: string): Classificacao | null {
  if (!/^\|0000\|/m.test(amostra)) return null;

  const abertura = /^\|0000\|([^|]*)\|/m.exec(amostra)?.[1]?.trim().toUpperCase();

  if (abertura === "LECD") {
    return { tipo: "ECD", motivo: "SPED Contábil (ECD) — abertura LECD", seguro: true };
  }
  if (abertura === "LECF") {
    return {
      tipo: "ECF",
      motivo: "Escrituração Contábil Fiscal (ECF) — abertura LECF",
      seguro: true,
    };
  }

  // O 0110 abre a EFD-Contribuições logo no Bloco 0 e não existe na EFD
  // ICMS/IPI — é o separador mais confiável entre as duas.
  if (/^\|(0110|0111|M100|M105|M200|M500|M505|M600)\|/m.test(amostra)) {
    return {
      tipo: "SPED_CONTRIBUICOES",
      motivo: "EFD-Contribuições — registro 0110 / apuração de PIS/COFINS",
      seguro: true,
    };
  }

  // Registros exclusivos da EFD ICMS/IPI. O 0005 e o 0150 aparecem no Bloco 0,
  // muito antes do bloco de apuração — é o que permite reconhecer o arquivo sem
  // depender de alcançar o Bloco E, que num SPED de indústria fica longe.
  if (/^\|(0005|0150|0200|C100|C190|E100|E110|E116)\|/m.test(amostra)) {
    return {
      tipo: "SPED_FISCAL",
      motivo: "EFD ICMS/IPI — registros do Bloco 0 e de apuração do ICMS",
      seguro: true,
    };
  }

  // É SPED, mas nenhum registro conhecido apareceu. Assumir EFD ICMS/IPI seria
  // chute silencioso: fica marcado como não seguro para o usuário conferir.
  return {
    tipo: "SPED_FISCAL",
    motivo: "arquivo SPED sem registro identificador na amostra lida",
    seguro: false,
  };
}

/**
 * Classificação de PDF a partir do texto já extraído.
 *
 * Separada da função principal porque extrair texto de PDF custa um processo
 * externo (`pdftotext`) — só vale a pena para o que já se sabe ser PDF.
 */
export function classificarPdf(texto: string): Classificacao {
  const t = texto.toUpperCase();

  if (/EXTRATO DO SIMPLES NACIONAL|PGDAS-?D|PERÍODO DE APURAÇÃO.*SIMPLES/.test(t)) {
    return { tipo: "PGDAS", motivo: "extrato do Simples Nacional (PGDAS-D)", seguro: true };
  }

  if (/RELATÓRIO DE SITUAÇÃO FISCAL|SITUAÇÃO FISCAL|DIAGNÓSTICO FISCAL/.test(t)) {
    return {
      tipo: "SITUACAO_FISCAL",
      motivo: "relatório de situação fiscal do e-CAC",
      seguro: true,
    };
  }

  if (/DOCUMENTO DE ARRECADAÇÃO|DARF|DOCUMENTO DE ARRECADA|GNRE|DARE/.test(t)) {
    return {
      tipo: "COMPROVANTE_ARRECADACAO",
      motivo: "documento de arrecadação",
      seguro: true,
    };
  }

  if (/DCTFWEB|DCTF WEB/.test(t)) {
    return { tipo: "DCTFWEB", motivo: "DCTFWeb", seguro: true };
  }
  if (/DCTF|DECLARAÇÃO DE DÉBITOS E CRÉDITOS/.test(t)) {
    return { tipo: "DCTF", motivo: "DCTF", seguro: true };
  }

  if (/COMPROVANTE DE INSCRIÇÃO E DE SITUAÇÃO CADASTRAL/.test(t)) {
    return { tipo: "CARTAO_CNPJ", motivo: "cartão CNPJ", seguro: true };
  }

  if (/CONTRATO SOCIAL|ALTERAÇÃO CONTRATUAL/.test(t)) {
    return { tipo: "CONTRATO_SOCIAL", motivo: "contrato social", seguro: true };
  }

  return { tipo: "DESCONHECIDO", motivo: "PDF de conteúdo não reconhecido", seguro: true };
}

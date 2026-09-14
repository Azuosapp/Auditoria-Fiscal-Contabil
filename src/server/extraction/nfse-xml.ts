import { XMLParser, XMLValidator } from "fast-xml-parser";
import { dec, type Money } from "@/server/tax/decimal";
import { decodeTextBuffer, type DecodedText } from "./encoding";
import type {
  ExtractionResult,
  ParsedInvoice,
  ParsedInvoiceItem,
} from "./types";

/**
 * Parser de XML de NFS-e (Nota Fiscal de Serviço Eletrônica).
 *
 * NFS-e NÃO tem leiaute único no Brasil — cada prefeitura historicamente
 * definiu o seu. Este parser cobre os dois padrões que respondem pela
 * maioria dos casos reais:
 *
 * 1) PADRÃO NACIONAL DA NFS-e (Sistema Nacional NFS-e / Convênio NFS-e,
 *    Ambiente de Dados Nacional — ADN). Raiz `<NFSe><infNFSe>`, com o grupo
 *    `DPS` (Declaração de Prestação de Serviços) aninhado dentro de
 *    `infNFSe`. É o padrão para o qual os municípios estão migrando.
 *
 *    Confirmado nos esquemas XSD oficiais baixados de
 *    https://www.gov.br/nfse/pt-br/biblioteca/documentacao-tecnica/documentacao-atual
 *    — pacote "NFSe-ESQUEMAS_XSD", **versão 1.01, publicado em 09/02/2026**
 *    (arquivos `NFSe_v1.01.xsd` + `tiposComplexos_v1.01.xsd` +
 *    `tiposSimples_v1.01.xsd` + `evento_v1.01.xsd`). Baixado e inspecionado
 *    nesta sessão (06/08/2026) via PowerShell `Invoke-WebRequest`
 *    (`WebFetch` só devolve resumo em prosa da página HTML, não o
 *    conteúdo do .zip — por isso o download foi feito por fora).
 *
 *    Fato estrutural relevante: o cancelamento de uma NFS-e do Padrão
 *    Nacional NÃO fica dentro do XML da própria NFS-e — é um documento
 *    separado, o "evento" (`<evento><infEvento><pedRegEvento>`, tipo
 *    `e101101` para cancelamento simples e `e105102` para cancelamento por
 *    substituição — `tiposEventos_v1.01.xsd`). Este parser também reconhece
 *    esse documento de evento quando ele é enviado isoladamente, mas o
 *    registro resultante é degenerado (só a chave da NFS-e cancelada — sem
 *    prestador, tomador ou valores, que só existem no XML original da NFS-e).
 *
 * 2) ABRASF (Associação Brasileira das Secretarias de Finanças das
 *    Capitais), versões 1.00 e 2.0x. Raiz `<CompNfse><Nfse><InfNfse>` (ou
 *    `<Nfse>` solto, sem o envelope `CompNfse`, em exportações avulsas de
 *    algumas prefeituras). Ainda é o leiaute usado pela maioria dos
 *    municípios que não migraram ao Padrão Nacional, com variações locais
 *    de prefeitura para prefeitura — o próprio manual da ABRASF é omisso em
 *    vários pontos (ex.: convenção de `Aliquota` como fração 0–1 ou como
 *    percentual 0–100 não é normatizada no XSD, ver comentário em
 *    `extractAbrasf`).
 *
 *    Confirmado nos esquemas XSD oficiais publicados pela própria ABRASF,
 *    baixados nesta sessão (06/08/2026) via PowerShell `Invoke-WebRequest`:
 *      - v1.00: https://abrasf.org.br/biblioteca/arquivos-publicos/xml-schema-nfse-v1
 *        (arquivo `nfse.xsd`; timestamp interno do zip: 30/09/2009 — a
 *        página não publica uma "data de versão" separada do arquivo)
 *      - v2.04: https://abrasf.org.br/biblioteca/arquivos-publicos/schema-nfse-v2-04
 *        (arquivo `schema nfse v2-04.xsd`; timestamp interno do zip:
 *        24/09/2018)
 *    As subversões 2.02/2.03 não foram baixadas separadamente. A estrutura
 *    núcleo usada aqui (`CompNfse`/`Nfse`/`InfNfse`/
 *    `DeclaracaoPrestacaoServico`/`Servico`/`Valores`) é estável entre as
 *    2.0x; campos administrativos que mudam de subversão para subversão e
 *    não são usados por este parser podem divergir — não verificado.
 *
 * Leiaute não reconhecido (nem Nacional nem ABRASF, ex.: prefeitura com
 * leiaute 100% proprietário fora dos dois padrões) NUNCA é adivinhado: vira
 * `errors` explícito listando as tags de topo encontradas no XML, para o
 * usuário confirmar manualmente o que é o arquivo.
 *
 * Estilo e tratamento de erro seguem `nfe-xml.ts` (mesma biblioteca
 * `fast-xml-parser`, mesma normalização via `dec()`/`Money`, erros e
 * warnings acumulados sem interromper o restante do lote). Duas diferenças
 * deliberadas em relação a `nfe-xml.ts`, declaradas aqui e no relatório de
 * importação:
 *
 *  - `parseNfseXml` recebe `Buffer` (não `string`). NF-e é normativamente
 *    UTF-8 (manual do contribuinte da NF-e exige), mas NFS-e municipal
 *    (ABRASF) não tem essa exigência e aparece com frequência em
 *    ISO-8859-1/Windows-1252. Decodificar o buffer como UTF-8 antes de
 *    chegar aqui corromperia acento silenciosamente — exatamente o erro que
 *    o protocolo da casa proíbe. Por isso a decodificação acontece dentro
 *    deste módulo, priorizando o `encoding=` declarado no próprio prólogo
 *    do XML e caindo para a detecção automática de `encoding.ts` quando o
 *    XML não declara.
 *  - Uma nota de serviço NÃO tem "chave de acesso" de 44 dígitos como
 *    NF-e. O Padrão Nacional tem uma chave própria de 50 dígitos (dentro do
 *    atributo `Id` de `infNFSe`, precedido do literal "NFS"); ABRASF não
 *    tem chave nenhuma — a identidade da nota é Número + Código de
 *    Verificação + Código do Município. `ParsedInvoice.accessKey` recebe a
 *    chave de 50 dígitos no Padrão Nacional e fica `undefined` em ABRASF
 *    (não é erro nem dado ausente por falha de extração — é a normalidade
 *    do leiaute).
 */

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false, // mantém como string; convertemos com num()
  parseAttributeValue: false,
  trimValues: true,
  removeNSPrefix: true,
});

/** Converte valor monetário/percentual do XML em Decimal — nunca em number. */
const num = dec;

/**
 * Limite de tamanho do XML — proteção contra arquivo hostil (zip bomb via
 * anexo trocado, arquivo gigante disfarçado de NFS-e). Uma NFS-e legítima,
 * mesmo com muitos anexos em Base64 em `xInfComp`/`OutrasInformacoes`, não
 * chega perto disso; arquivo maior é motivo para recusar e avisar, não para
 * tentar processar em memória.
 */
const MAX_XML_BYTES = 20 * 1024 * 1024;

function str(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

/** Garante array (fast-xml-parser retorna objeto único quando há 1 elemento). */
function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

/**
 * Busca recursiva por todas as ocorrências de uma tag em qualquer
 * profundidade da árvore já parseada. Necessário porque envelopes (SOAP,
 * lote de várias notas, wrapper específico de prefeitura) mudam de nome de
 * prefeitura para prefeitura, mas o nó que realmente importa (`CompNfse`,
 * `NFSe`, `Nfse`, `evento`) tem nome fixo pelo XSD — então em vez de
 * declarar cada envelope possível, procura-se pelo nó fixo onde quer que
 * ele esteja.
 */
function findAllByTag(
  node: unknown,
  tag: string,
  acc: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (node === null || node === undefined || typeof node !== "object") {
    return acc;
  }
  if (Array.isArray(node)) {
    for (const item of node) findAllByTag(item, tag, acc);
    return acc;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === tag) {
      for (const v of asArray(value as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
        if (v && typeof v === "object") acc.push(v as Record<string, unknown>);
      }
    } else {
      findAllByTag(value, tag, acc);
    }
  }
  return acc;
}

/**
 * Decodifica o buffer respeitando o `encoding=` declarado no prólogo do
 * próprio XML quando presente — o prólogo (`<?xml version="1.0"
 * encoding="..."?>`) é sempre ASCII puro, então dá para lê-lo com segurança
 * antes de saber o encoding real do restante do documento. Sem declaração
 * (ou com valor não reconhecido), cai para a detecção automática de
 * `encoding.ts` (UTF-8 estrito; se não for UTF-8 válido, Latin-1).
 */
function decodeXml(data: Buffer): DecodedText {
  const prolog = data.subarray(0, Math.min(200, data.length)).toString("latin1");
  const match = prolog.match(/encoding\s*=\s*["']([^"']+)["']/i);
  if (match) {
    const normalized = match[1].toLowerCase().replace(/[^a-z0-9]/g, "");
    if (normalized === "utf8") return decodeTextBuffer(data, "utf-8");
    if (
      normalized === "iso88591" ||
      normalized === "latin1" ||
      normalized === "windows1252" ||
      normalized === "cp1252"
    ) {
      return decodeTextBuffer(data, "latin1");
    }
  }
  return decodeTextBuffer(data);
}

/**
 * Campos que o layout de NFS-e traz e que `ParsedInvoice`/`ExtractedInvoice`
 * ainda não têm coluna própria (ver relatório de importação). Fica em
 * `raw`, com nome de campo explícito — nunca "joga o XML inteiro" ali.
 */
interface NfseRawIssqn {
  /** tribISSQN (Nacional, 1-4) ou ExigibilidadeISS (ABRASF, 1-7) — tabelas diferentes, código cru preservado. */
  tributacao?: string;
  baseCalculo?: Money;
  /**
   * Alíquota do ISSQN. No Padrão Nacional é sempre percentual (XSD
   * `TSDec1V2`: 1 dígito inteiro + 2 decimais, ex. "5.00" = 5%). Em ABRASF
   * o XSD (`tsAliquota`: 4 dígitos totais, 2 decimais) NÃO define se é
   * percentual ("5.00") ou fração ("0.05") — é uma das "variações locais"
   * citadas na tarefa; valor cru preservado, sem conversão inventada.
   */
  aliquota?: Money;
  valor?: Money;
  /** true = retido na fonte pelo tomador/intermediário; false = não retido; undefined = não informado. */
  retido?: boolean;
  /** Código cru de quem reteve (tpRetISSQN Nacional 1-3 / ResponsavelRetencao ABRASF 1-2). */
  tipoRetencao?: string;
}

interface NfseRawRetencoesFederais {
  pis?: Money;
  cofins?: Money;
  irrf?: Money;
  csll?: Money;
  /** Contribuição previdenciária retida (INSS). Nacional: vRetCP. ABRASF: ValorInss. */
  inss?: Money;
}

interface NfseRaw {
  layout: "nacional" | "nacional-evento" | "abrasf";
  layoutVersion?: string;
  /** Código de verificação da NFS-e (só existe em ABRASF; Nacional usa a chave em accessKey). */
  codigoVerificacao?: string;
  /** Código IBGE (7 dígitos) do município de prestação do serviço. */
  municipioPrestacaoIbge?: string;
  /** Código IBGE (7 dígitos) do município de incidência do ISSQN (pode divergir do de prestação — LC 116/2003). */
  municipioIncidenciaIbge?: string;
  /** Código do serviço na lista da LC 116/2003. Nacional: cTribNac (6 dígitos, item+subitem+desdobro). ABRASF: ItemListaServico ("01.07"). */
  codigoServicoLC116?: string;
  cnae?: string;
  discriminacao?: string;
  valorLiquido?: Money;
  issqn: NfseRawIssqn;
  retencoesFederais: NfseRawRetencoesFederais;
  /** Número/série do DPS que originou a NFS-e (Padrão Nacional só — não existe conceito equivalente em ABRASF). */
  dpsNumero?: string;
  dpsSerie?: string;
  /** cStat da NFS-e Nacional (100/102/103/107) — tipo de geração, NÃO indica cancelamento (ver cabeçalho do arquivo). */
  statusGeracao?: string;
  /** Inscrição municipal do prestador — sem coluna própria em ParsedInvoice. */
  prestadorIm?: string;
  /** Número da NFS-e que substituiu esta (ABRASF InfNfse.NfseSubstituida). */
  nfseSubstituidaPor?: string;
}

/** Extrai uma NFS-e do Padrão Nacional a partir do elemento `<NFSe>`. */
function extractNacional(
  nfseEl: Record<string, unknown>,
): ParsedInvoice | undefined {
  const infNFSe = nfseEl.infNFSe as Record<string, unknown> | undefined;
  if (!infNFSe) return undefined;

  const dps = infNFSe.DPS as Record<string, unknown> | undefined;
  const infDPS = dps?.infDPS as Record<string, unknown> | undefined;

  const prest = (infDPS?.prest ?? {}) as Record<string, unknown>;
  const toma = infDPS?.toma as Record<string, unknown> | undefined;
  const serv = (infDPS?.serv ?? {}) as Record<string, unknown>;
  const locPrest = (serv.locPrest ?? {}) as Record<string, unknown>;
  const cServ = (serv.cServ ?? {}) as Record<string, unknown>;

  const infValores = (infDPS?.valores ?? {}) as Record<string, unknown>;
  const vServPrest = (infValores.vServPrest ?? {}) as Record<string, unknown>;
  const trib = (infValores.trib ?? {}) as Record<string, unknown>;
  const tribMun = (trib.tribMun ?? {}) as Record<string, unknown>;
  const tribFed = (trib.tribFed ?? {}) as Record<string, unknown>;
  const piscofins = (tribFed.piscofins ?? {}) as Record<string, unknown>;

  const valoresNFSe = (infNFSe.valores ?? {}) as Record<string, unknown>;

  // Atributo Id = "NFS" + chave de 50 dígitos (TSChaveNFSe). Mesmo padrão de
  // prefixo fixo do "NFe" na chave de acesso da NF-e (ver nfe-xml.ts).
  const rawId = str(infNFSe["@_Id"]) ?? "";
  const accessKey = rawId.replace(/^NFS/i, "") || undefined;

  // dhEmi = emissão pelo contribuinte (equivalente ao dhEmi/dEmi da NF-e).
  // dhProc = validação/geração pelo Sefin Nacional (equivalente a dhRecbto)
  // — guardado em raw.statusGeracao/raw, não usado como issueDate.
  const issueRaw = str(infDPS?.dhEmi);
  const issueDate = issueRaw ? new Date(issueRaw) : undefined;

  const tpRetISSQN = str(tribMun.tpRetISSQN);
  const issRetido = tpRetISSQN === undefined ? undefined : tpRetISSQN !== "1";

  const description = str(cServ.xDescServ);

  const item: ParsedInvoiceItem = {
    lineNumber: 1,
    description,
    totalValue: num(vServPrest.vServ),
    pisValue: num(piscofins.vPis),
    cofinsValue: num(piscofins.vCofins),
  };

  const raw: NfseRaw = {
    layout: "nacional",
    layoutVersion: str(nfseEl["@_versao"]),
    municipioPrestacaoIbge: str(locPrest.cLocPrestacao),
    municipioIncidenciaIbge: str(infNFSe.cLocIncid),
    codigoServicoLC116: str(cServ.cTribNac),
    cnae: undefined, // Padrão Nacional (v1.01 confirmada) não tem campo de CNAE dedicado no grupo cServ.
    discriminacao: description,
    valorLiquido: num(valoresNFSe.vLiq),
    issqn: {
      tributacao: str(tribMun.tribISSQN),
      baseCalculo: num(valoresNFSe.vBC),
      aliquota: num(valoresNFSe.pAliqAplic) ?? num(tribMun.pAliq),
      valor: num(valoresNFSe.vISSQN),
      retido: issRetido,
      tipoRetencao: tpRetISSQN,
    },
    retencoesFederais: {
      pis: num(piscofins.vPis),
      cofins: num(piscofins.vCofins),
      irrf: num(tribFed.vRetIRRF),
      csll: num(tribFed.vRetCSLL),
      inss: num(tribFed.vRetCP),
    },
    dpsNumero: str(infDPS?.nDPS),
    dpsSerie: str(infDPS?.serie),
    statusGeracao: str(infNFSe.cStat),
    prestadorIm: str(prest.IM),
  };

  return {
    model: "NFSE",
    direction: "SAIDA", // sobrescrito pelo chamador de parseNfseXml logo depois
    accessKey,
    number: str(infNFSe.nNFSe),
    series: undefined, // Padrão Nacional não tem "série" da NFS-e final — só nDPS/serie do DPS de origem (guardados em raw).
    issueDate: issueDate && !isNaN(issueDate.getTime()) ? issueDate : undefined,
    emitCnpj: str(prest.CNPJ) ?? str(prest.CPF),
    emitName: str(prest.xNome),
    emitUf: undefined, // Padrão Nacional só traz código IBGE do município (cLocEmi) — sem UF explícita no XML; mapear IBGE→UF exigiria tabela externa não verificada nesta sessão.
    destDoc: toma ? str(toma.CNPJ) ?? str(toma.CPF) ?? str(toma.NIF) : undefined,
    destName: toma ? str(toma.xNome) : undefined,
    destUf: undefined,
    totalProducts: undefined, // não há "produtos" em nota de serviço.
    totalInvoice: num(valoresNFSe.vLiq),
    totalIcms: undefined,
    totalIcmsSt: undefined,
    totalIpi: undefined,
    totalPis: num(piscofins.vPis),
    totalCofins: num(piscofins.vCofins),
    totalFcp: undefined,
    items: [item],
    // cStat (100/102/103/107) é "tipo de geração", não indica cancelamento —
    // o cancelamento do Padrão Nacional é um documento separado (evento).
    // Por isso fica undefined aqui, igual ao NF-e em nfe-xml.ts: XML de nota
    // "aparentemente normal" não garante que ela não foi cancelada depois.
    situationCode: undefined,
    situationLabel: undefined,
    raw,
  };
}

/**
 * Extrai um registro degenerado a partir de um documento de EVENTO de
 * cancelamento do Padrão Nacional (`<evento><infEvento><pedRegEvento>`).
 * Só existem os campos que o evento realmente carrega: chave da NFS-e
 * cancelada e o tipo de cancelamento. Prestador, tomador, valores etc. só
 * existem no XML da NFS-e original — não estão aqui e não são inventados.
 */
function extractNacionalEvento(
  eventoEl: Record<string, unknown>,
): ParsedInvoice | undefined {
  const infEvento = eventoEl.infEvento as Record<string, unknown> | undefined;
  const pedRegEvento = infEvento?.pedRegEvento as Record<string, unknown> | undefined;
  const infPedReg = (pedRegEvento?.infPedReg ?? {}) as Record<string, unknown>;

  const chNFSe = str(infPedReg.chNFSe);
  if (!chNFSe) return undefined;

  const isCancelamentoSimples = infPedReg.e101101 !== undefined;
  const isCancelamentoSubstituicao = infPedReg.e105102 !== undefined;
  if (!isCancelamentoSimples && !isCancelamentoSubstituicao) return undefined;

  return {
    model: "NFSE",
    direction: "SAIDA", // sobrescrito pelo chamador
    accessKey: chNFSe,
    number: undefined,
    series: undefined,
    issueDate: undefined,
    emitCnpj: undefined,
    emitName: undefined,
    emitUf: undefined,
    destDoc: undefined,
    destName: undefined,
    destUf: undefined,
    totalProducts: undefined,
    totalInvoice: undefined,
    totalIcms: undefined,
    totalIcmsSt: undefined,
    totalIpi: undefined,
    totalPis: undefined,
    totalCofins: undefined,
    totalFcp: undefined,
    items: [],
    situationCode: isCancelamentoSubstituicao ? "SUBSTITUIDA" : "02",
    situationLabel: isCancelamentoSubstituicao
      ? "NFS-e cancelada por substituição (evento e105102)"
      : "Documento cancelado",
    raw: {
      layout: "nacional-evento",
      layoutVersion: str(eventoEl["@_versao"]),
      issqn: {},
      retencoesFederais: {},
    } satisfies NfseRaw,
  };
}

/**
 * Extrai uma NFS-e ABRASF a partir do nó `{ Nfse, NfseCancelamento?,
 * NfseSubstituicao? }` — que é exatamente a forma de `CompNfse` (v1.00 e
 * 2.0x), inclusive quando montado artificialmente por quem chama para o
 * caso de `<Nfse>` solto sem envelope `CompNfse`.
 *
 * CNPJ do prestador e dados do tomador moram em lugares diferentes conforme
 * a versão do leiaute:
 *  - v1.00: tudo direto em `InfNfse` (`PrestadorServico.IdentificacaoPrestador.Cnpj`,
 *    `TomadorServico`, `Servico` — confirmado em `nfse.xsd`, tipos
 *    `tcInfNfse`/`tcIdentificacaoPrestador`/`tcValores`).
 *  - v2.0x: `InfNfse.PrestadorServico` só tem razão social/endereço; CNPJ,
 *    tomador e serviço declarado moram em
 *    `InfNfse.DeclaracaoPrestacaoServico.InfDeclaracaoPrestacaoServico`
 *    (confirmado em `schema nfse v2-04.xsd`, tipos
 *    `tcInfNfse`/`tcInfDeclaracaoPrestacaoServico`/`tcIdentificacaoPessoaEmpresa`).
 * A extração tenta o caminho 2.0x primeiro e cai para o 1.00 quando ausente.
 */
function extractAbrasf(
  compNfse: Record<string, unknown>,
): ParsedInvoice | undefined {
  const nfseEl = compNfse.Nfse as Record<string, unknown> | undefined;
  if (!nfseEl) return undefined;
  const infNfse = nfseEl.InfNfse as Record<string, unknown> | undefined;
  if (!infNfse) return undefined;

  const declPS = infNfse.DeclaracaoPrestacaoServico as
    | Record<string, unknown>
    | undefined;
  const infDecl = (declPS?.InfDeclaracaoPrestacaoServico ?? {}) as Record<
    string,
    unknown
  >;

  // Servico: 2.0x mora dentro de InfDeclaracaoPrestacaoServico; 1.00 mora direto em InfNfse.
  const servico = (infDecl.Servico ?? infNfse.Servico ?? {}) as Record<
    string,
    unknown
  >;
  const valoresServ = (servico.Valores ?? {}) as Record<string, unknown>;
  // ValoresNfse só existe em 2.0x (totais já validados pelo órgão gerador).
  const valoresNfseTop = (infNfse.ValoresNfse ?? {}) as Record<string, unknown>;

  // Prestador — CNPJ.
  const prestadorDecl = infDecl.Prestador as Record<string, unknown> | undefined; // 2.0x: tcIdentificacaoPessoaEmpresa
  const prestadorInfoNfse = (infNfse.PrestadorServico ?? {}) as Record<
    string,
    unknown
  >;
  const identifPrestador1_00 = (prestadorInfoNfse.IdentificacaoPrestador ??
    {}) as Record<string, unknown>;
  const cpfCnpjPrestadorDecl = (prestadorDecl?.CpfCnpj ?? {}) as Record<
    string,
    unknown
  >;
  const emitCnpj =
    str(cpfCnpjPrestadorDecl.Cnpj) ??
    str(cpfCnpjPrestadorDecl.Cpf) ??
    str(identifPrestador1_00.Cnpj);
  const emitIm =
    str(prestadorDecl?.InscricaoMunicipal) ??
    str(identifPrestador1_00.InscricaoMunicipal);
  const emitEndereco = (prestadorInfoNfse.Endereco ?? {}) as Record<
    string,
    unknown
  >;

  // Tomador — 2.0x mora dentro de InfDeclaracaoPrestacaoServico; 1.00 mora direto em InfNfse.
  const tomador = (infDecl.TomadorServico ?? infNfse.TomadorServico) as
    | Record<string, unknown>
    | undefined;
  const identifTomador = (tomador?.IdentificacaoTomador ?? {}) as Record<
    string,
    unknown
  >;
  // 2.0x: IdentificacaoTomador.CpfCnpj.{Cnpj|Cpf}. 1.00: idem (tcIdentificacaoTomador também usa CpfCnpj).
  const cpfCnpjTomador = (identifTomador.CpfCnpj ?? {}) as Record<
    string,
    unknown
  >;
  const tomadorEndereco = (tomador?.Endereco ?? {}) as Record<string, unknown>;

  const orgaoGerador = (infNfse.OrgaoGerador ?? {}) as Record<string, unknown>;

  const issRetidoRaw = str(servico.IssRetido) ?? str(valoresServ.IssRetido);
  const issRetido = issRetidoRaw === undefined ? undefined : issRetidoRaw === "1";

  const discriminacao = str(servico.Discriminacao);

  const item: ParsedInvoiceItem = {
    lineNumber: 1,
    description: discriminacao,
    totalValue: num(valoresServ.ValorServicos),
    pisValue: num(valoresServ.ValorPis),
    cofinsValue: num(valoresServ.ValorCofins),
  };

  const issueRaw = str(infNfse.DataEmissao);
  const issueDate = issueRaw ? new Date(issueRaw) : undefined;

  const cancelada = compNfse.NfseCancelamento !== undefined;
  const substituida = !cancelada && compNfse.NfseSubstituicao !== undefined;

  const valorLiquido =
    num(valoresNfseTop.ValorLiquidoNfse) ?? num(valoresServ.ValorLiquidoNfse);

  const raw: NfseRaw = {
    layout: "abrasf",
    layoutVersion: str(nfseEl["@_versao"]),
    codigoVerificacao: str(infNfse.CodigoVerificacao),
    municipioPrestacaoIbge: str(servico.CodigoMunicipio),
    municipioIncidenciaIbge: str(servico.MunicipioIncidencia),
    codigoServicoLC116: str(servico.ItemListaServico),
    cnae: str(servico.CodigoCnae),
    discriminacao,
    valorLiquido,
    issqn: {
      tributacao: str(servico.ExigibilidadeISS),
      baseCalculo:
        num(valoresNfseTop.BaseCalculo) ?? num(valoresServ.BaseCalculo),
      aliquota: num(valoresNfseTop.Aliquota) ?? num(valoresServ.Aliquota),
      valor: num(valoresNfseTop.ValorIss) ?? num(valoresServ.ValorIss),
      retido: issRetido,
      tipoRetencao: str(servico.ResponsavelRetencao),
    },
    retencoesFederais: {
      pis: num(valoresServ.ValorPis),
      cofins: num(valoresServ.ValorCofins),
      irrf: num(valoresServ.ValorIr),
      csll: num(valoresServ.ValorCsll),
      inss: num(valoresServ.ValorInss),
    },
    prestadorIm: emitIm,
    nfseSubstituidaPor: str(infNfse.NfseSubstituida),
  };

  return {
    model: "NFSE",
    direction: "SAIDA", // sobrescrito pelo chamador de parseNfseXml logo depois
    accessKey: undefined, // ABRASF não tem chave de acesso — identidade é Número + CódigoVerificacao + CódigoMunicipio (ver cabeçalho do arquivo).
    number: str(infNfse.Numero),
    series: undefined,
    issueDate: issueDate && !isNaN(issueDate.getTime()) ? issueDate : undefined,
    emitCnpj,
    emitName: str(prestadorInfoNfse.RazaoSocial),
    emitUf: str(emitEndereco.Uf) ?? str(orgaoGerador.Uf),
    destDoc: str(cpfCnpjTomador.Cnpj) ?? str(cpfCnpjTomador.Cpf),
    destName: str(tomador?.RazaoSocial),
    destUf: str(tomadorEndereco.Uf),
    totalProducts: undefined,
    totalInvoice: valorLiquido,
    totalIcms: undefined,
    totalIcmsSt: undefined,
    totalIpi: undefined,
    totalPis: num(valoresServ.ValorPis),
    totalCofins: num(valoresServ.ValorCofins),
    totalFcp: undefined,
    items: [item],
    situationCode: cancelada ? "02" : substituida ? "SUBSTITUIDA" : "00",
    situationLabel: cancelada
      ? "Documento cancelado"
      : substituida
        ? "NFS-e substituída por outra nota"
        : "Documento regular",
    raw,
  };
}

/**
 * @param data Buffer bruto do arquivo XML (não pré-decodificado — ver
 *   cabeçalho do arquivo sobre por que este parser decide o encoding).
 * @param direction ENTRADA (nota tomada, ex. importação de serviço) ou
 *   SAIDA (nota emitida pela empresa como prestadora). O layout de NFS-e
 *   não distingue isso estruturalmente — quem decide é o chamador, mesmo
 *   contrato de `parseNfeXml`.
 */
export function parseNfseXml(
  data: Buffer,
  direction: "ENTRADA" | "SAIDA",
): ExtractionResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (data.length > MAX_XML_BYTES) {
    return {
      parser: "nfse-xml",
      invoices: [],
      warnings,
      errors: [
        `Arquivo com ${data.length} bytes excede o limite de ${MAX_XML_BYTES} bytes para um único XML de NFS-e — recusado por segurança (proteção contra arquivo hostil/zip bomb). Envie em blocos ou confirme se o arquivo é mesmo uma NFS-e.`,
      ],
      apuracoes: [],
    };
  }

  const decoded = decodeXml(data);
  warnings.push(
    decoded.forced
      ? `Codificação informada no XML: ${decoded.encoding}.`
      : `Codificação detectada: ${decoded.encoding}.`,
  );

  // Proteção contra XXE/expansão de entidade: NFS-e não usa DOCTYPE/ENTITY
  // em nenhum dos dois padrões cobertos — presença é sinal de arquivo
  // hostil, não de variação de leiaute legítima.
  if (/<!DOCTYPE|<!ENTITY/i.test(decoded.text)) {
    return {
      parser: "nfse-xml",
      invoices: [],
      warnings,
      errors: [
        "XML recusado: declaração de DOCTYPE/ENTITY não é permitida (proteção contra XXE/entidade externa).",
      ],
      apuracoes: [],
    };
  }

  // fast-xml-parser é tolerante por padrão: `parse()` não lança exceção para
  // XML malformado (tag não fechada, aninhamento quebrado etc.), ele só
  // devolve uma árvore incompleta silenciosamente. Por isso a validação
  // estrutural é feita à parte, com `XMLValidator`, antes de extrair
  // qualquer campo — sem isso um XML truncado geraria "leiaute não
  // reconhecido" em vez do erro real.
  const validation = XMLValidator.validate(decoded.text);
  if (validation !== true) {
    return {
      parser: "nfse-xml",
      invoices: [],
      warnings,
      errors: [`XML inválido: ${validation.err.msg} (linha ${validation.err.line}).`],
      apuracoes: [],
    };
  }

  let root: Record<string, unknown>;
  try {
    root = xmlParser.parse(decoded.text) as Record<string, unknown>;
  } catch (e) {
    return {
      parser: "nfse-xml",
      invoices: [],
      warnings,
      errors: [`XML inválido: ${(e as Error).message}`],
      apuracoes: [],
    };
  }

  const invoices: ParsedInvoice[] = [];

  // --- Padrão Nacional: <NFSe><infNFSe>...
  const nacionalNodes = findAllByTag(root, "NFSe");
  for (const nfseEl of nacionalNodes) {
    const invoice = extractNacional(nfseEl);
    if (!invoice) {
      warnings.push("Elemento NFSe encontrado sem infNFSe — ignorado.");
      continue;
    }
    invoice.direction = direction;
    if (!invoice.emitCnpj) {
      warnings.push(
        `NFS-e ${invoice.number ?? "(sem número)"}: CNPJ/CPF do prestador ausente.`,
      );
    }
    invoices.push(invoice);
  }

  // --- Padrão Nacional: evento de cancelamento (documento separado da NFS-e).
  const eventoNodes = findAllByTag(root, "evento");
  for (const eventoEl of eventoNodes) {
    const invoice = extractNacionalEvento(eventoEl);
    if (!invoice) continue;
    invoice.direction = direction;
    warnings.push(
      `Evento de cancelamento (chave ${invoice.accessKey}) extraído a partir de arquivo de evento — dados completos da nota (prestador, tomador, valores) não estão neste documento; eles só existem no XML da NFS-e original.`,
    );
    invoices.push(invoice);
  }

  // --- ABRASF: <CompNfse><Nfse>...
  const compNodes = findAllByTag(root, "CompNfse");
  for (const comp of compNodes) {
    const invoice = extractAbrasf(comp);
    if (!invoice) {
      warnings.push("Elemento CompNfse encontrado sem Nfse/InfNfse — ignorado.");
      continue;
    }
    invoice.direction = direction;
    if (!invoice.emitCnpj) {
      warnings.push(
        `NFS-e ${invoice.number ?? "(sem número)"}: CNPJ/CPF do prestador ausente.`,
      );
    }
    invoices.push(invoice);
  }

  // --- ABRASF sem envelope CompNfse (<Nfse> solto). Só tentado quando não
  // achou nem CompNfse nem NFSe do Padrão Nacional, para não duplicar nota
  // nem confundir os dois padrões num mesmo arquivo.
  if (compNodes.length === 0 && nacionalNodes.length === 0) {
    const bareNfseNodes = findAllByTag(root, "Nfse");
    for (const nfseEl of bareNfseNodes) {
      const invoice = extractAbrasf({ Nfse: nfseEl });
      if (!invoice) continue;
      invoice.direction = direction;
      warnings.push(
        "Nfse sem envelope CompNfse — cancelamento/substituição não podem ser confirmados a partir deste arquivo isolado (essa informação vive nos irmãos NfseCancelamento/NfseSubstituicao de CompNfse).",
      );
      if (!invoice.emitCnpj) {
        warnings.push(
          `NFS-e ${invoice.number ?? "(sem número)"}: CNPJ/CPF do prestador ausente.`,
        );
      }
      invoices.push(invoice);
    }
  }

  if (invoices.length === 0 && errors.length === 0) {
    // "?xml" é o prólogo (fast-xml-parser expõe como chave própria) — não é
    // tag de leiaute, então não entra na lista mostrada ao usuário.
    const topTags = Object.keys(root).filter((k) => k !== "?xml");
    errors.push(
      `Leiaute de NFS-e não reconhecido (nem Padrão Nacional nem ABRASF 1.0/2.0x). Município/leiaute não suportado. Tags de topo encontradas no XML: ${
        topTags.length ? topTags.join(", ") : "(nenhuma — XML vazio ou só com prólogo)"
      }.`,
    );
  }

  return { parser: "nfse-xml", invoices, warnings, errors, apuracoes: [] };
}

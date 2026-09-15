import { XMLParser } from "fast-xml-parser";
import { Prisma } from "@prisma/client";
import { decodeTextBuffer } from "./encoding";

/**
 * Parser do XML de apuração de débitos da DCTF (MIT — Módulo de Inclusão de
 * Tributos).
 *
 * É o arquivo que o sistema do contribuinte gera para transmitir a apuração
 * mensal: raiz `<ApuracaoDebitosDctf>`, com a identificação do contribuinte,
 * o período de apuração e a lista de débitos confessados por código de receita.
 *
 * O que ele vale para a auditoria: é o lado CONFESSADO do confronto
 * "apurado × confessado × pago" da família A. A escrituração diz quanto a
 * empresa apurou; este arquivo diz quanto ela assumiu perante a Receita. A
 * diferença entre os dois é achado — e quando a DCTF confessa, o débito é
 * exigível sem lançamento, o que muda o discurso na reunião: não é risco de
 * autuação, é dívida líquida e certa.
 *
 * Estrutura relevante (confirmada no arquivo real de um contribuinte):
 *
 *   <ApuracaoDebitosDctf>
 *     <DadosIdentificadoresContribuinte>
 *       <inscContrib>CNPJ</inscContrib>
 *       <perApuracao>MMAAAA</perApuracao>
 *     </DadosIdentificadoresContribuinte>
 *     <DebitosApurados>
 *       <DebitoApurado>
 *         <codTrib>512301</codTrib>   6 dígitos: 4 do código de receita + 2 da extensão
 *         <ctValor>2795.48</ctValor>  ponto decimal, não vírgula
 *         <paDebito>MMAAAA</paDebito> período do débito, que pode diferir do da apuração
 *       </DebitoApurado>
 *     </DebitosApurados>
 *   </ApuracaoDebitosDctf>
 *
 * Um cuidado que o leiaute impõe: `paDebito` existe por débito e nem sempre é
 * igual ao `perApuracao` do cabeçalho — há débito de período anterior incluído
 * numa apuração posterior. A competência gravada é sempre a do próprio débito;
 * usar a do cabeçalho jogaria o valor no mês errado do confronto.
 */

/** Nome do tributo por código de receita (4 primeiros dígitos do codTrib). */
const NOME_POR_CODIGO: Record<string, string> = {
  // Confirmados na tabela de códigos da DCTF publicada pela Receita Federal
  // (gov.br/receitafederal — Declarações e Demonstrativos › DCTF › Tabelas de
  // Códigos/Extensões).
  "5123": "IPI", // 5123/01 — IPI, demais produtos
  "5110": "IPI", // 5110/01 — charutos, cigarrilhas e cigarros sem tabaco
  "0668": "IPI",
  "0676": "IPI",
  "1097": "IPI",
  "6912": "PIS", // não cumulativo
  "8109": "PIS", // cumulativo
  "5856": "COFINS", // não cumulativa
  "2172": "COFINS", // cumulativa
};

export interface DebitoConfessado {
  /** "2025-06" — do `paDebito` do próprio débito, não do cabeçalho. */
  competencia: string;
  /** "IPI", "PIS", "COFINS" — ou "Código NNNN" quando não mapeado. */
  tributo: string;
  /** Os 6 dígitos como vieram no arquivo. */
  codigoReceita: string;
  valor: Prisma.Decimal;
}

export interface ApuracaoDctf {
  cnpj?: string;
  /** Competência do cabeçalho — "2025-06". */
  competencia?: string;
  debitos: DebitoConfessado[];
  total: Prisma.Decimal;
  avisos: string[];
}

/** Reconhece o arquivo pelo elemento raiz, antes de tentar interpretá-lo. */
export function ehApuracaoDctf(texto: string): boolean {
  return /<\s*ApuracaoDebitosDctf[\s>]/i.test(texto);
}

/** "062025" → "2025-06". Devolve `undefined` no que não tiver esse formato. */
function paraCompetencia(periodo: string | undefined): string | undefined {
  if (!periodo) return undefined;
  const limpo = String(periodo).trim();
  const m = /^(\d{2})(\d{4})$/.exec(limpo);
  if (!m) return undefined;
  const [, mes, ano] = m;
  if (Number(mes) < 1 || Number(mes) > 12) return undefined;
  return `${ano}-${mes}`;
}

/** O valor vem com ponto decimal, no formato do XML — nunca no do Brasil. */
function valor(v: unknown): Prisma.Decimal | null {
  if (v === undefined || v === null || v === "") return null;
  const texto = String(v).trim();
  if (!/^-?\d+(\.\d+)?$/.test(texto)) return null;
  return new Prisma.Decimal(texto);
}

function nomeDoTributo(codTrib: string): string {
  const receita = codTrib.slice(0, 4);
  // Código não mapeado não vira "outros": o número é o que permite ao auditor
  // conferir na tabela da Receita, e apagá-lo esconderia o débito.
  return NOME_POR_CODIGO[receita] ?? `Código ${receita}`;
}

function comoLista<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseApuracaoDctf(buffer: Buffer): ApuracaoDctf | null {
  const { text } = decodeTextBuffer(buffer);
  if (!ehApuracaoDctf(text)) return null;

  const avisos: string[] = [];

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false, // tudo como string: o valor vira Decimal à mão
    trimValues: true,
  });

  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(text) as Record<string, unknown>;
  } catch (e) {
    return {
      debitos: [],
      total: new Prisma.Decimal(0),
      avisos: [`XML malformado: ${(e as Error).message}`],
    };
  }

  const raiz = doc["ApuracaoDebitosDctf"] as Record<string, unknown> | undefined;
  if (!raiz) return null;

  const ident = raiz["DadosIdentificadoresContribuinte"] as
    | Record<string, unknown>
    | undefined;

  const cnpjBruto = ident?.["inscContrib"];
  const cnpj = cnpjBruto ? String(cnpjBruto).replace(/\D/g, "") : undefined;
  if (cnpj && cnpj.length !== 14) {
    avisos.push(
      `Inscrição do contribuinte com ${cnpj.length} dígitos — esperado CNPJ de 14.`,
    );
  }

  const competencia = paraCompetencia(ident?.["perApuracao"] as string | undefined);
  if (!competencia) {
    avisos.push("Período de apuração ausente ou fora do formato MMAAAA.");
  }

  const grupo = raiz["DebitosApurados"] as Record<string, unknown> | undefined;
  const lista = comoLista(
    grupo?.["DebitoApurado"] as Record<string, unknown>[] | undefined,
  );

  const debitos: DebitoConfessado[] = [];
  let total = new Prisma.Decimal(0);

  for (const d of lista) {
    const codTrib = d["codTrib"] ? String(d["codTrib"]).trim() : "";
    const v = valor(d["ctValor"]);

    if (!codTrib) {
      avisos.push("Débito sem código de tributo — ignorado.");
      continue;
    }
    if (v === null) {
      avisos.push(`Débito do código ${codTrib} sem valor legível — ignorado.`);
      continue;
    }

    // A competência do débito manda. Sem `paDebito`, cai na do cabeçalho.
    const doDebito =
      paraCompetencia(d["paDebito"] as string | undefined) ?? competencia;
    if (!doDebito) {
      avisos.push(
        `Débito do código ${codTrib} sem competência identificável — ignorado.`,
      );
      continue;
    }
    if (competencia && doDebito !== competencia) {
      avisos.push(
        `Débito do código ${codTrib} é do período ${doDebito}, diferente da ` +
          `apuração de ${competencia} — gravado na competência do débito.`,
      );
    }

    debitos.push({
      competencia: doDebito,
      tributo: nomeDoTributo(codTrib),
      codigoReceita: codTrib,
      valor: v,
    });
    total = total.plus(v);
  }

  if (debitos.length === 0) {
    avisos.push("Nenhum débito confessado neste arquivo.");
  }

  const naoMapeados = [
    ...new Set(
      debitos
        .filter((d) => d.tributo.startsWith("Código "))
        .map((d) => d.codigoReceita),
    ),
  ];
  if (naoMapeados.length > 0) {
    avisos.push(
      `Código(s) de receita sem nome no sistema: ${naoMapeados.join(", ")}. ` +
        `O valor foi gravado; confira o tributo na tabela da DCTF.`,
    );
  }

  return { cnpj, competencia, debitos, total, avisos };
}

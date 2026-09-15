import { NextResponse } from "next/server";
import { processarAuditoria } from "@/server/processamento/processar";
import { auditar } from "@/server/auditoria/motor";

export const runtime = "nodejs";
// Cinco anos de XMLs levam minutos, não segundos.
export const maxDuration = 900;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  const url = new URL(req.url);
  // ?reprocessar=1 relê também os documentos já concluídos — o caminho para
  // refazer a extração depois de corrigir um parser.
  const reprocessarTudo = url.searchParams.get("reprocessar") === "1";
  // ?somenteAuditar=1 pula a extração e só reexecuta as regras. Útil quando o
  // catálogo mudou mas os arquivos são os mesmos.
  const somenteAuditar = url.searchParams.get("somenteAuditar") === "1";

  try {
    const extracao = somenteAuditar
      ? null
      : await processarAuditoria(params.id, { reprocessarTudo });

    // A auditoria roda sempre em seguida: o usuário quer o diagnóstico, não a
    // extração. Separar em dois cliques só adiaria o resultado.
    const auditoria = await auditar(params.id);

    return NextResponse.json({ extracao, auditoria });
  } catch (e) {
    return NextResponse.json({ erro: (e as Error).message }, { status: 400 });
  }
}

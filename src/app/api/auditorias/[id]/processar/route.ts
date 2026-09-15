import { NextResponse } from "next/server";
import { processarAuditoria } from "@/server/processamento/processar";

export const runtime = "nodejs";
// Cinco anos de XMLs levam minutos, não segundos.
export const maxDuration = 900;

export async function POST(
  req: Request,
  { params }: { params: { id: string } },
) {
  // ?reprocessar=1 relê também os documentos já concluídos — o caminho para
  // refazer a extração depois de corrigir um parser.
  const reprocessarTudo =
    new URL(req.url).searchParams.get("reprocessar") === "1";

  try {
    const resultado = await processarAuditoria(params.id, { reprocessarTudo });
    return NextResponse.json(resultado);
  } catch (e) {
    return NextResponse.json({ erro: (e as Error).message }, { status: 400 });
  }
}

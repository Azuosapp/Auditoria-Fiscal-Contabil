import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { solicitarAnaliseIa } from "@/server/claude/analise";

export const runtime = "nodejs";

/** Rodar de novo, sob demanda — para quando a automática falhou ou bateu no teto. */
export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const existe = await prisma.auditoria.count({ where: { id: params.id } });
  if (!existe) {
    return NextResponse.json({ erro: "Auditoria não encontrada." }, { status: 404 });
  }
  const situacao = await solicitarAnaliseIa(params.id);
  return NextResponse.json({ situacao });
}

/** Estado da última rodada, para a tela acompanhar sem recarregar tudo. */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const ultima = await prisma.analiseIa.findFirst({
    where: { auditoriaId: params.id },
    orderBy: { iniciadaEm: "desc" },
    select: { id: true, status: true, iniciadaEm: true, concluidaEm: true },
  });
  return NextResponse.json({ ultima });
}

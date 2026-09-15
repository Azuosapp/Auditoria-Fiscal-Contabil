import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Exclusão da empresa e de tudo que pende dela.
 *
 * Apaga as auditorias, os documentos e os arquivos do cliente em disco. É a
 * ação mais destrutiva do sistema e por isso exige o CNPJ como confirmação no
 * corpo da requisição — clicar errado numa lista não pode custar cinco anos de
 * trabalho importado.
 */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  const empresa = await prisma.empresa.findUnique({
    where: { id: params.id },
    include: {
      auditorias: {
        select: { id: true, documentos: { select: { caminho: true } } },
      },
    },
  });
  if (!empresa) {
    return NextResponse.json({ erro: "Empresa não encontrada." }, { status: 404 });
  }

  let confirmacao: string | undefined;
  try {
    confirmacao = (await req.json())?.cnpj;
  } catch {
    confirmacao = undefined;
  }

  if ((confirmacao ?? "").replace(/\D/g, "") !== empresa.cnpj) {
    return NextResponse.json(
      {
        erro:
          "Confirme o CNPJ da empresa para excluir. Esta ação apaga as " +
          "auditorias, os documentos e os arquivos importados.",
      },
      { status: 400 },
    );
  }

  const pastas = new Set(
    empresa.auditorias
      .flatMap((a) => a.documentos.map((d) => d.caminho))
      .map((c) => c.replace(/[\\/][^\\/]*$/, ""))
      .filter((p) => p.includes("lotes")),
  );

  const naoApagadas: string[] = [];
  for (const pasta of pastas) {
    try {
      await rm(pasta, { recursive: true, force: true });
    } catch (e) {
      naoApagadas.push(`${pasta}: ${(e as Error).message}`);
    }
  }

  await prisma.empresa.delete({ where: { id: params.id } });

  return NextResponse.json({
    excluida: empresa.razaoSocial,
    auditorias: empresa.auditorias.length,
    pastasRemovidas: pastas.size - naoApagadas.length,
    naoApagadas,
  });
}

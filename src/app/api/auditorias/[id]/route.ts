import { rm } from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

/**
 * Exclusão de dados da auditoria.
 *
 * Três escopos, do mais leve ao mais pesado:
 *
 *   ?escopo=achados     apaga só o resultado das regras (achados e lacunas)
 *   ?escopo=extracao    apaga o que foi extraído dos arquivos, mantendo-os
 *   ?escopo=tudo        apaga a auditoria inteira, com documentos e arquivos
 *
 * A separação existe porque os três significam coisas diferentes no trabalho:
 * refazer a análise, reler os arquivos, ou desfazer a importação.
 */
export async function DELETE(
  req: Request,
  { params }: { params: { id: string } },
) {
  const escopo = new URL(req.url).searchParams.get("escopo") ?? "tudo";

  const auditoria = await prisma.auditoria.findUnique({
    where: { id: params.id },
    include: { documentos: { select: { caminho: true } } },
  });
  if (!auditoria) {
    return NextResponse.json({ erro: "Auditoria não encontrada." }, { status: 404 });
  }

  if (escopo === "achados") {
    const [achados, lacunas] = await prisma.$transaction([
      prisma.achado.deleteMany({ where: { auditoriaId: params.id } }),
      prisma.lacuna.deleteMany({ where: { auditoriaId: params.id } }),
    ]);
    return NextResponse.json({
      escopo,
      achados: achados.count,
      lacunas: lacunas.count,
    });
  }

  if (escopo === "extracao") {
    const ondeDoc = { documento: { auditoriaId: params.id } };
    await prisma.$transaction([
      prisma.achado.deleteMany({ where: { auditoriaId: params.id } }),
      prisma.lacuna.deleteMany({ where: { auditoriaId: params.id } }),
      prisma.notaFiscal.deleteMany({ where: ondeDoc }),
      prisma.eventoNfe.deleteMany({ where: ondeDoc }),
      prisma.apuracaoFiscal.deleteMany({ where: ondeDoc }),
      prisma.apuracaoContribuicoes.deleteMany({ where: ondeDoc }),
      prisma.apuracaoSimples.deleteMany({ where: ondeDoc }),
      prisma.pendenciaFiscal.deleteMany({ where: ondeDoc }),
      prisma.retratoSituacaoFiscal.deleteMany({ where: ondeDoc }),
      // Os documentos voltam para a fila: os arquivos continuam em disco.
      prisma.documento.updateMany({
        where: { auditoriaId: params.id },
        data: { status: "PENDENTE", registrosExtraidos: 0, processadoEm: null },
      }),
      prisma.auditoria.update({
        where: { id: params.id },
        data: {
          status: "IMPORTANDO",
          executadaEm: null,
          totalDebitoAberto: null,
          totalRiscoAutuacao: null,
          totalRecuperavel: null,
        },
      }),
    ]);
    return NextResponse.json({ escopo, ok: true });
  }

  if (escopo !== "tudo") {
    return NextResponse.json(
      { erro: `Escopo inválido: ${escopo}. Use achados, extracao ou tudo.` },
      { status: 400 },
    );
  }

  // As pastas de lote são apagadas ANTES do registro: se algo falhar aqui, o
  // registro ainda aponta para elas e a limpeza pode ser repetida. Na ordem
  // inversa, o arquivo ficaria órfão no disco sem ninguém para encontrá-lo.
  const pastas = new Set(
    auditoria.documentos
      .map((d) => d.caminho.replace(/[\\/][^\\/]*$/, ""))
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

  // O cascade do banco leva documentos, notas, apurações, achados e lacunas.
  await prisma.auditoria.delete({ where: { id: params.id } });

  return NextResponse.json({
    escopo,
    pastasRemovidas: pastas.size - naoApagadas.length,
    naoApagadas,
  });
}

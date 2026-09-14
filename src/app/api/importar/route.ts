import { mkdir, writeFile } from "node:fs/promises";
import { join, basename } from "node:path";
import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { analisarLote, type ArquivoRecebido } from "@/server/importacao/analisar";

/**
 * Recebe o lote, guarda os arquivos e devolve a análise — SEM criar empresa
 * nem auditoria ainda.
 *
 * Os arquivos são gravados aqui porque a confirmação vem numa segunda chamada:
 * pedir de novo o upload de 5 anos de XMLs só para confirmar o CNPJ seria
 * inviável em qualquer conexão de escritório.
 */

export const runtime = "nodejs";
// Auditoria de 5 anos chega em pacotes grandes; o padrão do App Router é curto.
export const maxDuration = 300;

/** Teto por requisição. Acima disso, o usuário divide o envio em partes. */
const MAX_BYTES = 500 * 1024 * 1024;

export async function POST(req: Request) {
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    return NextResponse.json(
      { erro: `Não foi possível ler o envio: ${(e as Error).message}` },
      { status: 400 },
    );
  }

  const entradas = form.getAll("arquivos").filter((v): v is File => v instanceof File);

  if (entradas.length === 0) {
    return NextResponse.json({ erro: "Nenhum arquivo enviado." }, { status: 400 });
  }

  const total = entradas.reduce((s, f) => s + f.size, 0);
  if (total > MAX_BYTES) {
    return NextResponse.json(
      {
        erro:
          `O envio tem ${(total / 1024 / 1024).toFixed(0)} MB e o limite por vez ` +
          `é ${MAX_BYTES / 1024 / 1024} MB. Divida em partes.`,
      },
      { status: 413 },
    );
  }

  const recebidos: ArquivoRecebido[] = [];
  for (const arquivo of entradas) {
    recebidos.push({
      // `basename` corta qualquer caminho relativo vindo do navegador: nome de
      // arquivo é entrada do usuário e não pode escapar da pasta do lote.
      nome: basename(arquivo.name),
      buffer: Buffer.from(await arquivo.arrayBuffer()),
    });
  }

  let analise;
  try {
    analise = await analisarLote(recebidos);
  } catch (e) {
    return NextResponse.json(
      { erro: `Falha ao analisar o lote: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  const lote = await prisma.loteImportacao.create({
    data: {
      caminho: "",
      totalArquivos: analise.totalArquivos,
      totalBytes: BigInt(analise.totalBytes),
      analise: analise as unknown as Prisma.InputJsonValue,
    },
  });

  const caminho = join(
    process.env.STORAGE_DIR ?? "./storage",
    "lotes",
    lote.id,
  );

  try {
    await mkdir(caminho, { recursive: true });
    for (const r of recebidos) {
      await writeFile(join(caminho, r.nome), r.buffer);
    }
  } catch (e) {
    // Sem os arquivos em disco, a confirmação não teria o que processar.
    await prisma.loteImportacao.delete({ where: { id: lote.id } });
    return NextResponse.json(
      { erro: `Não foi possível guardar os arquivos: ${(e as Error).message}` },
      { status: 500 },
    );
  }

  await prisma.loteImportacao.update({
    where: { id: lote.id },
    data: { caminho },
  });

  return NextResponse.json({ loteId: lote.id, analise });
}

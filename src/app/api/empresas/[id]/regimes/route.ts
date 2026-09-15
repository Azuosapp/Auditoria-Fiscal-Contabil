import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const REGIMES = [
  "SIMPLES_NACIONAL",
  "LUCRO_PRESUMIDO",
  "LUCRO_REAL",
  "MEI",
  "IMUNE_ISENTA",
  "ARBITRADO",
] as const;

const schema = z.object({
  regimes: z.array(
    z.object({
      exercicio: z.number().int().min(2000).max(2100),
      regime: z.enum(REGIMES),
    }),
  ),
});

export async function PUT(
  req: Request,
  { params }: { params: { id: string } },
) {
  let dados: z.infer<typeof schema>;
  try {
    dados = schema.parse(await req.json());
  } catch (e) {
    const detalhe =
      e instanceof z.ZodError
        ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")
        : (e as Error).message;
    return NextResponse.json({ erro: detalhe }, { status: 400 });
  }

  const empresa = await prisma.empresa.findUnique({ where: { id: params.id } });
  if (!empresa) {
    return NextResponse.json({ erro: "Empresa não encontrada." }, { status: 404 });
  }

  // Regime informado à mão vence a dedução: quem preencheu sabe mais que o
  // detector. Por isso a origem é sobrescrita junto com o valor.
  await prisma.$transaction(
    dados.regimes.map((r) =>
      prisma.regimePorExercicio.upsert({
        where: {
          empresaId_exercicio: { empresaId: params.id, exercicio: r.exercicio },
        },
        create: {
          empresaId: params.id,
          exercicio: r.exercicio,
          regime: r.regime,
          origem: "informado pelo auditor",
        },
        update: { regime: r.regime, origem: "informado pelo auditor" },
      }),
    ),
  );

  return NextResponse.json({ salvos: dados.regimes.length });
}

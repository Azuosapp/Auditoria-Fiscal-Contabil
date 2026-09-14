import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmarLote } from "@/server/importacao/confirmar";

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
  cnpj: z.string().min(14),
  razaoSocial: z.string().min(1, "A razão social é obrigatória."),
  uf: z.string().length(2).optional(),
  inscricaoEstadual: z.string().optional(),
  municipio: z.string().optional(),
  // "AAAA-MM" — o formato usado em toda competência do sistema.
  competenciaIni: z.string().regex(/^\d{4}-\d{2}$/),
  competenciaFim: z.string().regex(/^\d{4}-\d{2}$/),
  titulo: z.string().optional(),
  regimes: z
    .array(
      z.object({
        exercicio: z.number().int().min(2000).max(2100),
        regime: z.enum(REGIMES),
        origem: z.string().optional(),
      }),
    )
    .optional(),
});

export async function POST(
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

  if (dados.competenciaIni > dados.competenciaFim) {
    return NextResponse.json(
      { erro: "A competência inicial é posterior à final." },
      { status: 400 },
    );
  }

  try {
    const resultado = await confirmarLote(params.id, dados);
    return NextResponse.json(resultado);
  } catch (e) {
    return NextResponse.json({ erro: (e as Error).message }, { status: 400 });
  }
}

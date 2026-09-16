import { NextResponse } from "next/server";
import { COOKIE_SESSAO, destinoSeguro } from "@/server/auth/sessao";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const form = await req.formData().catch(() => null);
  const voltar = destinoSeguro(form?.get("voltar"));
  const resposta = NextResponse.redirect(new URL(voltar, req.url), { status: 303 });
  resposta.cookies.set(COOKIE_SESSAO, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return resposta;
}

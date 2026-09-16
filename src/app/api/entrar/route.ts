import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  COOKIE_SESSAO,
  DURACAO_SESSAO_S,
  conferirSenha,
  criarTokenSessao,
  destinoSeguro,
} from "@/server/auth/sessao";

export const runtime = "nodejs";

/** Tentativas erradas por IP numa janela de 15 minutos. Em memória: basta para uso interno. */
const TENTATIVAS = new Map<string, { n: number; desde: number }>();
const JANELA_MS = 15 * 60 * 1000;
const LIMITE = 8;

function redirecionar(req: Request, caminho: string) {
  return NextResponse.redirect(new URL(caminho, req.url), { status: 303 });
}

export async function POST(req: Request) {
  const form = await req.formData();
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const senha = String(form.get("senha") ?? "");
  const voltar = destinoSeguro(form.get("voltar"));
  const erro = (codigo: string) =>
    redirecionar(req, `/entrar?erro=${codigo}&voltar=${encodeURIComponent(voltar)}`);

  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const t = TENTATIVAS.get(ip);
  if (t && Date.now() - t.desde < JANELA_MS && t.n >= LIMITE) return erro("bloqueado");

  const usuario = email ? await prisma.usuario.findUnique({ where: { email } }) : null;
  const ok = !!usuario && usuario.ativo && (await conferirSenha(senha, usuario.senhaHash));
  if (!ok) {
    const atual = t && Date.now() - t.desde < JANELA_MS ? t : { n: 0, desde: Date.now() };
    TENTATIVAS.set(ip, { n: atual.n + 1, desde: atual.desde });
    // Mesma resposta para usuário inexistente e senha errada.
    await new Promise((r) => setTimeout(r, 400));
    return erro("credenciais");
  }

  const token = criarTokenSessao(usuario.id);
  if (!token) return erro("configuracao");
  TENTATIVAS.delete(ip);

  const resposta = redirecionar(req, voltar);
  resposta.cookies.set(COOKIE_SESSAO, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: DURACAO_SESSAO_S,
  });
  return resposta;
}

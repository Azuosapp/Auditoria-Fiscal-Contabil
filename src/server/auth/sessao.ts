import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";

/**
 * Autenticação do auditor.
 *
 * Senha com scrypt (sal próprio por usuário). Sessão em cookie httpOnly assinado
 * com HMAC-SHA256 sobre `SESSAO_SEGREDO` — sem segredo configurado, ninguém
 * entra: a falha é fechada, nunca aberta.
 */

const scrypt = promisify(scryptCb) as (senha: string, sal: Buffer, tamanho: number) => Promise<Buffer>;

export const COOKIE_SESSAO = "azuos_sessao";
export const DURACAO_SESSAO_S = 12 * 60 * 60;

export async function gerarHashSenha(senha: string): Promise<string> {
  const sal = randomBytes(16);
  const hash = await scrypt(senha, sal, 64);
  return `scrypt$${sal.toString("base64url")}$${hash.toString("base64url")}`;
}

export async function conferirSenha(senha: string, guardado: string): Promise<boolean> {
  const [algoritmo, salB64, hashB64] = guardado.split("$");
  if (algoritmo !== "scrypt" || !salB64 || !hashB64) return false;
  const esperado = Buffer.from(hashB64, "base64url");
  const calculado = await scrypt(senha, Buffer.from(salB64, "base64url"), esperado.length);
  return calculado.length === esperado.length && timingSafeEqual(calculado, esperado);
}

function segredo(): string | null {
  const s = process.env.SESSAO_SEGREDO;
  return s && s.length >= 32 ? s : null;
}

function assinar(conteudo: string, chave: string): string {
  return createHmac("sha256", chave).update(conteudo).digest("base64url");
}

/** Token "usuarioId.expiraEm.assinatura". Nulo quando não há segredo configurado. */
export function criarTokenSessao(usuarioId: string): string | null {
  const chave = segredo();
  if (!chave) return null;
  const conteudo = `${usuarioId}.${Math.floor(Date.now() / 1000) + DURACAO_SESSAO_S}`;
  return `${conteudo}.${assinar(conteudo, chave)}`;
}

function lerToken(token: string | undefined): string | null {
  const chave = segredo();
  if (!chave || !token) return null;
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  const [usuarioId, expira, assinatura] = partes;
  const esperada = Buffer.from(assinar(`${usuarioId}.${expira}`, chave));
  const recebida = Buffer.from(assinatura);
  if (esperada.length !== recebida.length || !timingSafeEqual(esperada, recebida)) return null;
  if (Number(expira) < Math.floor(Date.now() / 1000)) return null;
  return usuarioId;
}

export interface UsuarioSessao {
  id: string;
  nome: string;
  email: string;
  papel: string;
}

/** Usuário da sessão atual, ou nulo. Usuário desativado perde o acesso na hora. */
export async function usuarioDaSessao(): Promise<UsuarioSessao | null> {
  const id = lerToken(cookies().get(COOKIE_SESSAO)?.value);
  if (!id) return null;
  const u = await prisma.usuario.findUnique({ where: { id }, select: { id: true, nome: true, email: true, papel: true, ativo: true } });
  return u?.ativo ? { id: u.id, nome: u.nome, email: u.email, papel: u.papel } : null;
}

/** Só aceita retorno para caminho interno — evita redirecionar para outro site. */
export function destinoSeguro(voltar: unknown): string {
  return typeof voltar === "string" && voltar.startsWith("/") && !voltar.startsWith("//") && !voltar.includes("\\")
    ? voltar
    : "/apresentacao";
}

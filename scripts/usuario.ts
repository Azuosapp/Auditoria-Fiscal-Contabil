/**
 * Cria um usuário ou troca a senha de um existente. O login pode ser e-mail ou nome
 * simples (ex.: azuos) — fica gravado no campo email, que é único.
 *
 *   npx tsx scripts/usuario.ts <login> "<nome>" [papel]
 *
 * A senha é lida da variável NOVA_SENHA; sem ela, gera uma aleatória e a mostra
 * uma única vez. Papel: ADMIN, AUDITOR (padrão), COMERCIAL ou LEITURA.
 */
import { randomBytes } from "node:crypto";
import { PapelUsuario } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { gerarHashSenha } from "@/server/auth/sessao";

async function main() {
  const [emailArg, nome, papelArg] = process.argv.slice(2);
  const email = emailArg?.trim().toLowerCase();
  if (!email || !nome) {
    console.error('Uso: npx tsx scripts/usuario.ts <login> "<nome>" [ADMIN|AUDITOR|COMERCIAL|LEITURA]');
    process.exit(1);
  }
  const papel = (papelArg ?? "AUDITOR").toUpperCase() as PapelUsuario;
  if (!Object.values(PapelUsuario).includes(papel)) throw new Error(`Papel inválido: ${papelArg}`);

  const gerada = !process.env.NOVA_SENHA;
  const senha = process.env.NOVA_SENHA ?? randomBytes(9).toString("base64url");
  if (senha.length < 8) throw new Error("A senha precisa ter pelo menos 8 caracteres.");

  const organizacao = await prisma.organizacao.findFirst({ orderBy: { createdAt: "asc" } });
  if (!organizacao) throw new Error("Nenhuma organização cadastrada.");

  const senhaHash = await gerarHashSenha(senha);
  const existente = await prisma.usuario.findUnique({ where: { email } });
  await prisma.usuario.upsert({
    where: { email },
    create: { organizacaoId: organizacao.id, email, nome, papel, senhaHash },
    update: { nome, papel, senhaHash, ativo: true },
  });
  console.log(`${existente ? "Senha atualizada" : "Usuário criado"}: ${email} (${papel})`);
  if (gerada) console.log(`Senha gerada (anote agora, não será mostrada de novo): ${senha}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

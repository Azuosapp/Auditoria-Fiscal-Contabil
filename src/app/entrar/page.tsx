import Image from "next/image";
import { destinoSeguro } from "@/server/auth/sessao";

export const dynamic = "force-dynamic";
export const metadata = { title: "Entrar · Auditoria Azuos" };

const MENSAGEM: Record<string, string> = {
  credenciais: "Usuário ou senha incorretos.",
  bloqueado: "Muitas tentativas. Aguarde 15 minutos e tente de novo.",
  configuracao: "O acesso não está configurado neste servidor (SESSAO_SEGREDO).",
};

export default function EntrarPage({ searchParams }: { searchParams: { erro?: string; voltar?: string } }) {
  const voltar = destinoSeguro(searchParams.voltar);
  const erro = searchParams.erro ? MENSAGEM[searchParams.erro] ?? "Não foi possível entrar." : null;

  return (
    <div className="grid min-h-screen place-items-center px-6" style={{ background: "var(--azuos-hero)" }}>
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex justify-center">
          <Image src="/brand/azuos-branco.png" alt="Grupo Azuos" width={5957} height={2678} priority className="-my-6 h-28 w-auto" />
        </div>
        <form
          method="post"
          action="/api/entrar"
          className="rounded-2xl bg-white p-8"
          style={{ boxShadow: "var(--shadow-lg)", fontSize: 14 }}
        >
          <div className="h-1 w-10 rounded-full" style={{ background: "var(--azuos-yellow)" }} />
          <h1 className="mt-3 text-[22px] font-extrabold text-content">Acesso do auditor</h1>
          <p className="mt-1 text-[14px] text-content-muted">
            Entre para ver todos os apontamentos da auditoria.
          </p>

          {erro ? (
            <div className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-[13px] font-semibold text-red-700" role="alert">
              {erro}
            </div>
          ) : null}

          <input type="hidden" name="voltar" value={voltar} />

          <label className="mt-5 block text-[12px] font-bold uppercase tracking-[0.8px] text-content-muted" htmlFor="email">
            Usuário
          </label>
          <input
            id="email"
            name="email"
            type="text"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="username"
            required
            autoFocus
            className="input mt-1.5 !py-2.5 !text-[15px]"
          />

          <label className="mt-4 block text-[12px] font-bold uppercase tracking-[0.8px] text-content-muted" htmlFor="senha">
            Senha
          </label>
          <input
            id="senha"
            name="senha"
            type="password"
            autoComplete="current-password"
            required
            className="input mt-1.5 !py-2.5 !text-[15px]"
          />

          <button type="submit" className="btn-primary mt-6 w-full !py-3 !text-[15px]">
            Entrar
          </button>
        </form>
        <p className="mt-5 text-center text-[12px] text-white/60">Analyze Auditoria e Consultoria Tributária · Grupo Azuos</p>
      </div>
    </div>
  );
}

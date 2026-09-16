"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Enquanto a análise roda, a página se atualiza sozinha. A análise leva
 * minutos e acontece no servidor; sem isso o usuário teria de adivinhar quando
 * recarregar.
 */
export function AcompanharAnaliseIa({ emAndamento }: { emAndamento: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!emAndamento) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [emAndamento, router]);
  return null;
}

export function BotaoAnaliseIa({
  auditoriaId,
  rotulo,
  desabilitado,
}: {
  auditoriaId: string;
  rotulo: string;
  desabilitado?: boolean;
}) {
  const router = useRouter();
  const [enviando, setEnviando] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);

  async function rodar() {
    setEnviando(true);
    setAviso(null);
    try {
      const resp = await fetch(`/api/auditorias/${auditoriaId}/analise-ia`, {
        method: "POST",
      });
      const json = await resp.json();
      if (!resp.ok) {
        setAviso(json.erro ?? "Não foi possível iniciar a análise.");
        return;
      }
      if (json.situacao === "repetira") {
        setAviso("Já há uma análise rodando. Ela será refeita assim que terminar.");
      }
      router.refresh();
    } catch (e) {
      setAviso((e as Error).message);
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-primary"
        disabled={enviando || desabilitado}
        onClick={() => void rodar()}
      >
        {enviando ? "Iniciando…" : rotulo}
      </button>
      {aviso ? <span className="text-[10px] text-content-muted">{aviso}</span> : null}
    </div>
  );
}

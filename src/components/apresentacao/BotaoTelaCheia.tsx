"use client";

import { useEffect, useState } from "react";

/** Liga e desliga a tela cheia do navegador durante a reunião com o cliente. */
export function BotaoTelaCheia() {
  const [cheia, setCheia] = useState(false);

  useEffect(() => {
    const atualizar = () => setCheia(document.fullscreenElement !== null);
    document.addEventListener("fullscreenchange", atualizar);
    return () => document.removeEventListener("fullscreenchange", atualizar);
  }, []);

  return (
    <button
      type="button"
      className="rounded-md border border-white/25 px-3 py-1.5 text-[12px] font-semibold text-white hover:bg-white/10"
      onClick={() => {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen();
      }}
    >
      {cheia ? "Sair da tela cheia" : "Tela cheia"}
    </button>
  );
}

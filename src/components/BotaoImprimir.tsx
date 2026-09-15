"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

/**
 * Barra de ações do relatório — some na impressão.
 *
 * O PDF é gerado pelo próprio navegador. Isso evita depender de Chromium
 * headless (150 MB de download, que esta rede costuma bloquear) e dá um PDF
 * melhor: texto vetorial e selecionável, em vez de imagem rasterizada.
 */
export function BotaoImprimir() {
  const router = useRouter();

  return (
    <div className="nao-imprime mb-4 flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="btn-primary"
        onClick={() => window.print()}
      >
        Gerar PDF
      </button>

      <button type="button" className="btn-ghost" onClick={() => router.back()}>
        Voltar
      </button>

      <span className="text-[10px] text-content-muted">
        Na janela que abrir, escolha <strong>Salvar como PDF</strong> em destino.
        Mantenha os gráficos de fundo ligados para preservar as cores de
        severidade.
      </span>
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Limpeza de dados da auditoria.
 *
 * Três escopos, porque significam coisas diferentes no trabalho: refazer só a
 * análise, reler os arquivos do zero, ou desfazer a importação inteira. Cada um
 * pede confirmação explícita — são ações que apagam dado de cliente.
 */

const ACOES = [
  {
    escopo: "achados",
    rotulo: "Limpar achados",
    descricao:
      "Apaga o resultado das regras. Os arquivos e o que foi extraído deles permanecem.",
    confirmacao: "Apagar os achados e lacunas desta auditoria?",
  },
  {
    escopo: "extracao",
    rotulo: "Limpar extração",
    descricao:
      "Apaga notas, apurações e achados, mantendo os arquivos importados. Depois é só auditar de novo.",
    confirmacao:
      "Apagar tudo que foi extraído dos arquivos? Os arquivos ficam, e será preciso processar de novo.",
  },
  {
    escopo: "tudo",
    rotulo: "Excluir auditoria",
    descricao:
      "Apaga a auditoria, os documentos e os arquivos do cliente em disco. Não tem volta.",
    confirmacao:
      "EXCLUIR a auditoria inteira, com os documentos e os arquivos importados? Esta ação não pode ser desfeita.",
  },
] as const;

export function LimparDados({ auditoriaId }: { auditoriaId: string }) {
  const router = useRouter();
  const [rodando, setRodando] = useState<string | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [mensagem, setMensagem] = useState<string | null>(null);

  async function executar(escopo: string, confirmacao: string) {
    if (!window.confirm(confirmacao)) return;

    setErro(null);
    setMensagem(null);
    setRodando(escopo);
    try {
      const resp = await fetch(
        `/api/auditorias/${auditoriaId}?escopo=${escopo}`,
        { method: "DELETE" },
      );
      const json = await resp.json();
      if (!resp.ok) {
        setErro(json.erro ?? "Falha ao limpar.");
        return;
      }

      if (escopo === "tudo") {
        router.push("/auditorias");
        router.refresh();
        return;
      }

      setMensagem(
        escopo === "achados"
          ? `${json.achados} achado(s) e ${json.lacunas} lacuna(s) removidos.`
          : "Extração apagada. Os arquivos continuam importados — processe de novo.",
      );
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  return (
    <div>
      <div className="space-y-2">
        {ACOES.map((a) => (
          <div key={a.escopo} className="flex items-start gap-2">
            <button
              type="button"
              className="btn-ghost !py-1 !text-[10px] whitespace-nowrap"
              style={
                a.escopo === "tudo"
                  ? { borderColor: "#fca5a5", color: "#b91c1c" }
                  : undefined
              }
              disabled={rodando !== null}
              onClick={() => void executar(a.escopo, a.confirmacao)}
            >
              {rodando === a.escopo ? "Limpando…" : a.rotulo}
            </button>
            <span className="text-[10px] text-content-muted">{a.descricao}</span>
          </div>
        ))}
      </div>

      {erro ? (
        <div
          className="mt-2 rounded-md px-2 py-1 text-[10px]"
          style={{ background: "#fee2e2", color: "#b91c1c" }}
        >
          {erro}
        </div>
      ) : null}

      {mensagem ? (
        <div
          className="mt-2 rounded-md px-2 py-1 text-[10px]"
          style={{ background: "#dcfce7", color: "#166534" }}
        >
          {mensagem}
        </div>
      ) : null}
    </div>
  );
}

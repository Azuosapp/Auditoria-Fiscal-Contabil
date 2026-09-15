"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cnpj as fmtCnpj } from "@/lib/formato";

/**
 * Exclusão de empresa.
 *
 * A ação mais destrutiva do sistema: leva as auditorias, os documentos e os
 * arquivos do cliente em disco. Por isso exige digitar o CNPJ — um clique
 * errado numa lista não pode custar cinco anos de trabalho importado.
 */
export function ExcluirEmpresa({
  empresaId,
  cnpj,
  razaoSocial,
  auditorias,
}: {
  empresaId: string;
  cnpj: string;
  razaoSocial: string;
  auditorias: number;
}) {
  const router = useRouter();
  const [aberto, setAberto] = useState(false);
  const [digitado, setDigitado] = useState("");
  const [excluindo, setExcluindo] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const confere = digitado.replace(/\D/g, "") === cnpj;

  async function excluir() {
    setErro(null);
    setExcluindo(true);
    try {
      const resp = await fetch(`/api/empresas/${empresaId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cnpj: digitado.replace(/\D/g, "") }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        setErro(json.erro ?? "Falha ao excluir.");
        return;
      }
      setAberto(false);
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setExcluindo(false);
    }
  }

  if (!aberto) {
    return (
      <button
        type="button"
        className="btn-ghost !px-2 !py-1 !text-[10px]"
        style={{ borderColor: "#fca5a5", color: "#b91c1c" }}
        onClick={() => setAberto(true)}
      >
        Excluir
      </button>
    );
  }

  return (
    <div
      className="rounded-md p-2 text-[10px]"
      style={{ background: "#fee2e2" }}
    >
      <div className="font-bold" style={{ color: "#b91c1c" }}>
        Excluir {razaoSocial}?
      </div>
      <p className="mt-0.5" style={{ color: "#b91c1c" }}>
        Apaga {auditorias} auditoria(s), os documentos e os arquivos importados.
        Não tem volta. Digite o CNPJ{" "}
        <span className="font-mono font-bold">{fmtCnpj(cnpj)}</span> para
        confirmar.
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <input
          className="input !w-48 !py-1 font-mono"
          value={digitado}
          placeholder="00.000.000/0000-00"
          onChange={(e) => setDigitado(e.target.value)}
        />
        <button
          type="button"
          className="btn-primary !py-1 !text-[10px]"
          style={{ background: "#b91c1c" }}
          disabled={!confere || excluindo}
          onClick={() => void excluir()}
        >
          {excluindo ? "Excluindo…" : "Confirmar exclusão"}
        </button>
        <button
          type="button"
          className="btn-ghost !py-1 !text-[10px]"
          onClick={() => {
            setAberto(false);
            setDigitado("");
            setErro(null);
          }}
        >
          Cancelar
        </button>
      </div>
      {erro ? (
        <div className="mt-1 font-medium" style={{ color: "#b91c1c" }}>
          {erro}
        </div>
      ) : null}
    </div>
  );
}

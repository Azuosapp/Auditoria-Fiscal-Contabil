"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Extracao {
  processados: number;
  comErro: number;
  ignorados: number;
  registros: {
    notas: number;
    itens: number;
    apuracoesIcms: number;
    apuracoesContribuicoes: number;
    apuracoesSimples: number;
    eventos: number;
  };
  reconciliacao: { canceladas: number; escrituradas: number };
  erros: { documento: string; mensagem: string }[];
}

interface Auditoria {
  achados: number;
  porSeveridade: Record<string, number>;
  totalDebitoAberto: string;
  totalRiscoAutuacao: string;
  totalRecuperavel: string;
  nivelAlcancado: string;
  lacunas: number;
  regrasAvaliadas: number;
  regrasBloqueadas: number;
  competenciasSemEscrituracao: string[];
}

interface Resposta {
  extracao: Extracao | null;
  auditoria: Auditoria;
}

const ROTULO_NIVEL: Record<string, string> = {
  DIAGNOSTICO_RAPIDO: "Diagnóstico rápido",
  FISCAL: "Auditoria fiscal",
  COMPLETA: "Auditoria completa",
};

export function BotaoProcessar({
  auditoriaId,
  pendentes,
}: {
  auditoriaId: string;
  pendentes: number;
}) {
  const router = useRouter();
  const [rodando, setRodando] = useState<"completo" | "regras" | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [resposta, setResposta] = useState<Resposta | null>(null);

  async function executar(modo: "completo" | "regras") {
    setErro(null);
    setResposta(null);
    setRodando(modo);
    try {
      const params =
        modo === "regras"
          ? "?somenteAuditar=1"
          : // Sem pendentes, o único uso do botão é refazer a leitura —
            // tipicamente depois de uma correção de parser.
            pendentes > 0
            ? ""
            : "?reprocessar=1";

      const resp = await fetch(
        `/api/auditorias/${auditoriaId}/processar${params}`,
        { method: "POST" },
      );
      const json = await resp.json();
      if (!resp.ok) {
        setErro(json.erro ?? "Falha ao executar.");
        return;
      }
      setResposta(json as Resposta);
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setRodando(null);
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={rodando !== null}
          onClick={() => void executar("completo")}
        >
          {rodando === "completo"
            ? "Lendo os arquivos e auditando…"
            : pendentes > 0
              ? `Auditar (${pendentes} documento(s) a processar)`
              : "Reprocessar arquivos e auditar"}
        </button>

        <button
          type="button"
          className="btn-ghost"
          disabled={rodando !== null}
          onClick={() => void executar("regras")}
        >
          {rodando === "regras" ? "Reexecutando regras…" : "Só reexecutar as regras"}
        </button>

        {rodando ? (
          <span className="text-[10px] text-content-muted">
            Auditorias de 5 anos levam alguns minutos.
          </span>
        ) : null}
      </div>

      {erro ? (
        <div
          className="mt-2 rounded-md px-3 py-2 text-[11px]"
          style={{ background: "#fee2e2", color: "#b91c1c" }}
        >
          {erro}
        </div>
      ) : null}

      {resposta ? (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <div className="rounded-md border border-surface-border p-3">
            <div className="text-[11px] font-bold">Auditoria</div>
            <div className="mt-2 space-y-1 text-[10px]">
              <Linha rotulo="Achados" valor={resposta.auditoria.achados} />
              <Linha
                rotulo="Regras avaliadas"
                valor={resposta.auditoria.regrasAvaliadas}
              />
              <Linha
                rotulo="Regras sem documento para rodar"
                valor={resposta.auditoria.regrasBloqueadas}
              />
              <Linha rotulo="Lacunas declaradas" valor={resposta.auditoria.lacunas} />
              <div className="flex justify-between gap-3 border-b border-surface-border py-0.5">
                <span className="text-content-muted">Nível alcançado</span>
                <span className="font-semibold">
                  {ROTULO_NIVEL[resposta.auditoria.nivelAlcancado] ??
                    resposta.auditoria.nivelAlcancado}
                </span>
              </div>
            </div>
          </div>

          {resposta.extracao ? (
            <div className="rounded-md border border-surface-border p-3">
              <div className="text-[11px] font-bold">Extração</div>
              <div className="mt-2 space-y-1 text-[10px]">
                <Linha
                  rotulo="Documentos lidos"
                  valor={resposta.extracao.processados}
                />
                <Linha rotulo="Notas" valor={resposta.extracao.registros.notas} />
                <Linha
                  rotulo="Apurações"
                  valor={
                    resposta.extracao.registros.apuracoesIcms +
                    resposta.extracao.registros.apuracoesContribuicoes +
                    resposta.extracao.registros.apuracoesSimples
                  }
                />
                <Linha
                  rotulo="Sem parser ainda"
                  valor={resposta.extracao.ignorados}
                />
                <Linha rotulo="Com erro" valor={resposta.extracao.comErro} />
              </div>
            </div>
          ) : null}

          {resposta.extracao && resposta.extracao.erros.length > 0 ? (
            <div className="md:col-span-2">
              <div className="text-[10px] font-bold">Arquivos com erro</div>
              <ul className="mt-0.5 space-y-0.5 text-[10px] text-content-muted">
                {resposta.extracao.erros.slice(0, 10).map((e, i) => (
                  <li key={i}>
                    · <span className="font-mono">{e.documento}</span> — {e.mensagem}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Linha({ rotulo, valor }: { rotulo: string; valor: number }) {
  return (
    <div className="flex justify-between gap-3 border-b border-surface-border py-0.5">
      <span className="text-content-muted">{rotulo}</span>
      <span className="font-mono font-semibold tabular-nums">{valor}</span>
    </div>
  );
}

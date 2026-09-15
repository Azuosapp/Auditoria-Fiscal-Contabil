"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface Resultado {
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

export function BotaoProcessar({
  auditoriaId,
  pendentes,
}: {
  auditoriaId: string;
  pendentes: number;
}) {
  const router = useRouter();
  const [rodando, setRodando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);

  async function processar() {
    setErro(null);
    setResultado(null);
    setRodando(true);
    try {
      // Sem pendentes, o único uso do botão é refazer a leitura — tipicamente
      // depois de uma correção de parser.
      const url = `/api/auditorias/${auditoriaId}/processar${
        pendentes > 0 ? "" : "?reprocessar=1"
      }`;
      const resp = await fetch(url, { method: "POST" });
      const json = await resp.json();
      if (!resp.ok) {
        setErro(json.erro ?? "Falha ao processar.");
        return;
      }
      setResultado(json as Resultado);
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setRodando(false);
    }
  }

  return (
    <div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={rodando}
          onClick={() => void processar()}
        >
          {rodando
            ? "Extraindo o conteúdo dos arquivos…"
            : pendentes > 0
              ? `Processar ${pendentes} documento(s)`
              : "Reprocessar documentos"}
        </button>
        {rodando ? (
          <span className="text-[10px] text-content-muted">
            Pode levar alguns minutos em auditorias de 5 anos.
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

      {resultado ? (
        <div className="mt-3 rounded-md border border-surface-border p-3">
          <div className="text-[11px] font-bold">Extração concluída</div>
          <div className="mt-2 grid gap-x-6 gap-y-1 text-[10px] md:grid-cols-2">
            <Linha rotulo="Documentos processados" valor={resultado.processados} />
            <Linha rotulo="Notas fiscais" valor={resultado.registros.notas} />
            <Linha rotulo="Itens de nota" valor={resultado.registros.itens} />
            <Linha rotulo="Apurações de ICMS" valor={resultado.registros.apuracoesIcms} />
            <Linha
              rotulo="Apurações de PIS/COFINS"
              valor={resultado.registros.apuracoesContribuicoes}
            />
            <Linha
              rotulo="Apurações do Simples"
              valor={resultado.registros.apuracoesSimples}
            />
            <Linha rotulo="Eventos de NF-e" valor={resultado.registros.eventos} />
            <Linha
              rotulo="Notas marcadas como canceladas"
              valor={resultado.reconciliacao.canceladas}
            />
            <Linha
              rotulo="XMLs confirmados na escrituração"
              valor={resultado.reconciliacao.escrituradas}
            />
            <Linha
              rotulo="Ignorados (sem parser ainda)"
              valor={resultado.ignorados}
            />
            <Linha rotulo="Com erro" valor={resultado.comErro} />
          </div>

          {resultado.erros.length > 0 ? (
            <div className="mt-2">
              <div className="text-[10px] font-bold">Arquivos com erro</div>
              <ul className="mt-0.5 space-y-0.5 text-[10px] text-content-muted">
                {resultado.erros.slice(0, 10).map((e, i) => (
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

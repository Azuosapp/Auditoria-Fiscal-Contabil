"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Regime tributário por exercício.
 *
 * É o dado que mais muda o resultado da auditoria: define quais regras fazem
 * sentido procurar. Sem ele, uma indústria do Lucro Real recebe regra de
 * sublimite do Simples, e o relatório fica com cara de genérico.
 *
 * O sistema deduz o regime do PGDAS e da ECF quando eles são importados; esta
 * tela existe para quando nenhum dos dois veio — que é o caso comum na primeira
 * leva de arquivos.
 */

const REGIMES = [
  { valor: "LUCRO_REAL", rotulo: "Lucro Real" },
  { valor: "LUCRO_PRESUMIDO", rotulo: "Lucro Presumido" },
  { valor: "SIMPLES_NACIONAL", rotulo: "Simples Nacional" },
  { valor: "MEI", rotulo: "MEI" },
  { valor: "IMUNE_ISENTA", rotulo: "Imune / Isenta" },
  { valor: "ARBITRADO", rotulo: "Arbitrado" },
];

export interface RegimeExistente {
  exercicio: number;
  regime: string;
  origem: string | null;
}

export function RegimePorExercicio({
  empresaId,
  exercicios,
  atuais,
}: {
  empresaId: string;
  /** Exercícios cobertos pelo período da auditoria. */
  exercicios: number[];
  atuais: RegimeExistente[];
}) {
  const router = useRouter();
  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const mapa = new Map(atuais.map((r) => [r.exercicio, r]));
  const [valores, setValores] = useState<Record<number, string>>(
    Object.fromEntries(exercicios.map((e) => [e, mapa.get(e)?.regime ?? ""])),
  );

  // Preencher um ano e repetir nos demais é o caso comum: empresa raramente
  // muda de regime no meio do período auditado.
  function aplicarATodos(regime: string) {
    setValores(Object.fromEntries(exercicios.map((e) => [e, regime])));
  }

  async function salvar() {
    setErro(null);
    setSalvando(true);
    try {
      const regimes = Object.entries(valores)
        .filter(([, r]) => r !== "")
        .map(([exercicio, regime]) => ({ exercicio: Number(exercicio), regime }));

      const resp = await fetch(`/api/empresas/${empresaId}/regimes`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ regimes }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        setErro(json.erro ?? "Falha ao salvar.");
        return;
      }
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setSalvando(false);
    }
  }

  const faltando = exercicios.filter((e) => !valores[e]);

  return (
    <div>
      {faltando.length > 0 ? (
        <p
          className="mb-2 rounded px-2 py-1.5 text-[10px]"
          style={{ background: "#fef3c7", color: "#92400e" }}
        >
          <strong>Informe o regime.</strong> Enquanto não estiver preenchido, a
          auditoria roda com todas as regras do catálogo — inclusive as que só
          valem para regimes diferentes do da empresa.
        </p>
      ) : null}

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        <span className="text-[10px] text-content-muted">Aplicar a todos:</span>
        {REGIMES.slice(0, 3).map((r) => (
          <button
            key={r.valor}
            type="button"
            className="btn-ghost !px-2 !py-1 !text-[10px]"
            onClick={() => aplicarATodos(r.valor)}
          >
            {r.rotulo}
          </button>
        ))}
      </div>

      <table className="tbl">
        <tbody>
          {exercicios.map((exercicio) => {
            const atual = mapa.get(exercicio);
            return (
              <tr key={exercicio}>
                <td className="w-16 font-mono font-semibold">{exercicio}</td>
                <td>
                  <select
                    className="input !py-1"
                    value={valores[exercicio] ?? ""}
                    onChange={(e) =>
                      setValores((v) => ({ ...v, [exercicio]: e.target.value }))
                    }
                  >
                    <option value="">não informado</option>
                    {REGIMES.map((r) => (
                      <option key={r.valor} value={r.valor}>
                        {r.rotulo}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="w-48 text-[10px] text-content-muted">
                  {atual?.origem ?? ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {erro ? (
        <div
          className="mt-2 rounded-md px-2 py-1 text-[10px]"
          style={{ background: "#fee2e2", color: "#b91c1c" }}
        >
          {erro}
        </div>
      ) : null}

      <button
        type="button"
        className="btn-primary mt-2 !py-1 !text-[10px]"
        disabled={salvando}
        onClick={() => void salvar()}
      >
        {salvando ? "Salvando…" : "Salvar regime"}
      </button>
      <p className="mt-1 text-[10px] text-content-muted">
        Depois de salvar, reexecute as regras para a auditoria considerar o
        regime.
      </p>
    </div>
  );
}

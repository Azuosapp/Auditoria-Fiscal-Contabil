"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { cnpj as fmtCnpj, competencia as fmtComp } from "@/lib/formato";

/**
 * Importação em três estados: soltar → conferir o que foi identificado →
 * confirmar. O usuário não digita CNPJ: os arquivos é que dizem de quem são,
 * e ele só corrige se a dedução errar.
 */

type Confianca = "ALTA" | "MEDIA" | "BAIXA";

interface Identidade {
  cnpj: string;
  razaoSocial?: string;
  uf?: string;
  inscricaoEstadual?: string;
}

interface Candidato extends Identidade {
  ocorrenciasFortes: number;
  ocorrenciasNotas: number;
}

interface Regime {
  exercicio: number;
  regime: string;
  origem: string;
}

interface Analise {
  identificacao: {
    empresa?: Identidade;
    confianca: Confianca;
    motivo: string;
    outrosCandidatos: Candidato[];
    competenciaIni?: string;
    competenciaFim?: string;
    regimes: Regime[];
  };
  resumoPorTipo: { tipo: string; quantidade: number }[];
  totalArquivos: number;
  totalBytes: number;
  avisos: string[];
}

const ROTULO_TIPO: Record<string, string> = {
  NFE_XML: "XML de NF-e",
  NFCE_XML: "XML de NFC-e",
  NFSE_XML: "XML de NFS-e",
  EVENTO_NFE: "Evento de NF-e",
  SPED_FISCAL: "SPED Fiscal (EFD ICMS/IPI)",
  SPED_CONTRIBUICOES: "SPED EFD-Contribuições",
  ECD: "ECD — SPED Contábil",
  ECF: "ECF",
  DCTF: "DCTF",
  DCTFWEB: "DCTFWeb",
  SITUACAO_FISCAL: "Situação Fiscal (e-CAC)",
  PGDAS: "PGDAS-D",
  COMPROVANTE_ARRECADACAO: "Comprovante de arrecadação",
  ESOCIAL: "eSocial",
  EFD_REINF: "EFD-Reinf",
  CARTAO_CNPJ: "Cartão CNPJ",
  CONTRATO_SOCIAL: "Contrato social",
  PLANILHA: "Planilha",
  DESCONHECIDO: "Não reconhecido",
};

const ROTULO_REGIME: Record<string, string> = {
  SIMPLES_NACIONAL: "Simples Nacional",
  LUCRO_PRESUMIDO: "Lucro Presumido",
  LUCRO_REAL: "Lucro Real",
  MEI: "MEI",
  IMUNE_ISENTA: "Imune / Isenta",
  ARBITRADO: "Arbitrado",
};

function mb(bytes: number) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function PainelImportacao() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [arrastando, setArrastando] = useState(false);
  const [enviando, setEnviando] = useState(false);
  const [confirmando, setConfirmando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  const [loteId, setLoteId] = useState<string | null>(null);
  const [analise, setAnalise] = useState<Analise | null>(null);

  // Campos editáveis: vêm preenchidos pela análise e o usuário só toca se errou.
  const [cnpj, setCnpj] = useState("");
  const [razaoSocial, setRazaoSocial] = useState("");
  const [uf, setUf] = useState("");
  const [compIni, setCompIni] = useState("");
  const [compFim, setCompFim] = useState("");

  const enviar = useCallback(async (arquivos: FileList | File[]) => {
    const lista = Array.from(arquivos);
    if (lista.length === 0) return;

    setErro(null);
    setEnviando(true);
    try {
      const form = new FormData();
      for (const a of lista) form.append("arquivos", a);

      const resp = await fetch("/api/importar", { method: "POST", body: form });
      const json = await resp.json();

      if (!resp.ok) {
        setErro(json.erro ?? "Falha na importação.");
        return;
      }

      const a = json.analise as Analise;
      setLoteId(json.loteId);
      setAnalise(a);
      setCnpj(a.identificacao.empresa?.cnpj ?? "");
      setRazaoSocial(a.identificacao.empresa?.razaoSocial ?? "");
      setUf(a.identificacao.empresa?.uf ?? "");
      setCompIni(a.identificacao.competenciaIni ?? "");
      setCompFim(a.identificacao.competenciaFim ?? "");
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setEnviando(false);
    }
  }, []);

  async function confirmar() {
    if (!loteId || !analise) return;
    setErro(null);
    setConfirmando(true);
    try {
      const resp = await fetch(`/api/importar/${loteId}/confirmar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cnpj: cnpj.replace(/\D/g, ""),
          razaoSocial,
          uf: uf || undefined,
          inscricaoEstadual:
            analise.identificacao.empresa?.inscricaoEstadual || undefined,
          competenciaIni: compIni,
          competenciaFim: compFim,
          regimes: analise.identificacao.regimes.map((r) => ({
            exercicio: r.exercicio,
            regime: r.regime,
            origem: r.origem,
          })),
        }),
      });
      const json = await resp.json();
      if (!resp.ok) {
        setErro(json.erro ?? "Falha ao confirmar.");
        return;
      }
      router.push(`/auditorias/${json.auditoriaId}`);
      router.refresh();
    } catch (e) {
      setErro((e as Error).message);
    } finally {
      setConfirmando(false);
    }
  }

  function recomecar() {
    setLoteId(null);
    setAnalise(null);
    setErro(null);
    if (inputRef.current) inputRef.current.value = "";
  }

  // ---------- Etapa 1: soltar os arquivos ----------

  if (!analise) {
    return (
      <>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setArrastando(true);
          }}
          onDragLeave={() => setArrastando(false)}
          onDrop={(e) => {
            e.preventDefault();
            setArrastando(false);
            void enviar(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className="flex cursor-pointer flex-col items-center justify-center rounded-card border-2 border-dashed bg-white py-16 transition"
          style={{
            borderColor: arrastando ? "var(--azuos-primary)" : "var(--border)",
            background: arrastando ? "var(--azuos-light)" : "#fff",
          }}
        >
          <div className="text-[28px] leading-none text-azuos-primary">⭳</div>
          <div className="mt-3 text-[13px] font-semibold">
            {enviando
              ? "Lendo os arquivos e identificando a empresa…"
              : "Solte os arquivos aqui"}
          </div>
          <p className="mt-1 max-w-lg text-center text-[11px] text-content-muted">
            XML de NF-e e NFC-e, SPED Fiscal, EFD-Contribuições, ECD, ECF, PGDAS,
            DCTF, situação fiscal, comprovantes de arrecadação e pacotes .zip.
            Pode soltar tudo de uma vez — o sistema reconhece cada arquivo pelo
            conteúdo, não pelo nome.
          </p>
          {!enviando ? (
            <div className="mt-4 text-[10px] uppercase tracking-[0.5px] text-content-muted">
              ou clique para escolher
            </div>
          ) : null}
        </div>

        <input
          ref={inputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => e.target.files && void enviar(e.target.files)}
        />

        {erro ? (
          <div
            className="mt-3 rounded-md px-3 py-2 text-[11px]"
            style={{ background: "#fee2e2", color: "#b91c1c" }}
          >
            {erro}
          </div>
        ) : null}

        <div className="card mt-4">
          <div className="text-[11px] font-bold">Como funciona</div>
          <ol className="mt-2 space-y-1 text-[10px] text-content-muted">
            <li>
              <strong>1.</strong> Você solta os arquivos — não precisa cadastrar
              nada antes.
            </li>
            <li>
              <strong>2.</strong> O sistema lê o registro 0000 dos SPED e os
              emitentes dos XMLs, e descobre de quem são os documentos, que
              período cobrem e o regime de cada exercício.
            </li>
            <li>
              <strong>3.</strong> Você confere e confirma. A empresa e a auditoria
              são criadas com os dados vindos dos próprios arquivos.
            </li>
          </ol>
        </div>
      </>
    );
  }

  // ---------- Etapa 2: conferir e confirmar ----------

  const id = analise.identificacao;
  const corConfianca =
    id.confianca === "ALTA"
      ? { background: "#dcfce7", color: "#166534" }
      : id.confianca === "MEDIA"
        ? { background: "#fef3c7", color: "#92400e" }
        : { background: "#fee2e2", color: "#b91c1c" };

  const podeConfirmar =
    cnpj.replace(/\D/g, "").length === 14 &&
    razaoSocial.trim().length > 0 &&
    /^\d{4}-\d{2}$/.test(compIni) &&
    /^\d{4}-\d{2}$/.test(compFim) &&
    compIni <= compFim;

  return (
    <>
      <div className="kpis">
        <div className="kpi">
          <div className="kpi-label">Arquivos recebidos</div>
          <div className="kpi-val">{analise.totalArquivos}</div>
          <div className="kpi-sub">{mb(analise.totalBytes)}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Período detectado</div>
          <div className="kpi-val text-[15px]">
            {fmtComp(id.competenciaIni)} — {fmtComp(id.competenciaFim)}
          </div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Tipos de documento</div>
          <div className="kpi-val">{analise.resumoPorTipo.length}</div>
        </div>
        <div
          className="kpi"
          style={{
            borderLeftColor:
              id.confianca === "ALTA"
                ? "var(--success)"
                : id.confianca === "MEDIA"
                  ? "var(--warning)"
                  : "var(--danger)",
          }}
        >
          <div className="kpi-label">Confiança na identificação</div>
          <div className="kpi-val text-[15px]">{id.confianca}</div>
        </div>
      </div>

      <div className="card mb-3">
        <div className="mb-2 flex items-center gap-2">
          <div className="text-[12px] font-bold">Empresa identificada</div>
          <span
            className="rounded px-1.5 py-0.5 text-[9px] font-bold uppercase"
            style={corConfianca}
          >
            {id.confianca}
          </span>
        </div>

        <p className="mb-3 text-[10px] text-content-muted">{id.motivo}</p>

        <div className="grid gap-3 md:grid-cols-4">
          <div className="md:col-span-2">
            <label className="label" htmlFor="razaoSocial">
              Razão social
            </label>
            <input
              id="razaoSocial"
              className="input"
              value={razaoSocial}
              onChange={(e) => setRazaoSocial(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="cnpj">
              CNPJ
            </label>
            <input
              id="cnpj"
              className="input font-mono"
              value={fmtCnpj(cnpj)}
              onChange={(e) => setCnpj(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="uf">
              UF
            </label>
            <input
              id="uf"
              className="input"
              maxLength={2}
              value={uf}
              onChange={(e) => setUf(e.target.value.toUpperCase())}
            />
          </div>
          <div>
            <label className="label" htmlFor="compIni">
              Competência inicial
            </label>
            <input
              id="compIni"
              className="input font-mono"
              placeholder="AAAA-MM"
              value={compIni}
              onChange={(e) => setCompIni(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="compFim">
              Competência final
            </label>
            <input
              id="compFim"
              className="input font-mono"
              placeholder="AAAA-MM"
              value={compFim}
              onChange={(e) => setCompFim(e.target.value)}
            />
          </div>
        </div>

        {id.outrosCandidatos.length > 0 ? (
          <div className="mt-3 rounded-md border border-surface-border p-2">
            <div className="text-[10px] font-bold">
              Outros CNPJs encontrados nos arquivos
            </div>
            <p className="mb-1.5 text-[10px] text-content-muted">
              Se a empresa auditada for uma destas, clique para trocar.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {id.outrosCandidatos.map((c) => (
                <button
                  key={c.cnpj}
                  type="button"
                  className="btn-ghost !px-2 !py-1 !text-[10px]"
                  onClick={() => {
                    setCnpj(c.cnpj);
                    setRazaoSocial(c.razaoSocial ?? "");
                    setUf(c.uf ?? "");
                  }}
                >
                  {fmtCnpj(c.cnpj)}
                  {c.razaoSocial ? ` · ${c.razaoSocial}` : ""}
                  <span className="text-content-muted">
                    {c.ocorrenciasFortes > 0
                      ? ` (${c.ocorrenciasFortes} escrituração)`
                      : ` (${c.ocorrenciasNotas} notas)`}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <div className="card">
          <div className="mb-2 text-[11px] font-bold">Documentos reconhecidos</div>
          <table className="tbl">
            <tbody>
              {analise.resumoPorTipo.map((r) => (
                <tr key={r.tipo}>
                  <td>{ROTULO_TIPO[r.tipo] ?? r.tipo}</td>
                  <td className="num w-20 font-semibold">{r.quantidade}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="mb-2 text-[11px] font-bold">
            Regime tributário por exercício
          </div>
          {id.regimes.length === 0 ? (
            <p className="text-[10px] text-content-muted">
              Não foi possível deduzir o regime dos arquivos enviados. O regime de
              cada ano pode ser informado depois, no cadastro da empresa — e é ele
              que define qual motor de regras se aplica.
            </p>
          ) : (
            <table className="tbl">
              <tbody>
                {id.regimes.map((r) => (
                  <tr key={r.exercicio}>
                    <td className="w-16 font-mono font-semibold">{r.exercicio}</td>
                    <td>{ROTULO_REGIME[r.regime] ?? r.regime}</td>
                    <td className="text-[10px] text-content-muted">{r.origem}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {analise.avisos.length > 0 ? (
        <div className="card mt-3">
          <div className="mb-1 text-[11px] font-bold">Avisos da leitura</div>
          <ul className="space-y-0.5 text-[10px] text-content-muted">
            {analise.avisos.slice(0, 20).map((a, i) => (
              <li key={i}>· {a}</li>
            ))}
          </ul>
          {analise.avisos.length > 20 ? (
            <div className="mt-1 text-[10px] text-content-muted">
              e mais {analise.avisos.length - 20}.
            </div>
          ) : null}
        </div>
      ) : null}

      {erro ? (
        <div
          className="mt-3 rounded-md px-3 py-2 text-[11px]"
          style={{ background: "#fee2e2", color: "#b91c1c" }}
        >
          {erro}
        </div>
      ) : null}

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          className="btn-primary"
          disabled={!podeConfirmar || confirmando}
          onClick={() => void confirmar()}
        >
          {confirmando ? "Criando…" : "Criar empresa e abrir auditoria"}
        </button>
        <button type="button" className="btn-ghost" onClick={recomecar}>
          Descartar e recomeçar
        </button>
        {!podeConfirmar ? (
          <span className="text-[10px] text-content-muted">
            Preencha razão social, CNPJ e o período no formato AAAA-MM.
          </span>
        ) : null}
      </div>
    </>
  );
}

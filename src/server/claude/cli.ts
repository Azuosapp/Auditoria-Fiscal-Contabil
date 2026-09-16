import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Chamada ao Claude Code instalado na máquina, em modo não interativo.
 *
 * Por que o Claude Code e não a API: a análise usa a conta do Claude.ai do
 * usuário, sem chave de API nem cobrança por token. O custo informado pelo
 * Claude Code é o equivalente a preço de tabela — na assinatura ele não vira
 * fatura, mas mede o consumo do limite, e é nele que o teto se apoia.
 *
 * Isso prende a análise a uma máquina com o Claude Code logado. Se o sistema
 * for para um servidor ou for usado por outras pessoas, o caminho passa a ser a
 * API da Anthropic com chave própria.
 */

export interface ResultadoCli {
  subtype: string;
  isError: boolean;
  resultado?: string;
  saidaEstruturada?: unknown;
  custoUsd?: number;
  duracaoMs?: number;
  turnos?: number;
  modelos: string[];
  /** Saída bruta, para diagnóstico quando o JSON não vier como esperado. */
  bruto: string;
  stderr: string;
  codigoSaida: number | null;
}

/**
 * Localiza o executável.
 *
 * Ordem: variável CLAUDE_CLI_PATH; `claude` do PATH não é consultado porque, na
 * instalação pela extensão do VS Code, ele não existe. A extensão guarda o
 * binário numa pasta com a versão no nome — e a atualização cria pasta nova sem
 * apagar a antiga —, então vale a de versão mais alta.
 */
export function localizarClaude(): string | null {
  const configurado = process.env.CLAUDE_CLI_PATH;
  if (configurado && existsSync(configurado)) return configurado;

  const extensoes = path.join(os.homedir(), ".vscode", "extensions");
  if (!existsSync(extensoes)) return null;

  const candidatos = readdirSync(extensoes)
    .filter((n) => n.startsWith("anthropic.claude-code-"))
    .map((n) => ({
      pasta: n,
      versao: /claude-code-(\d+)\.(\d+)\.(\d+)/.exec(n)?.slice(1).map(Number) ?? [0, 0, 0],
    }))
    .sort((a, b) => {
      for (let i = 0; i < 3; i++) {
        if (a.versao[i] !== b.versao[i]) return b.versao[i] - a.versao[i];
      }
      return 0;
    });

  for (const c of candidatos) {
    const exe = path.join(
      extensoes,
      c.pasta,
      "resources",
      "native-binary",
      process.platform === "win32" ? "claude.exe" : "claude",
    );
    if (existsSync(exe)) return exe;
  }
  return null;
}

export interface OpcoesCli {
  prompt: string;
  /**
   * Arquivo com as instruções. Vai por arquivo, não por argumento: com os
   * agentes embutidos elas passam do limite de ~32 mil caracteres da linha de
   * comando do Windows.
   */
  systemPromptArquivo: string;
  /** Pasta de trabalho: é o único lugar que o Claude enxerga, além de `pastasExtras`. */
  cwd: string;
  pastasExtras?: string[];
  jsonSchema: object;
  modelo: string;
  esforco: string;
  tetoUsd: number;
  timeoutMs: number;
}

export function executarClaude(opcoes: OpcoesCli): Promise<ResultadoCli> {
  const exe = localizarClaude();
  if (!exe) {
    return Promise.reject(
      new Error(
        "Claude Code não encontrado nesta máquina. Instale a extensão do Claude " +
          "Code no VS Code ou informe o caminho em CLAUDE_CLI_PATH.",
      ),
    );
  }

  const args = [
    "-p",
    opcoes.prompt,
    "--model",
    opcoes.modelo,
    "--effort",
    opcoes.esforco,
    // Sem CLAUDE.md, memória, skills, plugins e MCP do usuário: a análise não
    // pode herdar instruções pessoais nem pagar o contexto delas a cada rodada.
    "--safe-mode",
    "--strict-mcp-config",
    "--system-prompt-file",
    opcoes.systemPromptArquivo,
    // Só leitura. Nada de terminal: o conteúdo dos arquivos do cliente é texto
    // de terceiros, e uma instrução escondida numa nota não pode virar comando.
    "--tools",
    "Read,Grep,Glob",
    "--permission-prompts",
    "none",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--json-schema",
    JSON.stringify(opcoes.jsonSchema),
    "--max-budget-usd",
    String(opcoes.tetoUsd),
  ];
  for (const pasta of opcoes.pastasExtras ?? []) {
    args.push("--add-dir", pasta);
  }

  return new Promise((resolve, reject) => {
    const filho = spawn(exe, args, {
      cwd: opcoes.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let saida = "";
    let erro = "";
    filho.stdout.on("data", (d) => (saida += d));
    filho.stderr.on("data", (d) => (erro += d));

    const relogio = setTimeout(() => {
      filho.kill();
      reject(
        new Error(
          `A análise passou de ${Math.round(opcoes.timeoutMs / 60000)} minutos e foi interrompida.`,
        ),
      );
    }, opcoes.timeoutMs);

    filho.on("error", (e) => {
      clearTimeout(relogio);
      reject(e);
    });

    filho.on("close", (codigo) => {
      clearTimeout(relogio);

      let json: Record<string, unknown>;
      try {
        json = JSON.parse(saida);
      } catch {
        reject(
          new Error(
            `Resposta do Claude Code ilegível (código ${codigo}). ` +
              `${erro.slice(0, 500) || saida.slice(0, 500)}`,
          ),
        );
        return;
      }

      const modelUsage = (json.modelUsage ?? {}) as Record<string, unknown>;
      resolve({
        subtype: String(json.subtype ?? ""),
        isError: Boolean(json.is_error),
        resultado: typeof json.result === "string" ? json.result : undefined,
        saidaEstruturada: json.structured_output,
        custoUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : undefined,
        duracaoMs: typeof json.duration_ms === "number" ? json.duration_ms : undefined,
        turnos: typeof json.num_turns === "number" ? json.num_turns : undefined,
        modelos: Object.keys(modelUsage),
        bruto: saida,
        stderr: erro,
        codigoSaida: codigo,
      });
    });
  });
}

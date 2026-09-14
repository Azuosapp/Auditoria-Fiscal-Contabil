import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Onde procurar o `pdftotext` além do PATH.
 *
 * O PATH do terminal do desenvolvedor e o do processo que o Windows inicia no
 * logon NÃO são o mesmo. O binário vem junto com o Git for Windows, que está no
 * PATH do Git Bash mas não no de um serviço ou tarefa agendada — e o sintoma
 * disso é o extrato do PGDAS-D "não ser lido" só quando o programa sobe sozinho.
 *
 * A busca é feita uma vez e memorizada: são chamadas por PDF, e sondar o disco
 * a cada uma seria desperdício.
 */
const CAMINHOS_CONHECIDOS = [
  // Barra normal de propósito: no Windows o Node aceita as duas, e a invertida
  // dentro de string TypeScript vira sequencia de escape e corrompe o caminho.
  "C:/Program Files/Git/mingw64/bin/pdftotext.exe",
  "C:/Program Files (x86)/Git/mingw64/bin/pdftotext.exe",
  "C:/Program Files/poppler/Library/bin/pdftotext.exe",
  "C:/Program Files/Xpdf/pdftotext.exe",
  "C:/ProgramData/chocolatey/bin/pdftotext.exe",
  "/usr/bin/pdftotext",
  "/usr/local/bin/pdftotext",
];

let executavelResolvido: string | null = null;

function localizarPdftotext(): string {
  if (executavelResolvido) return executavelResolvido;

  // Uma variável de ambiente vence tudo: é a saída para quem instalou em outro
  // lugar, sem precisar mexer no código.
  const doAmbiente = process.env.PDFTOTEXT_PATH;
  if (doAmbiente && existsSync(doAmbiente)) {
    executavelResolvido = doAmbiente;
    return executavelResolvido;
  }

  for (const c of CAMINHOS_CONHECIDOS) {
    if (existsSync(c)) {
      executavelResolvido = c;
      return executavelResolvido;
    }
  }

  // Não achou em lugar nenhum: tenta pelo PATH e deixa o ENOENT falar.
  executavelResolvido = "pdftotext";
  return executavelResolvido;
}

/**
 * Converte PDF em texto usando o `pdftotext` do sistema.
 *
 * Escolha deliberada de não usar biblioteca: o `pdftotext` já está no ambiente,
 * lida com os PDFs do e-CAC melhor que os parsers em JavaScript e não acrescenta
 * dependência a um projeto que precisa rodar em rede restrita.
 *
 * `-layout` preserva a posição horizontal do texto, e é isso que permite casar
 * rótulo e valor na mesma linha no extrato do PGDAS-D. Sem ele, os números
 * chegam num fluxo único e a associação vira adivinhação.
 *
 * A entrada é um BUFFER, não um caminho: o documento pode estar em storage
 * remoto, e o binário do Xpdf — ao contrário do poppler — não lê de stdin. Por
 * isso o buffer é gravado num arquivo temporário, sempre removido no fim.
 */
export async function pdfBufferParaTexto(buffer: Buffer): Promise<string> {
  const pasta = await mkdtemp(join(tmpdir(), "pdf-"));
  const caminho = join(pasta, "documento.pdf");
  try {
    await writeFile(caminho, buffer);
    return await pdfParaTexto(caminho);
  } finally {
    await rm(pasta, { recursive: true, force: true }).catch(() => {});
  }
}

/** Mesma conversão, a partir de um arquivo já em disco. */
export async function pdfParaTexto(caminho: string): Promise<string> {
  try {
    const { stdout } = await exec(
      localizarPdftotext(),
      ["-enc", "UTF-8", "-layout", caminho, "-"],
      { maxBuffer: 32 * 1024 * 1024, windowsHide: true },
    );
    return stdout;
  } catch (e) {
    const erro = e as { code?: string; message?: string };
    if (erro.code === "ENOENT") {
      throw new Error(
        "O utilitário `pdftotext` não foi encontrado, e é ele que lê o PDF do " +
          "extrato. Ele vem junto com o Git for Windows " +
          "(C:/Program Files/Git/mingw64/bin). Se estiver instalado em outro " +
          "lugar, aponte o caminho completo na variável de ambiente PDFTOTEXT_PATH.",
      );
    }
    throw new Error(`Falha ao converter o PDF em texto: ${erro.message ?? e}`);
  }
}

/**
 * O `pdftotext` está instalado?
 *
 * O binário do Xpdf sai com código diferente de zero no `-v` (ele imprime a
 * versão e a ajuda), então "deu erro" não significa "não existe". O que distingue
 * os dois casos é o `ENOENT`: só ele indica que o executável não foi encontrado.
 */
export async function pdftotextDisponivel(): Promise<boolean> {
  try {
    await exec(localizarPdftotext(), ["-v"], { windowsHide: true });
    return true;
  } catch (e) {
    return (e as { code?: string }).code !== "ENOENT";
  }
}

"use client";

import { useEffect, useState } from "react";

/**
 * Catálogo com os exemplos recolhíveis.
 *
 * O exemplo é a parte que ensina a reconhecer o erro, mas ocupa três linhas por
 * achado — numa lista de trinta, some a visão geral. Aqui ele pode ficar à
 * mostra ou minimizado, de uma vez ou item a item, e a escolha é lembrada: quem
 * usa o catálogo como índice não quer refazer o mesmo ajuste toda visita.
 *
 * O estado vive aqui, no componente que envolve o catálogo inteiro, e não em
 * cada tabela: "mostrar exemplos" tem de valer para a página toda, senão o
 * botão de uma família não mexeria nas outras.
 */

const CHAVE_PREFERENCIA = "azuos-audit:catalogo:exemplos";

export interface ItemCatalogo {
  codigo: string;
  titulo: string;
  descricao: string;
  exemplo: string;
  severidade: string;
  tributo: string | null;
  fontesNecessarias: string[];
  baseLegal: string[];
}

export interface FamiliaCatalogo {
  chave: string;
  nome: string;
  itens: ItemCatalogo[];
}

export interface AreaCatalogo {
  chave: string;
  titulo: string;
  descricao: string;
  familias: FamiliaCatalogo[];
}

const CLASSE_SEVERIDADE: Record<string, string> = {
  CRITICO: "sev sev-critico",
  ALTO: "sev sev-alto",
  MEDIO: "sev sev-medio",
  BAIXO: "sev sev-baixo",
  OPORTUNIDADE: "sev sev-oportunidade",
};

export function CatalogoComExemplos({ areas }: { areas: AreaCatalogo[] }) {
  // Começa recolhido: o catálogo é consultado primeiro como índice.
  const [mostrarTodos, setMostrarTodos] = useState(false);
  /**
   * Exceções ao padrão atual: com tudo recolhido, são os abertos à mão; com
   * tudo à mostra, são os fechados à mão. Um conjunto só, em vez de dois
   * estados que poderiam divergir.
   */
  const [excecoes, setExcecoes] = useState<Set<string>>(new Set());
  const [carregou, setCarregou] = useState(false);

  useEffect(() => {
    try {
      setMostrarTodos(window.localStorage.getItem(CHAVE_PREFERENCIA) === "1");
    } catch {
      // Navegador com armazenamento bloqueado: segue com o padrão recolhido.
    }
    setCarregou(true);
  }, []);

  function alternarTodos() {
    const novo = !mostrarTodos;
    setMostrarTodos(novo);
    setExcecoes(new Set());
    try {
      window.localStorage.setItem(CHAVE_PREFERENCIA, novo ? "1" : "0");
    } catch {
      // Sem persistência, a escolha vale só nesta visita.
    }
  }

  function alternarUm(codigo: string) {
    setExcecoes((atual) => {
      const novo = new Set(atual);
      if (novo.has(codigo)) novo.delete(codigo);
      else novo.add(codigo);
      return novo;
    });
  }

  // Antes de ler o localStorage, renderiza recolhido — evita o exemplo piscar
  // na tela e sumir logo em seguida.
  const aberto = (codigo: string) =>
    carregou && (mostrarTodos ? !excecoes.has(codigo) : excecoes.has(codigo));

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-2">
        <span className="text-[10px] text-content-muted">
          {mostrarTodos
            ? "Exemplos à mostra"
            : "Exemplos minimizados — abra um em “ver exemplo”"}
        </span>
        <button
          type="button"
          className="btn-ghost !py-1 !text-[10px]"
          onClick={alternarTodos}
        >
          {mostrarTodos ? "Ocultar todos os exemplos" : "Mostrar todos os exemplos"}
        </button>
      </div>

      {areas.map((area) => (
        <section key={area.chave} className="mb-6">
          <div
            className="mb-3 rounded-card p-3"
            style={{ background: "var(--azuos-light)" }}
          >
            <h2 className="text-[13px] font-bold">{area.titulo}</h2>
            <p className="mt-0.5 text-[10px]">{area.descricao}</p>
          </div>

          {area.familias.map((familia) => (
            <div key={familia.chave} className="mb-4">
              <h3 className="mb-2 text-[11px] font-bold uppercase tracking-[0.5px] text-content-muted">
                {familia.nome}
              </h3>

              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th className="w-14">Código</th>
                      <th>Achado</th>
                      <th className="w-28">Severidade</th>
                      <th className="w-24">Tributo</th>
                      <th className="w-40">Documentos necessários</th>
                    </tr>
                  </thead>
                  <tbody>
                    {familia.itens.map((d) => (
                      <tr key={d.codigo}>
                        <td className="font-mono font-semibold">{d.codigo}</td>
                        <td>
                          <div className="font-medium">{d.titulo}</div>
                          <div className="mt-0.5 text-[10px] text-content-muted">
                            {d.descricao}
                          </div>

                          {aberto(d.codigo) ? (
                            <div
                              className="mt-1.5 rounded border-l-2 px-2 py-1 text-[10px]"
                              style={{
                                background: "#f8fafc",
                                borderLeftColor: "var(--azuos-accent)",
                              }}
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="font-semibold uppercase tracking-[0.3px] text-content-muted">
                                  Como aparece
                                </span>
                                <button
                                  type="button"
                                  className="text-[10px] text-azuos-primary hover:underline"
                                  onClick={() => alternarUm(d.codigo)}
                                >
                                  ocultar
                                </button>
                              </div>
                              <div className="mt-0.5">{d.exemplo}</div>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="mt-1 text-[10px] font-semibold text-azuos-primary hover:underline"
                              onClick={() => alternarUm(d.codigo)}
                            >
                              ver exemplo
                            </button>
                          )}

                          <div className="mt-1 text-[10px] text-content-muted">
                            {d.baseLegal.join(" · ")}
                          </div>
                        </td>
                        <td>
                          <span className={CLASSE_SEVERIDADE[d.severidade]}>
                            {d.severidade}
                          </span>
                        </td>
                        <td className="text-[10px]">{d.tributo ?? "—"}</td>
                        <td className="text-[10px] text-content-muted">
                          {d.fontesNecessarias.join(", ")}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

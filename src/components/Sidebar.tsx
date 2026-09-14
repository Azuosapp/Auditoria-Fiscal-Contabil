"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navegação lateral no padrão Azuos (docs/PADRAO_VISUAL.md).
 * As classes vêm de globals.css e reproduzem o dashboard-azuos.html.
 */

type Item = { href: string; rotulo: string; icone: string };
type Secao = { titulo: string; itens: Item[] };

const SECOES: Secao[] = [
  {
    titulo: "Auditoria",
    itens: [
      { href: "/auditorias", rotulo: "Auditorias", icone: "▤" },
      { href: "/empresas", rotulo: "Empresas", icone: "▣" },
    ],
  },
  {
    titulo: "Referência",
    itens: [
      { href: "/catalogo", rotulo: "Catálogo de achados", icone: "◈" },
      { href: "/documentos-exigidos", rotulo: "Documentos exigidos", icone: "◱" },
    ],
  },
];

export function Sidebar() {
  const caminho = usePathname();

  return (
    <aside className="sidebar">
      <div className="sb-brand">
        <div className="text-[15px] font-extrabold tracking-tight text-white">
          AZUOS
        </div>
        <div className="mt-0.5 text-[9px] uppercase tracking-[0.6px] text-white/40">
          Auditoria Fiscal e Contábil
        </div>
      </div>

      <nav className="flex-1 overflow-y-auto px-2.5 py-2">
        {SECOES.map((secao) => (
          <div key={secao.titulo}>
            <div className="sb-nav-title">{secao.titulo}</div>
            {secao.itens.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="sb-item"
                // Marca o item da seção atual, inclusive nas rotas filhas.
                data-ativo={
                  caminho === item.href || caminho.startsWith(`${item.href}/`)
                }
              >
                <span className="w-3.5 text-center opacity-70">{item.icone}</span>
                {item.rotulo}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div className="border-t border-[#1e293b] px-4 py-3 text-[9px] text-white/35">
        Analyze Auditoria e Consultoria Tributária
      </div>
    </aside>
  );
}

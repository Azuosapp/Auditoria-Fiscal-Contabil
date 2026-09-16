"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Navegação lateral no padrão Azuos (docs/PADRAO_VISUAL.md).
 * As classes vêm de globals.css e seguem o azuos-brand e o menu do trilha-azuos.
 */

type Item = { href: string; rotulo: string; icone: string };
type Secao = { titulo: string; itens: Item[] };

const SECOES: Secao[] = [
  {
    titulo: "Auditoria",
    itens: [
      { href: "/importar", rotulo: "Importar arquivos", icone: "⭳" },
      { href: "/auditorias", rotulo: "Auditorias", icone: "▤" },
      { href: "/empresas", rotulo: "Empresas", icone: "▣" },
      { href: "/apresentacao", rotulo: "Apresentação", icone: "▶" },
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
        {/* Logo oficial (azuos-brand/trilha-azuos). O PNG tem margem própria,
            compensada pelas margens negativas. */}
        <Image
          src="/brand/azuos-branco.png"
          alt="Grupo Azuos"
          width={5957}
          height={2678}
          priority
          className="-mb-2 -ml-3 -mt-3 h-[72px] w-auto"
        />
        <div className="text-[9px] font-semibold uppercase tracking-[0.8px] text-white/50">
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

      <div className="border-t border-white/10 px-4 py-3 text-[9px] text-white/45">
        Analyze Auditoria e Consultoria Tributária
      </div>
    </aside>
  );
}

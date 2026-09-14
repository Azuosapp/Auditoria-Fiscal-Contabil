# Padrão visual Azuos

Extraído de `github.com/thyagosouzaoficial/asaas-dashboard` → `dashboard-azuos.html`
(commit de 07/08/2026). Esta é a **fonte da verdade** da identidade visual.

> ⚠️ O `azuos-tax-engine` está **fora do padrão** — usa verde `#137a5e`. O padrão real é
> azul-marinho com dourado. Vale corrigir o tax-engine depois, em tarefa própria.

## Tokens

```css
:root{
  /* Identidade */
  --azuos-dark:    #102a60;   /* azul profundo — topo do gradiente */
  --azuos-primary: #183a83;   /* azul Azuos — cor principal */
  --azuos-accent:  #183a83;
  --azuos-light:   #e8f0fe;   /* azul claro — fundo de destaque */
  --azuos-gold:    #f0e915;   /* dourado — marca, realce */

  /* Superfície */
  --bg:     #f0f2f5;
  --card:   #fff;
  --border: #e2e8f0;
  --shadow: 0 1px 3px rgba(0,0,0,.08);

  /* Texto */
  --text:  #1e293b;
  --muted: #64748b;

  /* Estado */
  --success: #10b981;
  --warning: #f59e0b;
  --danger:  #ef4444;
  --info:    #06b6d4;
}
```

**Tipografia:** `Inter`, com fallback `-apple-system, Segoe UI, Arial, sans-serif`.
Corpo em **12px**, `line-height 1.5`. Interface densa, de planilha — é o que o pessoal
do escritório espera. Monoespaçada (`SF Mono, Menlo`) só para número e código.

## Componentes estruturais

| Componente | Definição |
|---|---|
| `.shell` | Grid da aplicação, `min-height:100vh` |
| `.sidebar` | Fundo `#0f172a`, texto branco, fixa, `height:100vh`, borda `#1e293b` |
| `.sb-item` | Item de menu: `rgba(255,255,255,.7)`, 12px, raio 6px, ativo em `--azuos-primary` |
| `.sb-nav-title` | Rótulo de seção: 9px, maiúsculas, `letter-spacing .6px`, `rgba(255,255,255,.35)` |
| `.hdr` | Topo: gradiente `135deg, --azuos-dark → --azuos-primary`, branco, sticky |
| `.main` | Área útil, fundo `#f8fafc`, `padding 20px 24px`, rolagem própria |
| `.card` | Branco, raio 10px, `padding 14px`, `box-shadow var(--shadow)` |
| `.kpi` | Card com **borda esquerda de 3px** em `--azuos-accent` |
| `.kpi-val` | 20px, peso 800 |
| `.kpi-label` | 9px, maiúsculas, `letter-spacing .5px`, peso 600, cor `--muted` |
| `.kpis` | Grid de 6 colunas → 3 → 2 conforme a largura |
| `.tabs` / `.tab` | Barra de abas em card, aba de 11px, raio 6px |
| `.tbl-wrap` | Tabela com `max-height 500px`, rolagem, borda e raio 8px |

## Aplicação na auditoria

O sistema herda tudo acima e acrescenta **as cores de severidade dos achados**, mapeadas
nos tokens de estado já existentes — sem inventar paleta nova:

| Severidade | Token | Uso |
|---|---|---|
| CRÍTICO | `--danger` `#ef4444` | Débito em aberto, omissão de receita |
| ALTO | `--warning` `#f59e0b` | Risco relevante de autuação |
| MÉDIO | `--info` `#06b6d4` | Inconsistência a corrigir |
| BAIXO | `--muted` `#64748b` | Observação |
| OPORTUNIDADE | `--success` `#10b981` | Dinheiro a recuperar |

O dourado `--azuos-gold` fica reservado à marca e ao número-síntese da página 1 do
relatório — o valor total da exposição. É o que o cliente olha primeiro.

# Padrão visual Azuos

**Fonte da verdade:** `github.com/Azuosapp/azuos-brand` (cores, tipografia, logo) e a
referência de produção `github.com/Projetos-Grupo-Azus/trilha-azuos` (menu, gradientes,
cartões). Atualizado em 16/09/2026.

> A versão anterior deste documento vinha do `asaas-dashboard` (`#183a83` e amarelo
> `#f0e915`). Está **superada**: a marca oficial é `#1B3A8C` e `#F5C518`.

O `azuos-brand` é privado e não entra como dependência: o deploy na Vercel não teria
acesso a ele. Os tokens e as logos foram **copiados** para cá, como o próprio Trilha faz.
Mudou a marca? Muda no `azuos-brand` e copia de novo — nunca se inventa cor aqui.

## Tokens (`src/app/globals.css`)

```css
:root{
  --azuos-blue-darkest: #0A1A4A;
  --azuos-blue-dark:    #0F2460;
  --azuos-blue:         #1B3A8C;   /* AZUL OFICIAL */
  --azuos-blue-light:   #2B5CE6;
  --azuos-blue-100:     #E1E6F5;
  --azuos-yellow:       #F5C518;   /* AMARELO OFICIAL — o ponto da logo */
  --azuos-yellow-dark:  #E6B000;

  --azuos-sidebar: linear-gradient(180deg, #0A1A4A 0%, #0F2460 60%, #1B3A8C 100%);
  --azuos-hero:    linear-gradient(135deg, #0A1A4A 0%, #1B3A8C 60%, #2B5CE6 100%);
  --azuos-button:  linear-gradient(135deg, #1B3A8C 0%, #2B5CE6 100%);

  --bg: #F0F4FF;  --card: #fff;  --border: #e2e8f0;
  --shadow: 0 2px 12px rgba(27,58,140,.08);
  --text: #1E293B;  --muted: #64748B;
  --success: #10b981; --warning: #f59e0b; --danger: #ef4444; --info: #06b6d4;
}
```

Os nomes antigos (`--azuos-dark`, `--azuos-primary`, `--azuos-gold`, `--azuos-light`)
continuam existindo como apelidos que apontam para a marca.

**Regra de contraste da marca:** amarelo **nunca sobre branco**. Só sobre azul ou como
ponto/acento pequeno (o indicador do item ativo no menu, a barra da capa da apresentação).

**Tipografia:** Inter (400–800); JetBrains Mono para número e código. O corpo do painel
segue em 12px — interface densa, de planilha. A apresentação ao cliente usa 14px.

## Logo (`public/brand/`)

| Arquivo | Uso |
|---|---|
| `azuos-branco.png` | Sobre fundo escuro: menu lateral, capa da apresentação |
| `azuos-azul.png` | Sobre fundo claro: capa do relatório em PDF |
| `azuos-icon.png` / `azuos-icon-branco.png` | Ícone quadrado |
| `favicon.svg`, `favicon-32.png`, `apple-icon.png` | Aba do navegador |

Os PNG têm margem própria; os componentes compensam com margem negativa. Não distorcer,
não recolorir o ponto amarelo, não pôr a logo azul sobre fundo azul.

## Componentes estruturais

| Componente | Definição |
|---|---|
| `.sidebar` | Gradiente `--azuos-sidebar`, logo branca no topo |
| `.sb-item` | Raio 12px; ativo com fundo branco 14% e barra amarela à esquerda |
| `.hdr` | Topo em `--azuos-hero` |
| `.main` | Fundo `--bg` (`#F0F4FF`) |
| `.card`, `.kpi`, `.achado` | Brancos, raio 16px, sombra azulada; `.kpi` com borda esquerda de 4px |
| `.tab[data-ativo]` | Gradiente `--azuos-button` |
| `.btn-primary` | Gradiente `--azuos-button`; `.btn-accent` amarelo, só sobre azul |
| `.input` | Raio 12px, foco em `--azuos-blue-light` com anel de 3px |

## Severidade dos achados

Usa os tokens de estado, sem paleta nova:

| Severidade | Token | Uso |
|---|---|---|
| CRÍTICO | `--danger` | Débito em aberto, omissão de receita |
| ALTO | `--warning` | Risco relevante de autuação |
| MÉDIO | `--info` | Inconsistência a corrigir |
| BAIXO | `--muted` | Observação |
| OPORTUNIDADE | `--success` | Dinheiro a recuperar |

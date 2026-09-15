# Continuar daqui

**Última sessão: 15/09/2026.** A próxima sessão começa sem memória desta. Leia este arquivo
primeiro, depois `ARQUITETURA.md` e `CATALOGO_ACHADOS.md`.

## Sessão de 15/09/2026 — extração

O processamento existe e foi provado de ponta a ponta. Os arquivos importados
viram notas, itens, eventos e apurações no banco.

**Duas falhas encontradas e corrigidas — ambas do tipo que passa em silêncio:**

1. **Competência deslocada um mês.** Os parsers constroem as datas com
   `Date.UTC`; a conversão para competência lia com `getFullYear()`/`getMonth()`,
   que são locais. Em UTC-3, 01/01 à meia-noite UTC é 31/12 às 21h — e como toda
   escrituração mensal começa no dia 1º, TODA apuração caía no mês anterior. Uma
   EFD de janeiro/2026 foi gravada em 2025-12. A competência é a chave de todo
   cruzamento: o relatório inteiro sairia deslocado. Corrigido para leitura em
   UTC, com teste de regressão.

2. **Mapa de posições da ECF errado.** A ECF tem `COD_VER` no campo 3 e a ECD
   não tem, o que desloca CNPJ, nome e datas em uma posição entre os dois
   leiautes. O mapa fora escrito assumindo a mesma sequência da ECD. Conferido
   no Manual do Leiaute 12 da ECF (ADE Cofis nº 02/2026): CNPJ é o campo 4,
   DT_INI o 10 e DT_FIN o 11. A ECD foi conferida no Manual do Leiaute 9
   (21/12/2023) e estava correta.

> **Lição para os próximos parsers:** teste com linha escrita à mão é circular —
> se o mapa está errado, a linha tende a nascer com o mesmo erro. Os mapas agora
> são validados também contra arquivo real, cruzando a leitura rápida do 0000
> com o que o parser completo extrai do mesmo arquivo.

**Provado com cenário real:** SPED Fiscal + XML escriturado + XML não escriturado
+ evento de cancelamento. Resultado: a nota cancelada foi marcada CANCELADA, o
XML presente no SPED foi marcado escriturado, e o XML ausente ficou como achado
B01. O processamento é idempotente — três execuções seguidas não duplicaram nada.

## O que foi feito na sessão de 14/09/2026

1. **GitHub conectado** — conta `thyagosouzaoficial`, via fluxo de dispositivo OAuth.
   O `gh` CLI **não** está no PATH do sistema; fica em
   `C:\Users\Grupo Azuos\AppData\Local\azuos-tools\gh\bin\gh.exe`.
   O `winget` falhou nesta rede (erro de certificado na fonte `msstore` e travamento na
   fonte `winget`) — o download direto do release funcionou.

2. **Padrão visual Azuos localizado e extraído.** Está em
   `github.com/thyagosouzaoficial/asaas-dashboard` → `dashboard-azuos.html`.
   Azul `#183a83` + dourado `#f0e915`, fonte Inter, corpo 12px.
   ⚠️ **O `azuos-tax-engine` está fora do padrão** (usa verde `#137a5e`). Vale corrigir
   em tarefa própria, quando o usuário quiser.

3. **Projeto criado e de pé.** Next 14 + Prisma + Postgres, banco `azuos_audit`,
   migration `init` aplicada, build limpo, 155 testes passando, 5 rotas respondendo
   HTTP 200 em `localhost:3001`.

4. **Parsers portados do tax-engine** — NF-e/NFC-e, SPED EFD ICMS/IPI, EFD-Contribuições,
   NFS-e, PGDAS, planilha, além de `decimal.ts` e `creditos-pis-cofins.ts`. Foram
   **copiados**, não importados: os dois sistemas ficam independentes. O único ajuste
   foi `src/server/extraction/tipos-prisma.ts`, que substitui os enums do schema antigo.

## Próximo passo, em ordem

### 1. Parsers que faltam — continua sendo o gargalo

Sem eles, metade do catálogo não roda. Ordem de valor:

| Parser | Por que primeiro | Leiaute |
|---|---|---|
| `arrecadacao.ts` | **Desbloqueia a família A inteira** (8 achados críticos) — sem saber o que foi pago, nada se prova | DARF, DAS, DARE-GO |
| `situacao-fiscal.ts` | Achado A08 sozinho já ganha reunião: débito que o cliente não sabia | PDF do e-CAC |
| `ecd.ts` | Abre a família F (caixa negativo, passivo fictício) | SPED Contábil — registros I155, I200, I250, J100, J150 |
| `ecf.ts` | IRPJ/CSLL apurado; fecha A04 e B09 | Blocos L, M, N, P |
| `dctf.ts` | O "confessado" da regra de ouro | DCTF e DCTFWeb |

> Confirmar o leiaute vigente em `sped.rfb.gov.br` **pelo PowerShell** — o WebFetch é
> bloqueado para o domínio; o PowerShell responde HTTP 200. Ver a tabela de fontes no
> `CONTINUAR_AQUI.md` do `azuos-tax-engine`.

### 2. Consolidação

`src/server/auditoria/consolidar.ts` — monta `CompetenciaConsolidada` por competência e
tributo, com as colunas apurado / confessado / pago / receita real e o campo `origens`
apontando arquivo, registro e linha. **É o que torna o motor viável**: com essa tabela
pronta, a família A vira comparação de colunas.

### 3. Motor

`src/server/auditoria/motor.ts` + `regras/familia-*.ts`. Uma função por família, cada
uma devolvendo achados carimbados com o código do catálogo. Teste unitário obrigatório
por regra, com o caso que deve disparar **e** o caso que não deve.

Começar pela família A: é onde estão os 8 achados críticos e onde a lógica já está
desenhada.

### 4. Prescrição, importação e relatório

`prescricao.ts` (art. 173, I × art. 150, § 4º do CTN), a tela de importação com os
botões por tipo de documento, e o relatório em três camadas.

## Armadilhas já conhecidas

- **Porta 3000 é do `azuos-tax-engine`.** Este projeto roda na 3001, já fixado no
  `package.json` e no `.env`.
- **Heredoc do Git Bash quebra com apóstrofo** em texto português. Usar a ferramenta de
  escrita de arquivo, não `cat <<EOF`, para conteúdo com acentuação e apóstrofo.
- **Falso positivo na família A** é o maior risco do produto. Um relatório que acusa
  débito já compensado destrói a credibilidade na reunião. Sem o documento que comprova
  a vinculação, o achado sai com confiança MÉDIA e ressalva explícita.
- **Não versionar `.env`** — contém a senha do banco.

## Antes de dar qualquer número ao cliente

O catálogo cita base legal com data-base **06/08/2026**, vinda dos pacotes do Drive
(`AGENTES CLAUDE`). Ao gerar relatório de verdade, rodar os agentes da área tocada —
Federal para IRPJ/CSLL/PIS/COFINS, Azuos para ICMS de Goiás, PROGOIÁS para indústria
incentivada, IBS/CBS quando o período alcançar 2026 em diante.

# Arquitetura — Auditoria Azuos (`azuos-audit`)

Sistema independente, separado do `azuos-tax-engine`. Mesma stack, para que o
conhecimento e o código de parsing possam circular entre os dois.

## Decisões

| Decisão | Escolha | Por quê |
|---|---|---|
| Stack | Next.js 14 (App Router) + TypeScript | Mesma do tax-engine; ambiente já roda |
| Banco | PostgreSQL + Prisma | Postgres já instalado como serviço; banco próprio `azuos_audit` |
| Autenticação | NextAuth (credenciais) | Igual ao tax-engine, com papéis |
| Estilo | Tailwind + padrão visual Azuos | Verde `#137a5e`, ink `#0b1220`, âmbar `#e0a83c` |
| Processamento | Fila local em banco, worker em processo | Auditoria de 5 anos = milhares de XMLs; não pode travar a requisição |
| Precisão numérica | `Decimal(18,4)` no banco, decimal em memória | Nunca `float` em cálculo de tributo |

**Não usa IA para detectar achado.** As regras são determinísticas, auditáveis e
testadas. A IA entra em um lugar só: redigir o texto de apresentação ao cliente a partir
dos achados já calculados — e sempre com o número vindo do motor, nunca do modelo.

---

## Fluxo

```
1. CADASTRO       CNPJ, regime por ano, período da auditoria
        ↓
2. IMPORTAÇÃO     botões por tipo: XML | SPED Fiscal | EFD-Contribuições |
                  ECD | ECF | DCTF | Situação Fiscal | PGDAS | comprovantes
        ↓
3. CLASSIFICAÇÃO  detecta o tipo pelo CONTEÚDO, não pelo nome do arquivo
        ↓
4. EXTRAÇÃO       parser por tipo → tabelas normalizadas
        ↓
5. CONSOLIDAÇÃO   visão única por competência: apurado | confessado | pago | real
        ↓
6. MOTOR          catálogo de regras roda sobre a consolidação → Achados
        ↓
7. PRESCRIÇÃO     carimba cada achado: exigível | a decair | decaído
        ↓
8. RELATÓRIO      tela + PDF/XLSX + apresentação comercial
```

O passo 5 é o que torna a auditoria viável. Em vez de cada regra reabrir os arquivos,
tudo desagua numa tabela única de competência:

```
CompetenciaConsolidada
  competencia   2024-03
  tributo       ICMS
  apurado       45.320,15   ← SPED Fiscal E110
  confessado    45.320,15   ← DCTF / PGDAS
  pago          12.000,00   ← DARE/DARF
  receitaReal  980.450,00   ← soma dos XMLs
  origens       [{fonte, arquivo, registro, linha}]
```

Com essa tabela pronta, a família A inteira do catálogo vira uma comparação de colunas —
rápida, testável e com evidência anexada.

---

## Estrutura de pastas

```
src/
  app/
    (dashboard)/
      auditorias/            lista e criação
      auditorias/[id]/
        importacao/          os botões de importar
        consolidacao/        apurado × confessado × pago
        achados/             resultado do motor
        relatorio/           saída para o cliente
    api/
  server/
    extraction/              parsers — portados do tax-engine + os novos
      nfe-xml.ts             ✓ portar
      sped-fiscal.ts         ✓ portar
      sped-contribuicoes.ts  ✓ portar
      nfse-xml.ts            ✓ portar
      pgdas-extrato.ts       ✓ portar
      ecd.ts                 ✦ novo — SPED Contábil
      ecf.ts                 ✦ novo — Escrituração Contábil Fiscal
      dctf.ts                ✦ novo
      situacao-fiscal.ts     ✦ novo — PDF do e-CAC
      arrecadacao.ts         ✦ novo — DARF/DAS/DARE
    auditoria/
      consolidar.ts          monta a CompetenciaConsolidada
      motor.ts               executa o catálogo
      regras/
        familia-a-pagamento.ts
        familia-b-receita.ts
        familia-c-credito.ts
        familia-d-regime.ts
        familia-e-icms.ts
        familia-f-contabil.ts
        familia-g-acessorias.ts
      prescricao.ts          janela decadencial
    relatorio/
      pdf.ts  xlsx.ts  apresentacao.ts
  components/
```

---

## Reaproveitamento do tax-engine

Cinco parsers já existem, testados, em `azuos-tax-engine/src/server/extraction/`. São
código do próprio escritório — vão ser **copiados** para cá, não importados, para manter
os dois sistemas independentes. Os testes vêm junto.

O que precisa ser escrito do zero: **ECD, ECF, DCTF, Situação Fiscal e arrecadação** —
exatamente a metade contábil que a auditoria exige e que o tax-engine nunca precisou.

---

## O que garante que o relatório é defensável

1. **Toda evidência aponta para arquivo, registro e linha.** Achado sem rastro não sai.
2. **Regra fiscal versionada por vigência.** Aplica-se a norma da data do fato gerador.
3. **Falso positivo é tratado na regra, não no relatório.** Compensação, retenção, saldo
   credor e parcelamento são descontados antes de acusar falta de pagamento.
4. **Confiança declarada.** Achado que depende de documento ausente sai como MÉDIA ou
   BAIXA, com o texto dizendo o que falta conferir.
5. **Lacuna declarada.** O relatório sempre diz o que não foi analisado e por quê.

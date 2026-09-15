# Auditoria Fiscal e Contábil Azuos

Sistema de auditoria express para prospecção. Recebe os arquivos fiscais e contábeis
de 5 anos do cliente, cruza tudo e aponta os erros da contabilidade atual dele — para
virar apresentação comercial.

**Não é auditoria tributária completa de um a dois meses.** É o diagnóstico que encontra
os erros graves em horas: tributo declarado e não pago, nota emitida e não escriturada,
caixa negativo, crédito perdido, regime errado.

## Como subir

```powershell
cd "C:\Users\Grupo Azuos\azuos-audit"
npm run dev        # http://localhost:3001  (3000 é o azuos-tax-engine)
```

```
npm test           suíte de testes
npm run typecheck  tsc --noEmit
npm run build      build de produção
npx prisma studio  inspecionar o banco
```

Banco: PostgreSQL `azuos_audit` em `localhost:5432` (serviço `postgresql-x64-16`,
sobe com o Windows). Usuário `azuos`, senha em `.env`.

> No Windows, **pare o `npm run dev` antes de `prisma generate` ou `prisma migrate dev`** —
> o servidor segura a DLL do query engine e o comando falha com `EPERM`.

## Estado

```
✓ Modelo de dados completo         21 tabelas, migration aplicada
✓ Parsers portados do tax-engine   NF-e, SPED Fiscal, EFD-Contribuições, NFS-e,
                                   PGDAS, planilha — 178 testes passando
✓ Padrão visual Azuos              extraído do GitHub, aplicado
✓ Catálogo de achados              32 achados em 7 famílias, tipado
✓ Telas                            importação, auditorias, empresas, catálogo
✓ Importação com criação automática da empresa a partir dos arquivos
✓ Extração para o banco               notas, itens, eventos, apuração de ICMS,
                                      PIS/COFINS e Simples — idempotente
✓ Reconciliação                       cancelamento por evento e XML × escrituração
✗ Parsers de ECD, ECF, DCTF, Situação Fiscal e arrecadação
✗ Consolidação (apurado × confessado × pago) e motor de regras
✗ Relatório
```

## Documentação

| Arquivo | Conteúdo |
|---|---|
| [docs/CATALOGO_ACHADOS.md](docs/CATALOGO_ACHADOS.md) | Tudo que a auditoria procura, por família |
| [docs/CHECKLIST_DOCUMENTOS.md](docs/CHECKLIST_DOCUMENTOS.md) | O que exigir do cliente |
| [docs/ARQUITETURA.md](docs/ARQUITETURA.md) | Fluxo, estrutura e decisões |
| [docs/PADRAO_VISUAL.md](docs/PADRAO_VISUAL.md) | Identidade visual Azuos |
| [docs/CONTINUAR_AQUI.md](docs/CONTINUAR_AQUI.md) | Retomada da próxima sessão |

## As regras que não se negociam

1. **Dinheiro nunca é `number`.** `Decimal` no banco e `Prisma.Decimal` em memória.
   Ponto flutuante em tributo vira centavo errado, e centavo errado destrói o relatório.
2. **Achado sem evidência não existe.** Toda acusação aponta arquivo, registro e linha.
3. **Falso positivo é tratado na regra.** Compensação, retenção, saldo credor e
   parcelamento quitam débito sem DARF — a regra desconta antes de acusar.
4. **A lacuna é declarada.** O relatório sempre diz o que não foi analisado e por quê.
5. **A regra é a da data do fato gerador**, não a de hoje.
6. **A IA não detecta achado.** As regras são determinísticas e testadas. A IA só
   redige o texto de apresentação sobre números que o motor já calculou.

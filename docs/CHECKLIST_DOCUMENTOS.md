# Checklist de documentos — Auditoria Azuos

Lista fixa do que precisa ser coletado de todo cliente prospectado, assim que sai a
procuração eletrônica e o certificado digital. O sistema valida esta lista na importação
e mostra o que falta antes de liberar a auditoria.

**Período padrão: últimos 5 exercícios completos + o ano corrente.** A janela de 5 anos é
a do prazo decadencial (art. 173, I, e art. 150, § 4º, do CTN) — é o que a Receita ainda
pode constituir de ofício, e é o que interessa apontar ao cliente.

---

## 1. Cadastral — obrigatório, bloqueia a auditoria

| Documento | Origem | Formato | Uso na auditoria |
|---|---|---|---|
| Cartão CNPJ | Receita Federal | PDF | CNAE, natureza jurídica, porte, situação |
| Contrato social e alterações | Cliente / Junta | PDF | Capital social, sócios, objeto social |
| Quadro de sócios e administradores (QSA) | Receita Federal | PDF | Distribuição de lucros, pró-labore |
| Histórico de regime tributário | e-CAC / Simples Nacional | PDF/HTML | Define qual motor de regras aplicar por ano |
| Inscrição estadual e municipal | SEFAZ / Prefeitura | PDF | Habilitação, benefícios, ISS |

> Sem o regime tributário correto **por ano**, todo cruzamento fica errado. Este é o
> primeiro dado que o sistema exige.

---

## 2. Contábil — 5 anos

| Documento | Origem | Formato | Uso na auditoria |
|---|---|---|---|
| **ECD — SPED Contábil** | e-CAC / cliente | `.txt` (SPED) | Balancete, razão, diário, saldo de caixa, PL, contas de receita e de tributo |
| **ECF — Escrituração Contábil Fiscal** | e-CAC | `.txt` (SPED) | IRPJ e CSLL apurados, e-Lalur/e-Lacs, adições e exclusões, receita declarada |
| **DCTF / DCTFWeb** | e-CAC | PDF ou `.txt` | O que foi **confessado** de tributo federal |
| **Relatório de Situação Fiscal** | e-CAC | PDF | O que está **em aberto**, em malha, parcelado ou inscrito em dívida ativa |
| Extrato de parcelamentos | e-CAC / PGFN | PDF | Débito ativo, saldo, risco de rescisão |
| Comprovantes de arrecadação (DARF) | e-CAC / banco | PDF | O que foi **pago** de fato |
| Balanço e DRE assinados | Cliente | PDF/XLSX | Confronto com a ECD — divergência entre o que foi entregue ao cliente e o que foi ao fisco |

---

## 3. Fiscal — 5 anos

| Documento | Origem | Formato | Uso na auditoria |
|---|---|---|---|
| **XML de NF-e e NFC-e — saída** | Cliente / SEFAZ / distribuição DF-e | `.xml` / `.zip` | Base real de receita. É contra isto que tudo é conferido |
| **XML de NF-e — entrada** | Distribuição DF-e | `.xml` / `.zip` | Créditos, insumos, ST, fornecedor irregular |
| Eventos de NF-e (cancelamento, CC-e, manifestação) | SEFAZ | `.xml` | Nota cancelada escriturada como válida |
| **SPED EFD ICMS/IPI** | Cliente / SEFAZ | `.txt` | ICMS apurado (Bloco E), notas escrituradas (C100/C190), CIAP (Bloco G) |
| **SPED EFD-Contribuições** | e-CAC | `.txt` | PIS e COFINS apurados (M200/M600), créditos (M100/M500) |
| **NFS-e** | Prefeitura | `.xml` / PDF | Receita de serviço, ISS retido e devido |
| **PGDAS-D + extrato do Simples** | e-CAC | PDF | RBT12, anexo, fator R, sublimite (se optante) |
| Comprovantes DAS / DARE-GO / GNRE | Banco / SEFAZ | PDF | Recolhimento efetivo de ICMS e Simples |
| Livro de Apuração do ICMS | SPED | — | Extraído do próprio SPED Fiscal |

---

## 4. Folha e retenções — 5 anos

| Documento | Origem | Formato | Uso na auditoria |
|---|---|---|---|
| **eSocial** — eventos periódicos | e-CAC | `.xml` | Base de INSS e FGTS |
| **EFD-Reinf** | e-CAC | `.xml` | Retenções de terceiros, INSS retido |
| **DIRF** (até 2024) / IRRF na DCTFWeb | e-CAC | `.txt` / PDF | IRRF sobre pró-labore, serviços e distribuição |
| Folha de pagamento e resumo | Cliente | PDF/XLSX | Pró-labore x distribuição de lucro, fator R |

---

## 5. Opcional — enriquece, não bloqueia

- Extratos bancários (OFX) — confronto de receita e caixa
- Contratos de empréstimo de sócio — passivo fictício
- Laudos de avaliação, contratos de locação, comodato
- Termos de acordo de regime especial (TARE) e habilitação em programas de incentivo

---

## Regra de suficiência do sistema

O sistema classifica cada auditoria em três níveis, conforme o que foi entregue:

| Nível | Requisito mínimo | O que consegue apontar |
|---|---|---|
| **Diagnóstico rápido** | Situação Fiscal + PGDAS **ou** DCTF | Débito em aberto, entrega em atraso, regime |
| **Auditoria fiscal** | + SPED Fiscal + EFD-Contribuições + XMLs | Todo o bloco A, B, C e E do catálogo |
| **Auditoria completa** | + ECD + ECF + folha | Catálogo inteiro, inclusive contábil e societário |

O relatório final sempre declara **qual nível foi alcançado e o que ficou de fora por
falta de documento** — nunca apresenta uma auditoria parcial como se fosse completa.

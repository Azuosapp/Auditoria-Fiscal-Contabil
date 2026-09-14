# Catálogo de achados — Auditoria Azuos

Cada linha deste catálogo vira uma **regra executável** no motor (`src/server/auditoria/regras/`).
Nenhum achado é escrito à mão no relatório: o sistema detecta, quantifica e cita a origem.

**Data-base dos parâmetros:** 06/08/2026 (pacotes do Agente Tributário Federal e do
Agente Tributário Azuos). Toda regra guarda a vigência da norma que aplica — regra fiscal
se aplica pela data do **fato gerador**, nunca pela data de hoje.

## Anatomia de um achado

```ts
{
  codigo: "A01",
  titulo: "ICMS declarado no SPED Fiscal e não recolhido",
  familia: "DIVERGENCIA_PAGAMENTO",
  severidade: "CRITICO",           // CRITICO | ALTO | MEDIO | BAIXO | OPORTUNIDADE
  confianca: "ALTA",               // ALTA | MEDIA | BAIXA — governa o tom no relatório
  tributo: "ICMS",
  fontesNecessarias: ["SPED_FISCAL", "COMPROVANTE_ARRECADACAO"],
  competencia: "2024-03",
  valorExposicao: Decimal,          // principal
  valorAtualizado: Decimal,         // + multa e juros estimados
  baseLegal: ["CTN art. 142", "RCTE art. 75"],
  evidencia: [{ arquivo, registro, linha, campo, valor }],
  aindaExigivel: true,              // dentro da janela decadencial
  comoMostrarAoCliente: "..."       // frase pronta para a apresentação
}
```

**Toda evidência aponta para o arquivo, o registro e a linha de origem.** Um achado sem
rastro até o documento do cliente não entra no relatório.

---

## Família A — Apurado × Confessado × Pago

A regra de ouro da auditoria. Quase todo achado de valor mora aqui.

| Código | Achado | Cruzamento | Severidade |
|---|---|---|---|
| **A01** | ICMS declarado e não recolhido | EFD ICMS/IPI E110 (ICMS a recolher) × DARE-GO / GNRE pagos | CRÍTICO |
| **A02** | PIS declarado e não recolhido | EFD-Contribuições M200 × DARF (cód. 6912 / 8109) | CRÍTICO |
| **A03** | COFINS declarado e não recolhido | EFD-Contribuições M600 × DARF (cód. 5856 / 2172) | CRÍTICO |
| **A04** | IRPJ/CSLL apurado e não confessado | ECF (e-Lalur/e-Lacs) × DCTF | CRÍTICO |
| **A05** | IRPJ/CSLL confessado e não pago | DCTF × DARF pago × Situação Fiscal | CRÍTICO |
| **A06** | DAS do Simples declarado e não pago | PGDAS-D × DAS pago | CRÍTICO |
| **A07** | INSS/FGTS confessado e não pago | DCTFWeb × eSocial × DARF pago | CRÍTICO |
| **A08** | Débito em aberto desconhecido pelo cliente | Relatório de Situação Fiscal do e-CAC | CRÍTICO |
| **A09** | Parcelamento rescindido ou em risco | Extrato de parcelamento × pagamentos | ALTO |
| **A10** | Divergência DCTF × DCTFWeb | Confissão em duplicidade ou a menor | ALTO |

> **Cuidado com o falso positivo:** compensação (PER/DCOMP), retenção na fonte, saldo
> credor de período anterior e parcelamento **quitam o débito sem DARF correspondente**.
> A regra só acusa depois de descontar essas quatro hipóteses. Sem o extrato de
> compensação, o achado sai com confiança MÉDIA e o texto diz "verificar compensação".

---

## Família B — Receita e omissão

| Código | Achado | Cruzamento | Severidade |
|---|---|---|---|
| **B01** | NF-e autorizada e não escriturada | Chave do XML × C100 do SPED Fiscal | CRÍTICO |
| **B02** | NF-e escriturada com valor divergente do XML | Valor total XML × C100 | ALTO |
| **B03** | NF-e cancelada escriturada como válida | Evento de cancelamento × C100 (COD_SIT) | ALTO |
| **B04** | NF-e denegada ou inutilizada tratada como válida | Situação da chave × escrituração | MÉDIO |
| **B05** | Receita divergente entre as três escriturações | SPED Fiscal × EFD-Contribuições × ECD (conta 3.x) × ECF | ALTO |
| **B06** | NFS-e emitida e não escriturada | XML de NFS-e × receita de serviço | ALTO |
| **B07** | Receita do PGDAS menor que a receita real | PGDAS-D × soma dos XMLs e NFS-e | CRÍTICO |
| **B08** | Salto de numeração de nota sem inutilização | Sequência de nNF por série | MÉDIO |
| **B09** | Receita da ECD ≠ receita da ECF | Bloco L (ECD) × Bloco P (ECF) | ALTO |

---

## Família C — Crédito indevido e crédito perdido

Aqui moram tanto o risco quanto a **oportunidade** — o que o cliente pagou a mais e pode
recuperar nos últimos 5 anos. É a parte que vende a proposta.

| Código | Achado | Regra | Severidade |
|---|---|---|---|
| **C01** | Crédito de PIS/COFINS sobre item monofásico | CST de entrada 04/05/06 com crédito tomado | ALTO |
| **C02** | Crédito de PIS/COFINS sobre não-insumo | Natureza da despesa × critério de essencialidade (Tema 779 STJ) | MÉDIO |
| **C03** | ICMS não excluído da base de PIS/COFINS | Tema 69 STF — base da EFD-Contribuições × ICMS destacado | OPORTUNIDADE |
| **C04** | Crédito de ICMS de energia/frete/ativo não aproveitado | Entradas × CIAP (Bloco G) × apuração | OPORTUNIDADE |
| **C05** | Crédito de ICMS de fornecedor em situação irregular | CNPJ do emitente × situação cadastral na data | ALTO |
| **C06** | ICMS-ST na base de PIS/COFINS | Composição da base × valor de ST | OPORTUNIDADE |
| **C07** | Crédito outorgado sem o estorno proporcional | Anexo IX do RCTE — crédito × entradas isentas | ALTO |
| **C08** | Retenção na fonte não compensada | EFD-Reinf / notas com retenção × DCTF | OPORTUNIDADE |

---

## Família D — Regime e enquadramento

| Código | Achado | Regra | Severidade |
|---|---|---|---|
| **D01** | Sublimite do Simples estourado sem segregar ICMS/ISS | RBT12 × R$ 3,6 mi — ICMS e ISS saem do DAS | CRÍTICO |
| **D02** | Anexo errado / fator R mal apurado | Folha ÷ receita (12 meses) — Anexo III × V | ALTO |
| **D03** | Percentual de presunção errado no Lucro Presumido | CNAE × atividade real × art. 15 da Lei 9.249/1995 | ALTO |
| **D04** | Regime atual mais caro que a alternativa | Recálculo Simples × Presumido × Real, mês a mês | OPORTUNIDADE |
| **D05** | CNAE incompatível com a operação real | CNAE cadastrado × CFOP e descrição dos itens | MÉDIO |
| **D06** | Presunção majorada não aplicada (2026) | Acréscimo de 10% sobre a parcela que excede o limite anual | ALTO |
| **D07** | Distribuição de lucro sem retenção de 10% | Lei nº 15.270/2025 | ALTO |

---

## Família E — ICMS operacional (Goiás e interestadual)

| Código | Achado | Regra | Severidade |
|---|---|---|---|
| **E01** | ST devida e não aplicada | NCM × Anexo VIII do RCTE × MVA | ALTO |
| **E02** | DIFAL não recolhido | Venda interestadual a não contribuinte (EC 87/2015) | ALTO |
| **E03** | Benefício do Anexo IX sem a condição de fruição | Benefício aplicado × adesão ao PROTEGE × requisitos | CRÍTICO |
| **E04** | Carga efetiva do Anexo IX calculada errada | Recálculo — "o cálculo que mais erra" | ALTO |
| **E05** | CFOP × CST × NCM incoerentes | Matriz de coerência | MÉDIO |
| **E06** | PROTEGE recolhido a 15% em vez de 10/8/6% | Percentual sobre o **benefício**, não sobre o ICMS | OPORTUNIDADE |

> **E06 é um erro clássico de contabilidade terceirizada** e devolve dinheiro ao cliente.
> O PROTEGE incide sobre o valor do benefício, à alíquota de 10%, 8% ou 6% conforme o
> caso — nunca 15%.

---

## Família F — Contábil (ECD e ECF)

Achado contábil impressiona o cliente porque ele **não tem como enxergar sozinho**.

| Código | Achado | Regra | Severidade |
|---|---|---|---|
| **F01** | Caixa com saldo credor (negativo) | Razão da conta caixa por dia/mês | CRÍTICO |
| **F02** | Passivo fictício — empréstimo de sócio sem lastro | Conta de mútuo × contrato × movimentação bancária | CRÍTICO |
| **F03** | Balancete não fecha | Ativo ≠ Passivo + PL | ALTO |
| **F04** | Lucro contábil × lucro fiscal sem adições/exclusões | ECD × e-Lalur da ECF | ALTO |
| **F05** | Distribuição de lucro acima do presumido sem escrituração | Art. 238 do RIR/2018 — gera IRRF | CRÍTICO |
| **F06** | Despesa de tributo ≠ tributo apurado | Conta de resultado × SPED/DCTF | ALTO |
| **F07** | Depreciação ausente ou com taxa incorreta | Imobilizado × taxas da IN RFB 1.700/2017 | MÉDIO |
| **F08** | Capital social não integralizado / PL negativo | Contrato social × ECD | MÉDIO |
| **F09** | Contabilidade "de gaveta" — ECD sem movimento real | Razão com lançamentos globais mensais | ALTO |
| **F10** | Estoque contábil × estoque do Bloco H do SPED | Inventário declarado × registrado | ALTO |

---

## Família G — Obrigações acessórias

| Código | Achado | Regra | Severidade |
|---|---|---|---|
| **G01** | Escrituração entregue em atraso | Data de entrega × prazo legal | MÉDIO |
| **G02** | Obrigação não entregue em ano obrigatório | ECD, ECF, DCTF, EFD-Contribuições | ALTO |
| **G03** | DIRBI não entregue com benefício usufruído | Benefício identificado × DIRBI | ALTO |
| **G04** | Campos de IBS/CBS ausentes no documento fiscal | Regime regular, fatos geradores a partir de 03/08/2026 | ALTO |
| **G05** | Benefício federal informado pelo valor cheio | Filtro da LC nº 224/2025 — redução linear de 10% | ALTO |

---

## Família H — Prescrição e janela de risco

Não é achado: é o **filtro que dá credibilidade ao relatório**.

- **H01** — Cada achado é carimbado com a competência e classificado em:
  - `EXIGIVEL` — dentro da janela de 5 anos, a Receita ainda pode constituir
  - `A_DECAIR` — decai nos próximos 12 meses (urgência comercial)
  - `DECAIDO` — fora da janela, entra como histórico, não como risco

- Contagem: art. 173, I, do CTN (primeiro dia do exercício seguinte) para tributo não
  declarado; art. 150, § 4º (fato gerador) quando houve declaração e pagamento parcial.
  **O sistema aplica a contagem correta conforme o caso e diz qual usou.**

---

## Saída para o cliente

O relatório final é montado em três camadas, na mesma ordem:

1. **Página 1 — o número.** Exposição total, dividida em "débito em aberto", "risco de
   autuação" e "dinheiro a recuperar". É esta página que ganha a reunião.
2. **Achados por severidade**, cada um com: o que aconteceu, quanto custa, a prova
   (arquivo e registro), a base legal e o que fazer.
3. **Anexo técnico** — memória de cálculo completa, rastreável até o documento.

Fecha com o que **não** foi analisado por falta de documento. Auditoria que esconde a
própria lacuna não serve como peça técnica.

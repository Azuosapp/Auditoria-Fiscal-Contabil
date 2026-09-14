export const metadata = { title: "Documentos exigidos · Auditoria Azuos" };

/**
 * Checklist fixo de coleta. Espelha docs/CHECKLIST_DOCUMENTOS.md — a lista que o
 * comercial leva para o cliente assim que sai a procuração eletrônica.
 */

type Doc = { nome: string; origem: string; formato: string; uso: string };
type Grupo = { titulo: string; nota?: string; docs: Doc[] };

const GRUPOS: Grupo[] = [
  {
    titulo: "Cadastral",
    nota: "Obrigatório — sem o regime tributário correto por ano, todo cruzamento fica errado.",
    docs: [
      { nome: "Cartão CNPJ", origem: "Receita Federal", formato: "PDF", uso: "CNAE, natureza jurídica, situação" },
      { nome: "Contrato social e alterações", origem: "Cliente / Junta", formato: "PDF", uso: "Capital social, sócios, objeto" },
      { nome: "Quadro de sócios (QSA)", origem: "Receita Federal", formato: "PDF", uso: "Distribuição de lucros, pró-labore" },
      { nome: "Histórico de regime tributário", origem: "e-CAC", formato: "PDF", uso: "Define o motor de regras de cada ano" },
    ],
  },
  {
    titulo: "Contábil — 5 anos",
    docs: [
      { nome: "ECD — SPED Contábil", origem: "e-CAC", formato: ".txt", uso: "Balancete, razão, caixa, PL" },
      { nome: "ECF", origem: "e-CAC", formato: ".txt", uso: "IRPJ e CSLL, e-Lalur, adições e exclusões" },
      { nome: "DCTF / DCTFWeb", origem: "e-CAC", formato: "PDF/.txt", uso: "O que foi confessado" },
      { nome: "Relatório de Situação Fiscal", origem: "e-CAC", formato: "PDF", uso: "O que está em aberto, em malha, parcelado" },
      { nome: "Extrato de parcelamentos", origem: "e-CAC / PGFN", formato: "PDF", uso: "Débito ativo e risco de rescisão" },
      { nome: "Comprovantes DARF", origem: "e-CAC / banco", formato: "PDF", uso: "O que foi pago de fato" },
    ],
  },
  {
    titulo: "Fiscal — 5 anos",
    docs: [
      { nome: "XML de NF-e e NFC-e (saída)", origem: "Cliente / SEFAZ", formato: ".xml/.zip", uso: "Base real de receita" },
      { nome: "XML de NF-e (entrada)", origem: "Distribuição DF-e", formato: ".xml/.zip", uso: "Créditos, insumos, ST" },
      { nome: "Eventos de NF-e", origem: "SEFAZ", formato: ".xml", uso: "Cancelamento escriturado como válido" },
      { nome: "SPED EFD ICMS/IPI", origem: "Cliente / SEFAZ", formato: ".txt", uso: "ICMS apurado e notas escrituradas" },
      { nome: "SPED EFD-Contribuições", origem: "e-CAC", formato: ".txt", uso: "PIS e COFINS apurados e créditos" },
      { nome: "NFS-e", origem: "Prefeitura", formato: ".xml/PDF", uso: "Receita de serviço e ISS" },
      { nome: "PGDAS-D e extrato do Simples", origem: "e-CAC", formato: "PDF", uso: "RBT12, anexo, fator R, sublimite" },
      { nome: "DAS, DARE-GO, GNRE", origem: "Banco / SEFAZ", formato: "PDF", uso: "Recolhimento efetivo" },
    ],
  },
  {
    titulo: "Folha e retenções — 5 anos",
    docs: [
      { nome: "eSocial — eventos periódicos", origem: "e-CAC", formato: ".xml", uso: "Base de INSS e FGTS" },
      { nome: "EFD-Reinf", origem: "e-CAC", formato: ".xml", uso: "Retenções de terceiros" },
      { nome: "Folha de pagamento", origem: "Cliente", formato: "PDF/XLSX", uso: "Fator R, pró-labore x lucro" },
    ],
  },
];

export default function DocumentosExigidosPage() {
  return (
    <>
      <div className="mb-4">
        <h1 className="text-[15px] font-bold">Documentos exigidos</h1>
        <p className="mt-0.5 text-[11px] text-content-muted">
          Checklist fixo de coleta. Período padrão: últimos 5 exercícios completos
          mais o ano corrente — a janela em que a Receita ainda pode constituir o
          crédito tributário.
        </p>
      </div>

      {GRUPOS.map((g) => (
        <section key={g.titulo} className="mb-4">
          <h2 className="mb-1 text-[11px] font-bold uppercase tracking-[0.5px] text-content-muted">
            {g.titulo}
          </h2>
          {g.nota ? (
            <p className="mb-2 text-[10px] text-content-muted">{g.nota}</p>
          ) : null}
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Documento</th>
                  <th className="w-40">Origem</th>
                  <th className="w-24">Formato</th>
                  <th>Uso na auditoria</th>
                </tr>
              </thead>
              <tbody>
                {g.docs.map((d) => (
                  <tr key={d.nome}>
                    <td className="font-medium">{d.nome}</td>
                    <td className="text-[10px]">{d.origem}</td>
                    <td className="font-mono text-[10px]">{d.formato}</td>
                    <td className="text-[10px] text-content-muted">{d.uso}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      <div className="card">
        <div className="text-[11px] font-bold">Níveis de auditoria</div>
        <p className="mt-1 text-[10px] text-content-muted">
          O sistema classifica o trabalho conforme o que foi entregue, e o relatório
          sempre declara o nível alcançado e o que ficou de fora por falta de
          documento. Auditoria que esconde a própria lacuna não serve como peça
          técnica.
        </p>
        <div className="mt-2 grid gap-2 md:grid-cols-3">
          <div className="rounded-md border border-surface-border p-2">
            <div className="text-[10px] font-bold">Diagnóstico rápido</div>
            <div className="text-[10px] text-content-muted">
              Situação Fiscal + PGDAS ou DCTF
            </div>
          </div>
          <div className="rounded-md border border-surface-border p-2">
            <div className="text-[10px] font-bold">Auditoria fiscal</div>
            <div className="text-[10px] text-content-muted">
              + SPED Fiscal, EFD-Contribuições e XMLs
            </div>
          </div>
          <div className="rounded-md border border-surface-border p-2">
            <div className="text-[10px] font-bold">Auditoria completa</div>
            <div className="text-[10px] text-content-muted">+ ECD, ECF e folha</div>
          </div>
        </div>
      </div>
    </>
  );
}

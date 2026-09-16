import { Prisma } from "@prisma/client";
import type { AchadoProduzido, ContextoRegra, Regra } from "../tipos";
import { moeda } from "../texto";
import { confrontoApuradoDeclarado, type LinhaConfronto, type TributoFederal } from "@/server/confronto/apurado-declarado";

/**
 * Família A — A09: PIS, COFINS e IPI apurados nas escriturações × confessados
 * em DCTF/MIT.
 *
 * IRPJ e CSLL são a A04, que já confronta a ECF com a DCTF. Aqui o apurado é o
 * da EFD-Contribuições (M200/M600) e da EFD ICMS/IPI (E520). Declarado abaixo
 * do apurado é débito sem confissão; acima, pagamento a maior se recolhido.
 */

const ZERO = new Prisma.Decimal(0);
const TRIBUTOS: TributoFederal[] = ["PIS", "COFINS", "IPI"];

export const familiaAConfronto: Regra = {
  codigos: ["A09"],

  async executar(ctx: ContextoRegra): Promise<AchadoProduzido[]> {
    if (!ctx.fontesDisponiveis.has("DCTF")) return [];
    const { linhas } = await confrontoApuradoDeclarado(ctx.auditoriaId);
    const achados: AchadoProduzido[] = [];

    for (const tributo of TRIBUTOS) {
      const doTributo = linhas.filter((l) => l.tributo === tributo);
      const porAno = new Map<string, LinhaConfronto[]>();
      for (const l of doTributo) porAno.set(l.competencia.slice(0, 4), [...(porAno.get(l.competencia.slice(0, 4)) ?? []), l]);

      for (const [ano, lista] of porAno) {
        const aMenor = lista.filter((l) => l.situacao === "DECLARADO_A_MENOR" || l.situacao === "NAO_DECLARADO");
        const aMaior = lista.filter((l) => l.situacao === "DECLARADO_A_MAIOR" || l.situacao === "SEM_ESCRITURACAO");
        const evid = (ls: LinhaConfronto[]) =>
          ls.map((l) => ({
            tipo: "CONFRONTO" as const,
            arquivo: `${l.fonteApurado} × DCTF`,
            campo: `${tributo} ${l.periodo}`,
            valor: `apurado ${moeda(l.apurado)} · declarado ${moeda(l.declarado)}`,
            observacao:
              l.situacao === "NAO_DECLARADO"
                ? "nenhuma confissão do tributo no período"
                : l.situacao === "SEM_ESCRITURACAO"
                  ? "confessado sem apuração na escrituração do período"
                  : `diferença de ${moeda(l.diferenca.abs())}`,
          }));

        if (aMenor.length > 0) {
          const total = aMenor.reduce((s, l) => s.plus(l.diferenca.abs()), ZERO);
          achados.push({
            codigo: "A09",
            competencia: aMenor[aMenor.length - 1].competencia,
            severidade: "CRITICO",
            confianca: "ALTA",
            descricao:
              `${tributo} apurado na ${aMenor[0].fonteApurado} acima do confessado em DCTF em ${aMenor.length} ` +
              `período(s) de ${ano}: ${moeda(total)} sem declaração.`,
            textoCliente:
              `Em ${ano} a empresa apurou ${moeda(total)} de ${tributo} a mais do que declarou à Receita. ` +
              `O valor não declarado não está confessado nem pago, e pode ser lançado de ofício com multa de 75%.`,
            recomendacao: "Retificar as DCTF dos períodos apontados e recolher a diferença com denúncia espontânea.",
            valorExposicao: total,
            declarado: false,
            evidencias: evid(aMenor),
          });
        }
        if (aMaior.length > 0) {
          const total = aMaior.reduce((s, l) => s.plus(l.diferenca.abs()), ZERO);
          achados.push({
            codigo: "A09",
            competencia: aMaior[aMaior.length - 1].competencia,
            severidade: "OPORTUNIDADE",
            confianca: "MEDIA",
            descricao:
              `${tributo} confessado em DCTF acima do apurado na ${aMaior[0].fonteApurado} em ${aMaior.length} ` +
              `período(s) de ${ano}: ${moeda(total)} declarados a maior.`,
            textoCliente:
              `Em ${ano} a empresa declarou ${moeda(total)} de ${tributo} a mais do que apurou. Se esse valor foi ` +
              `pago, é crédito a restituir ou compensar.`,
            recomendacao: "Confirmar os recolhimentos, retificar as DCTF e pedir a restituição ou compensação (PER/DCOMP).",
            ressalva: "O crédito depende de o valor declarado ter sido efetivamente recolhido.",
            valorExposicao: total,
            declarado: true,
            evidencias: evid(aMaior),
          });
        }
      }
    }
    return achados;
  },
};

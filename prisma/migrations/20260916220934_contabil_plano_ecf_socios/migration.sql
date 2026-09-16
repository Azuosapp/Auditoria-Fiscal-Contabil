-- AlterTable
ALTER TABLE "LancamentoContabil" ADD COLUMN     "tipoLancamento" VARCHAR(1);

-- CreateTable
CREATE TABLE "ContaContabil" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "codigo" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "natureza" VARCHAR(2) NOT NULL,
    "tipo" VARCHAR(1) NOT NULL,
    "nivel" INTEGER NOT NULL,
    "codigoSuperior" TEXT,
    "referencial" TEXT,

    CONSTRAINT "ContaContabil_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LinhaEcf" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "exercicio" INTEGER NOT NULL,
    "periodo" VARCHAR(3) NOT NULL,
    "dataFim" TIMESTAMP(3) NOT NULL,
    "registro" VARCHAR(4) NOT NULL,
    "codigo" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "valor" DECIMAL(18,2),
    "indicador" VARCHAR(1),
    "valorInicial" DECIMAL(18,2),
    "indicadorInicial" VARCHAR(1),
    "debitos" DECIMAL(18,2),
    "creditos" DECIMAL(18,2),

    CONSTRAINT "LinhaEcf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocioEcf" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "exercicio" INTEGER NOT NULL,
    "dataEntrada" TIMESTAMP(3),
    "dataSaida" TIMESTAMP(3),
    "tipoPessoa" VARCHAR(2),
    "documentoSocio" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "qualificacao" TEXT,
    "percentualCapital" DECIMAL(9,4),
    "percentualVotante" DECIMAL(9,4),
    "remuneracaoTrabalho" DECIMAL(18,2),
    "lucrosDividendos" DECIMAL(18,2),
    "jurosCapital" DECIMAL(18,2),
    "demaisRendimentos" DECIMAL(18,2),
    "irRetido" DECIMAL(18,2),

    CONSTRAINT "SocioEcf_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContaContabil_documentoId_referencial_idx" ON "ContaContabil"("documentoId", "referencial");

-- CreateIndex
CREATE UNIQUE INDEX "ContaContabil_documentoId_codigo_key" ON "ContaContabil"("documentoId", "codigo");

-- CreateIndex
CREATE INDEX "LinhaEcf_documentoId_registro_codigo_idx" ON "LinhaEcf"("documentoId", "registro", "codigo");

-- CreateIndex
CREATE INDEX "SocioEcf_documentoId_idx" ON "SocioEcf"("documentoId");

-- AddForeignKey
ALTER TABLE "ContaContabil" ADD CONSTRAINT "ContaContabil_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LinhaEcf" ADD CONSTRAINT "LinhaEcf_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocioEcf" ADD CONSTRAINT "SocioEcf_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

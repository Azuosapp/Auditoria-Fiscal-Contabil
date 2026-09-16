-- AlterTable
ALTER TABLE "NotaFiscal" ADD COLUMN     "indicadorIeDestinatario" VARCHAR(1);

-- AlterTable
ALTER TABLE "NotaFiscalItem" ADD COLUMN     "aliqCofins" DECIMAL(9,4),
ADD COLUMN     "aliqPis" DECIMAL(9,4),
ADD COLUMN     "baseIcms" DECIMAL(18,2),
ADD COLUMN     "origemMercadoria" VARCHAR(1),
ADD COLUMN     "temIbsCbs" BOOLEAN,
ADD COLUMN     "valorDifal" DECIMAL(18,2),
ADD COLUMN     "valorIcms" DECIMAL(18,2),
ADD COLUMN     "valorIcmsSt" DECIMAL(18,2),
ADD COLUMN     "valorIpi" DECIMAL(18,2);

-- CreateTable
CREATE TABLE "EscrituracaoArquivo" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "indAtividade" VARCHAR(1),
    "blocoK" TEXT,
    "dataAssinatura" TIMESTAMP(3),
    "finalidade" VARCHAR(1),

    CONSTRAINT "EscrituracaoArquivo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApuracaoDifal" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "uf" VARCHAR(2) NOT NULL,
    "totalDebitos" DECIMAL(18,2) NOT NULL,
    "totalCreditos" DECIMAL(18,2),
    "aRecolher" DECIMAL(18,2),

    CONSTRAINT "ApuracaoDifal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inventario" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "dataInventario" TIMESTAMP(3),
    "valor" DECIMAL(18,2),
    "motivo" VARCHAR(2),
    "somaItens" DECIMAL(18,2),
    "itens" INTEGER NOT NULL,

    CONSTRAINT "Inventario_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EscrituracaoArquivo_documentoId_key" ON "EscrituracaoArquivo"("documentoId");

-- CreateIndex
CREATE INDEX "ApuracaoDifal_documentoId_competencia_idx" ON "ApuracaoDifal"("documentoId", "competencia");

-- CreateIndex
CREATE INDEX "Inventario_documentoId_idx" ON "Inventario"("documentoId");

-- AddForeignKey
ALTER TABLE "EscrituracaoArquivo" ADD CONSTRAINT "EscrituracaoArquivo_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApuracaoDifal" ADD CONSTRAINT "ApuracaoDifal_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inventario" ADD CONSTRAINT "Inventario_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "Confissao" ADD COLUMN     "dataDeclaracao" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "LinhaDre" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "dataInicio" TIMESTAMP(3) NOT NULL,
    "dataFim" TIMESTAMP(3) NOT NULL,
    "ordem" INTEGER NOT NULL,
    "codigoAglutinacao" TEXT NOT NULL,
    "descricao" TEXT NOT NULL,
    "nivel" INTEGER,
    "tipo" VARCHAR(1),
    "valor" DECIMAL(18,2) NOT NULL,
    "natureza" VARCHAR(1),

    CONSTRAINT "LinhaDre_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LinhaDre_documentoId_dataFim_idx" ON "LinhaDre"("documentoId", "dataFim");

-- AddForeignKey
ALTER TABLE "LinhaDre" ADD CONSTRAINT "LinhaDre_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

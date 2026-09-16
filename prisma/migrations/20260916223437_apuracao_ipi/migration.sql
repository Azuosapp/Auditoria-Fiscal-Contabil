-- CreateTable
CREATE TABLE "ApuracaoIpi" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "debitos" DECIMAL(18,2),
    "creditos" DECIMAL(18,2),
    "saldoCredor" DECIMAL(18,2),
    "aRecolher" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "ApuracaoIpi_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApuracaoIpi_documentoId_competencia_idx" ON "ApuracaoIpi"("documentoId", "competencia");

-- AddForeignKey
ALTER TABLE "ApuracaoIpi" ADD CONSTRAINT "ApuracaoIpi_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

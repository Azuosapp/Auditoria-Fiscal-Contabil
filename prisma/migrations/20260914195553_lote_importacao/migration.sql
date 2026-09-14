-- CreateEnum
CREATE TYPE "StatusLote" AS ENUM ('ANALISADO', 'CONFIRMADO', 'DESCARTADO');

-- CreateTable
CREATE TABLE "LoteImportacao" (
    "id" TEXT NOT NULL,
    "status" "StatusLote" NOT NULL DEFAULT 'ANALISADO',
    "caminho" TEXT NOT NULL,
    "totalArquivos" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "analise" JSONB,
    "auditoriaId" TEXT,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmadoEm" TIMESTAMP(3),

    CONSTRAINT "LoteImportacao_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LoteImportacao_status_idx" ON "LoteImportacao"("status");

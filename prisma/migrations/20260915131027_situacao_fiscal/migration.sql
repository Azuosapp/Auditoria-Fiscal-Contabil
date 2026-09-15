/*
  Warnings:

  - You are about to drop the column `competencia` on the `PendenciaFiscal` table. All the data in the column will be lost.
  - You are about to drop the column `tributo` on the `PendenciaFiscal` table. All the data in the column will be lost.
  - You are about to drop the column `valor` on the `PendenciaFiscal` table. All the data in the column will be lost.
  - Added the required column `orgao` to the `PendenciaFiscal` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "PendenciaFiscal" DROP COLUMN "competencia",
DROP COLUMN "tributo",
DROP COLUMN "valor",
ADD COLUMN     "identificacao" TEXT,
ADD COLUMN     "juros" DECIMAL(18,2),
ADD COLUMN     "multa" DECIMAL(18,2),
ADD COLUMN     "orgao" VARCHAR(4) NOT NULL,
ADD COLUMN     "periodo" TEXT,
ADD COLUMN     "receita" TEXT,
ADD COLUMN     "saldoConsolidado" DECIMAL(18,2),
ADD COLUMN     "saldoDevedor" DECIMAL(18,2),
ADD COLUMN     "valorOriginal" DECIMAL(18,2),
ADD COLUMN     "vencimento" TEXT;

-- CreateTable
CREATE TABLE "RetratoSituacaoFiscal" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "cnpj" TEXT,
    "razaoSocial" TEXT,
    "situacaoCadastral" TEXT,
    "motivoSituacao" TEXT,
    "naturezaJuridica" TEXT,
    "cnae" TEXT,
    "porte" TEXT,
    "dataAbertura" TEXT,
    "municipio" TEXT,
    "uf" TEXT,
    "unidadeAdministrativa" TEXT,
    "responsavel" TEXT,
    "emitidoEm" TEXT,
    "certidaoNumero" TEXT,
    "certidaoEmissao" TEXT,
    "certidaoValidade" TEXT,
    "semPendencias" BOOLEAN NOT NULL DEFAULT false,
    "socios" JSONB,
    "avisos" JSONB,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetratoSituacaoFiscal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "RetratoSituacaoFiscal_documentoId_key" ON "RetratoSituacaoFiscal"("documentoId");

-- CreateIndex
CREATE INDEX "PendenciaFiscal_natureza_idx" ON "PendenciaFiscal"("natureza");

-- AddForeignKey
ALTER TABLE "RetratoSituacaoFiscal" ADD CONSTRAINT "RetratoSituacaoFiscal_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

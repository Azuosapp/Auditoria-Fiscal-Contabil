-- CreateEnum
CREATE TYPE "TipoEvidencia" AS ENUM ('EXEMPLO', 'CONFRONTO', 'CONTEXTO');

-- AlterTable
ALTER TABLE "Evidencia" ADD COLUMN     "chave" TEXT,
ADD COLUMN     "dataDocumento" TEXT,
ADD COLUMN     "documentoNumero" TEXT,
ADD COLUMN     "participante" TEXT,
ADD COLUMN     "tipo" "TipoEvidencia" NOT NULL DEFAULT 'CONTEXTO';

-- CreateIndex
CREATE INDEX "Evidencia_achadoId_tipo_idx" ON "Evidencia"("achadoId", "tipo");

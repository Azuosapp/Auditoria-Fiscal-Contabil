/*
  Warnings:

  - Added the required column `origem` to the `NotaFiscal` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "OrigemNota" AS ENUM ('XML_AUTORIZADO', 'ESCRITURACAO');

-- AlterTable
ALTER TABLE "NotaFiscal" ADD COLUMN     "origem" "OrigemNota" NOT NULL;

-- CreateTable
CREATE TABLE "EventoNfe" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "chave" VARCHAR(44) NOT NULL,
    "tipoEvento" VARCHAR(6) NOT NULL,
    "descricao" TEXT,
    "dataEvento" TIMESTAMP(3),
    "sequencia" INTEGER,
    "autorDoc" TEXT,
    "protocolo" TEXT,
    "cancelaNota" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EventoNfe_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventoNfe_documentoId_idx" ON "EventoNfe"("documentoId");

-- CreateIndex
CREATE INDEX "EventoNfe_chave_idx" ON "EventoNfe"("chave");

-- CreateIndex
CREATE INDEX "NotaFiscal_origem_chave_idx" ON "NotaFiscal"("origem", "chave");

-- AddForeignKey
ALTER TABLE "EventoNfe" ADD CONSTRAINT "EventoNfe_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

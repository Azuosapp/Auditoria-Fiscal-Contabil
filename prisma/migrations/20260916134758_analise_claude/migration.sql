-- CreateEnum
CREATE TYPE "StatusAnaliseIa" AS ENUM ('EM_ANDAMENTO', 'CONCLUIDA', 'LIMITE_ATINGIDO', 'ERRO');

-- CreateTable
CREATE TABLE "AnaliseIa" (
    "id" TEXT NOT NULL,
    "auditoriaId" TEXT NOT NULL,
    "status" "StatusAnaliseIa" NOT NULL DEFAULT 'EM_ANDAMENTO',
    "modelo" TEXT,
    "iniciadaEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "concluidaEm" TIMESTAMP(3),
    "duracaoSeg" INTEGER,
    "custoUsd" DECIMAL(10,4),
    "resumo" TEXT,
    "documentosFaltantes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "erro" TEXT,

    CONSTRAINT "AnaliseIa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApontamentoIa" (
    "id" TEXT NOT NULL,
    "analiseId" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "titulo" TEXT NOT NULL,
    "severidade" "Severidade" NOT NULL,
    "area" "AreaAchado" NOT NULL,
    "confianca" "Confianca" NOT NULL,
    "tributo" TEXT,
    "competencias" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "valorEstimado" DECIMAL(18,2),
    "descricao" TEXT NOT NULL,
    "recomendacao" TEXT,
    "baseLegal" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "evidencias" JSONB NOT NULL,

    CONSTRAINT "ApontamentoIa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AnaliseIa_auditoriaId_iniciadaEm_idx" ON "AnaliseIa"("auditoriaId", "iniciadaEm");

-- CreateIndex
CREATE INDEX "ApontamentoIa_analiseId_idx" ON "ApontamentoIa"("analiseId");

-- AddForeignKey
ALTER TABLE "AnaliseIa" ADD CONSTRAINT "AnaliseIa_auditoriaId_fkey" FOREIGN KEY ("auditoriaId") REFERENCES "Auditoria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApontamentoIa" ADD CONSTRAINT "ApontamentoIa_analiseId_fkey" FOREIGN KEY ("analiseId") REFERENCES "AnaliseIa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

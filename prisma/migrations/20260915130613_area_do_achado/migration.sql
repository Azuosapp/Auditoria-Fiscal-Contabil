-- CreateEnum
CREATE TYPE "AreaAchado" AS ENUM ('FISCAL', 'CONTABIL');

-- AlterTable
ALTER TABLE "Achado" ADD COLUMN     "area" "AreaAchado" NOT NULL DEFAULT 'FISCAL';

-- AlterTable
ALTER TABLE "Lacuna" ADD COLUMN     "area" "AreaAchado" NOT NULL DEFAULT 'FISCAL';

-- CreateIndex
CREATE INDEX "Achado_auditoriaId_area_severidade_idx" ON "Achado"("auditoriaId", "area", "severidade");

-- AlterTable
ALTER TABLE "ApuracaoSimples" ADD COLUMN     "cofins" DECIMAL(18,2),
ADD COLUMN     "cpp" DECIMAL(18,2),
ADD COLUMN     "csll" DECIMAL(18,2),
ADD COLUMN     "icms" DECIMAL(18,2),
ADD COLUMN     "impedidoIcmsIssNoDas" BOOLEAN,
ADD COLUMN     "irpj" DECIMAL(18,2),
ADD COLUMN     "iss" DECIMAL(18,2),
ADD COLUMN     "pis" DECIMAL(18,2);

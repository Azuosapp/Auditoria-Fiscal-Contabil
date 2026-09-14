-- CreateEnum
CREATE TYPE "PapelUsuario" AS ENUM ('ADMIN', 'AUDITOR', 'COMERCIAL', 'LEITURA');

-- CreateEnum
CREATE TYPE "RegimeTributario" AS ENUM ('SIMPLES_NACIONAL', 'LUCRO_PRESUMIDO', 'LUCRO_REAL', 'MEI', 'IMUNE_ISENTA', 'ARBITRADO');

-- CreateEnum
CREATE TYPE "StatusAuditoria" AS ENUM ('RASCUNHO', 'IMPORTANDO', 'PROCESSANDO', 'PRONTA', 'ENTREGUE', 'ARQUIVADA');

-- CreateEnum
CREATE TYPE "NivelAuditoria" AS ENUM ('DIAGNOSTICO_RAPIDO', 'FISCAL', 'COMPLETA');

-- CreateEnum
CREATE TYPE "TipoDocumento" AS ENUM ('NFE_XML', 'NFCE_XML', 'NFSE_XML', 'EVENTO_NFE', 'SPED_FISCAL', 'SPED_CONTRIBUICOES', 'ECD', 'ECF', 'DCTF', 'DCTFWEB', 'SITUACAO_FISCAL', 'PGDAS', 'COMPROVANTE_ARRECADACAO', 'ESOCIAL', 'EFD_REINF', 'CARTAO_CNPJ', 'CONTRATO_SOCIAL', 'PLANILHA', 'DESCONHECIDO');

-- CreateEnum
CREATE TYPE "StatusProcessamento" AS ENUM ('PENDENTE', 'PROCESSANDO', 'CONCLUIDO', 'ERRO', 'IGNORADO');

-- CreateEnum
CREATE TYPE "DirecaoNota" AS ENUM ('ENTRADA', 'SAIDA');

-- CreateEnum
CREATE TYPE "SituacaoNota" AS ENUM ('AUTORIZADA', 'CANCELADA', 'DENEGADA', 'INUTILIZADA');

-- CreateEnum
CREATE TYPE "TipoContribuicao" AS ENUM ('PIS', 'COFINS');

-- CreateEnum
CREATE TYPE "Severidade" AS ENUM ('CRITICO', 'ALTO', 'MEDIO', 'BAIXO', 'OPORTUNIDADE');

-- CreateEnum
CREATE TYPE "Confianca" AS ENUM ('ALTA', 'MEDIA', 'BAIXA');

-- CreateEnum
CREATE TYPE "SituacaoPrescricional" AS ENUM ('EXIGIVEL', 'A_DECAIR', 'DECAIDO');

-- CreateEnum
CREATE TYPE "FormatoRelatorio" AS ENUM ('TELA', 'PDF', 'XLSX', 'APRESENTACAO');

-- CreateTable
CREATE TABLE "Organizacao" (
    "id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "cnpj" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Organizacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Usuario" (
    "id" TEXT NOT NULL,
    "organizacaoId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "senhaHash" TEXT NOT NULL,
    "papel" "PapelUsuario" NOT NULL DEFAULT 'AUDITOR',
    "ativo" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Empresa" (
    "id" TEXT NOT NULL,
    "organizacaoId" TEXT NOT NULL,
    "cnpj" TEXT NOT NULL,
    "razaoSocial" TEXT NOT NULL,
    "nomeFantasia" TEXT,
    "naturezaJuridica" TEXT,
    "cnaePrincipal" TEXT,
    "cnaesSecundarios" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "uf" TEXT,
    "municipio" TEXT,
    "inscricaoEstadual" TEXT,
    "inscricaoMunicipal" TEXT,
    "capitalSocial" DECIMAL(18,2),
    "dataAbertura" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Empresa_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RegimePorExercicio" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "exercicio" INTEGER NOT NULL,
    "regime" "RegimeTributario" NOT NULL,
    "origem" TEXT,

    CONSTRAINT "RegimePorExercicio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Socio" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "qualificacao" TEXT,
    "percentual" DECIMAL(9,4),
    "administrador" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Socio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Auditoria" (
    "id" TEXT NOT NULL,
    "empresaId" TEXT NOT NULL,
    "responsavelId" TEXT,
    "titulo" TEXT NOT NULL,
    "competenciaIni" VARCHAR(7) NOT NULL,
    "competenciaFim" VARCHAR(7) NOT NULL,
    "status" "StatusAuditoria" NOT NULL DEFAULT 'RASCUNHO',
    "nivelAlcancado" "NivelAuditoria",
    "totalDebitoAberto" DECIMAL(18,2),
    "totalRiscoAutuacao" DECIMAL(18,2),
    "totalRecuperavel" DECIMAL(18,2),
    "executadaEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Auditoria_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lacuna" (
    "id" TEXT NOT NULL,
    "auditoriaId" TEXT NOT NULL,
    "escopo" TEXT NOT NULL,
    "documentoFaltante" "TipoDocumento" NOT NULL,
    "competencia" VARCHAR(7),
    "descricao" TEXT NOT NULL,

    CONSTRAINT "Lacuna_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Documento" (
    "id" TEXT NOT NULL,
    "auditoriaId" TEXT NOT NULL,
    "nomeArquivo" TEXT NOT NULL,
    "tipo" "TipoDocumento" NOT NULL,
    "tipoInformado" "TipoDocumento",
    "tamanhoBytes" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "caminho" TEXT NOT NULL,
    "status" "StatusProcessamento" NOT NULL DEFAULT 'PENDENTE',
    "parser" TEXT,
    "registrosExtraidos" INTEGER NOT NULL DEFAULT 0,
    "erros" JSONB,
    "metadados" JSONB,
    "processadoEm" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Documento_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotaFiscal" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "chave" VARCHAR(44),
    "modelo" VARCHAR(2) NOT NULL,
    "serie" TEXT,
    "numero" TEXT NOT NULL,
    "direcao" "DirecaoNota" NOT NULL,
    "situacao" "SituacaoNota" NOT NULL DEFAULT 'AUTORIZADA',
    "dataEmissao" TIMESTAMP(3) NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "cnpjEmitente" TEXT NOT NULL,
    "cnpjDestinatario" TEXT,
    "ufDestino" TEXT,
    "consumidorFinal" BOOLEAN,
    "destinatarioContribuinte" BOOLEAN,
    "valorTotal" DECIMAL(18,2) NOT NULL,
    "valorProdutos" DECIMAL(18,2),
    "baseIcms" DECIMAL(18,2),
    "valorIcms" DECIMAL(18,2),
    "valorIcmsSt" DECIMAL(18,2),
    "valorIpi" DECIMAL(18,2),
    "valorPis" DECIMAL(18,2),
    "valorCofins" DECIMAL(18,2),
    "valorIss" DECIMAL(18,2),
    "escriturada" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NotaFiscal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotaFiscalItem" (
    "id" TEXT NOT NULL,
    "notaId" TEXT NOT NULL,
    "numeroItem" INTEGER NOT NULL,
    "codigo" TEXT,
    "descricao" TEXT,
    "ncm" VARCHAR(8),
    "cfop" VARCHAR(4),
    "cstIcms" VARCHAR(3),
    "cstPis" VARCHAR(2),
    "cstCofins" VARCHAR(2),
    "quantidade" DECIMAL(18,4),
    "valorItem" DECIMAL(18,2) NOT NULL,
    "aliqIcms" DECIMAL(9,4),

    CONSTRAINT "NotaFiscalItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApuracaoFiscal" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "uf" TEXT,
    "debitos" DECIMAL(18,2) NOT NULL,
    "creditos" DECIMAL(18,2) NOT NULL,
    "saldoCredorAnterior" DECIMAL(18,2),
    "deducoes" DECIMAL(18,2),
    "icmsARecolher" DECIMAL(18,2) NOT NULL,
    "saldoCredorTransportar" DECIMAL(18,2),
    "registroOrigem" TEXT,
    "linhaOrigem" INTEGER,

    CONSTRAINT "ApuracaoFiscal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApuracaoContribuicoes" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "contribuicao" "TipoContribuicao" NOT NULL,
    "baseCalculo" DECIMAL(18,2),
    "valorApurado" DECIMAL(18,2) NOT NULL,
    "creditos" DECIMAL(18,2),
    "retencoes" DECIMAL(18,2),
    "aRecolher" DECIMAL(18,2) NOT NULL,
    "registroOrigem" TEXT,
    "linhaOrigem" INTEGER,

    CONSTRAINT "ApuracaoContribuicoes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApuracaoSimples" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "rbt12" DECIMAL(18,2) NOT NULL,
    "receitaBruta" DECIMAL(18,2) NOT NULL,
    "anexo" TEXT,
    "aliquotaEfetiva" DECIMAL(9,4),
    "fatorR" DECIMAL(9,4),
    "valorDas" DECIMAL(18,2) NOT NULL,
    "icmsForaDas" DECIMAL(18,2),
    "issForaDas" DECIMAL(18,2),

    CONSTRAINT "ApuracaoSimples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LancamentoContabil" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "data" TIMESTAMP(3) NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "numeroLancamento" TEXT,
    "contaCodigo" TEXT NOT NULL,
    "contaNome" TEXT,
    "natureza" VARCHAR(1) NOT NULL,
    "valor" DECIMAL(18,2) NOT NULL,
    "historico" TEXT,
    "linhaOrigem" INTEGER,

    CONSTRAINT "LancamentoContabil_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SaldoConta" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "contaCodigo" TEXT NOT NULL,
    "contaNome" TEXT,
    "classificacao" TEXT,
    "saldoInicial" DECIMAL(18,2) NOT NULL,
    "debitos" DECIMAL(18,2) NOT NULL,
    "creditos" DECIMAL(18,2) NOT NULL,
    "saldoFinal" DECIMAL(18,2) NOT NULL,
    "naturezaSaldo" VARCHAR(1) NOT NULL,
    "linhaOrigem" INTEGER,

    CONSTRAINT "SaldoConta_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApuracaoEcf" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "exercicio" INTEGER NOT NULL,
    "periodo" VARCHAR(7) NOT NULL,
    "tributo" VARCHAR(5) NOT NULL,
    "receitaDeclarada" DECIMAL(18,2),
    "lucroContabil" DECIMAL(18,2),
    "adicoes" DECIMAL(18,2),
    "exclusoes" DECIMAL(18,2),
    "baseCalculo" DECIMAL(18,2) NOT NULL,
    "valorApurado" DECIMAL(18,2) NOT NULL,
    "adicional" DECIMAL(18,2),
    "deducoes" DECIMAL(18,2),
    "aPagar" DECIMAL(18,2) NOT NULL,
    "registroOrigem" TEXT,
    "linhaOrigem" INTEGER,

    CONSTRAINT "ApuracaoEcf_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Confissao" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "tributo" VARCHAR(20) NOT NULL,
    "codigoReceita" VARCHAR(6),
    "valorDebito" DECIMAL(18,2) NOT NULL,
    "valorPago" DECIMAL(18,2),
    "valorCompensado" DECIMAL(18,2),
    "valorParcelado" DECIMAL(18,2),
    "valorSuspenso" DECIMAL(18,2),
    "saldoDevedor" DECIMAL(18,2),

    CONSTRAINT "Confissao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Arrecadacao" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "tributo" VARCHAR(20) NOT NULL,
    "codigoReceita" VARCHAR(6),
    "dataPagamento" TIMESTAMP(3),
    "dataVencimento" TIMESTAMP(3),
    "principal" DECIMAL(18,2) NOT NULL,
    "multa" DECIMAL(18,2),
    "juros" DECIMAL(18,2),
    "valorTotal" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "Arrecadacao_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PendenciaFiscal" (
    "id" TEXT NOT NULL,
    "documentoId" TEXT NOT NULL,
    "competencia" VARCHAR(7),
    "tributo" VARCHAR(20),
    "descricao" TEXT NOT NULL,
    "natureza" TEXT NOT NULL,
    "valor" DECIMAL(18,2),
    "situacao" TEXT,

    CONSTRAINT "PendenciaFiscal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompetenciaConsolidada" (
    "id" TEXT NOT NULL,
    "auditoriaId" TEXT NOT NULL,
    "competencia" VARCHAR(7) NOT NULL,
    "tributo" VARCHAR(20) NOT NULL,
    "apurado" DECIMAL(18,2),
    "confessado" DECIMAL(18,2),
    "pago" DECIMAL(18,2),
    "compensado" DECIMAL(18,2),
    "parcelado" DECIMAL(18,2),
    "suspenso" DECIMAL(18,2),
    "emAberto" DECIMAL(18,2),
    "receitaReal" DECIMAL(18,2),
    "receitaEscriturada" DECIMAL(18,2),
    "receitaContabil" DECIMAL(18,2),
    "origens" JSONB,

    CONSTRAINT "CompetenciaConsolidada_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Achado" (
    "id" TEXT NOT NULL,
    "auditoriaId" TEXT NOT NULL,
    "codigo" VARCHAR(6) NOT NULL,
    "titulo" TEXT NOT NULL,
    "familia" TEXT NOT NULL,
    "severidade" "Severidade" NOT NULL,
    "confianca" "Confianca" NOT NULL DEFAULT 'ALTA',
    "tributo" VARCHAR(20),
    "competencia" VARCHAR(7),
    "exercicio" INTEGER,
    "descricao" TEXT NOT NULL,
    "textoCliente" TEXT,
    "recomendacao" TEXT,
    "valorExposicao" DECIMAL(18,2),
    "valorAtualizado" DECIMAL(18,2),
    "baseLegal" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "situacaoPrescricional" "SituacaoPrescricional" NOT NULL DEFAULT 'EXIGIVEL',
    "decaiEm" TIMESTAMP(3),
    "regraDecadencia" TEXT,
    "ressalva" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Achado_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidencia" (
    "id" TEXT NOT NULL,
    "achadoId" TEXT NOT NULL,
    "documentoId" TEXT,
    "arquivo" TEXT NOT NULL,
    "registro" TEXT,
    "linha" INTEGER,
    "campo" TEXT,
    "valor" TEXT,
    "observacao" TEXT,

    CONSTRAINT "Evidencia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Relatorio" (
    "id" TEXT NOT NULL,
    "auditoriaId" TEXT NOT NULL,
    "formato" "FormatoRelatorio" NOT NULL,
    "caminho" TEXT,
    "geradoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "snapshot" JSONB,

    CONSTRAINT "Relatorio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LogAuditoria" (
    "id" TEXT NOT NULL,
    "usuarioId" TEXT,
    "acao" TEXT NOT NULL,
    "entidade" TEXT NOT NULL,
    "entidadeId" TEXT,
    "detalhes" JSONB,
    "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LogAuditoria_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_email_key" ON "Usuario"("email");

-- CreateIndex
CREATE INDEX "Usuario_organizacaoId_idx" ON "Usuario"("organizacaoId");

-- CreateIndex
CREATE INDEX "Empresa_cnpj_idx" ON "Empresa"("cnpj");

-- CreateIndex
CREATE UNIQUE INDEX "Empresa_organizacaoId_cnpj_key" ON "Empresa"("organizacaoId", "cnpj");

-- CreateIndex
CREATE INDEX "RegimePorExercicio_empresaId_idx" ON "RegimePorExercicio"("empresaId");

-- CreateIndex
CREATE UNIQUE INDEX "RegimePorExercicio_empresaId_exercicio_key" ON "RegimePorExercicio"("empresaId", "exercicio");

-- CreateIndex
CREATE INDEX "Socio_empresaId_idx" ON "Socio"("empresaId");

-- CreateIndex
CREATE INDEX "Auditoria_empresaId_idx" ON "Auditoria"("empresaId");

-- CreateIndex
CREATE INDEX "Auditoria_status_idx" ON "Auditoria"("status");

-- CreateIndex
CREATE INDEX "Lacuna_auditoriaId_idx" ON "Lacuna"("auditoriaId");

-- CreateIndex
CREATE INDEX "Documento_auditoriaId_tipo_idx" ON "Documento"("auditoriaId", "tipo");

-- CreateIndex
CREATE INDEX "Documento_status_idx" ON "Documento"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Documento_auditoriaId_hash_key" ON "Documento"("auditoriaId", "hash");

-- CreateIndex
CREATE INDEX "NotaFiscal_documentoId_idx" ON "NotaFiscal"("documentoId");

-- CreateIndex
CREATE INDEX "NotaFiscal_chave_idx" ON "NotaFiscal"("chave");

-- CreateIndex
CREATE INDEX "NotaFiscal_competencia_direcao_idx" ON "NotaFiscal"("competencia", "direcao");

-- CreateIndex
CREATE INDEX "NotaFiscalItem_notaId_idx" ON "NotaFiscalItem"("notaId");

-- CreateIndex
CREATE INDEX "NotaFiscalItem_ncm_idx" ON "NotaFiscalItem"("ncm");

-- CreateIndex
CREATE INDEX "ApuracaoFiscal_competencia_idx" ON "ApuracaoFiscal"("competencia");

-- CreateIndex
CREATE UNIQUE INDEX "ApuracaoFiscal_documentoId_competencia_key" ON "ApuracaoFiscal"("documentoId", "competencia");

-- CreateIndex
CREATE INDEX "ApuracaoContribuicoes_competencia_idx" ON "ApuracaoContribuicoes"("competencia");

-- CreateIndex
CREATE UNIQUE INDEX "ApuracaoContribuicoes_documentoId_competencia_contribuicao_key" ON "ApuracaoContribuicoes"("documentoId", "competencia", "contribuicao");

-- CreateIndex
CREATE INDEX "ApuracaoSimples_competencia_idx" ON "ApuracaoSimples"("competencia");

-- CreateIndex
CREATE UNIQUE INDEX "ApuracaoSimples_documentoId_competencia_key" ON "ApuracaoSimples"("documentoId", "competencia");

-- CreateIndex
CREATE INDEX "LancamentoContabil_documentoId_competencia_idx" ON "LancamentoContabil"("documentoId", "competencia");

-- CreateIndex
CREATE INDEX "LancamentoContabil_contaCodigo_idx" ON "LancamentoContabil"("contaCodigo");

-- CreateIndex
CREATE INDEX "SaldoConta_competencia_classificacao_idx" ON "SaldoConta"("competencia", "classificacao");

-- CreateIndex
CREATE UNIQUE INDEX "SaldoConta_documentoId_competencia_contaCodigo_key" ON "SaldoConta"("documentoId", "competencia", "contaCodigo");

-- CreateIndex
CREATE INDEX "ApuracaoEcf_documentoId_exercicio_idx" ON "ApuracaoEcf"("documentoId", "exercicio");

-- CreateIndex
CREATE INDEX "Confissao_documentoId_competencia_idx" ON "Confissao"("documentoId", "competencia");

-- CreateIndex
CREATE INDEX "Confissao_tributo_competencia_idx" ON "Confissao"("tributo", "competencia");

-- CreateIndex
CREATE INDEX "Arrecadacao_documentoId_competencia_idx" ON "Arrecadacao"("documentoId", "competencia");

-- CreateIndex
CREATE INDEX "Arrecadacao_tributo_competencia_idx" ON "Arrecadacao"("tributo", "competencia");

-- CreateIndex
CREATE INDEX "PendenciaFiscal_documentoId_idx" ON "PendenciaFiscal"("documentoId");

-- CreateIndex
CREATE INDEX "CompetenciaConsolidada_auditoriaId_competencia_idx" ON "CompetenciaConsolidada"("auditoriaId", "competencia");

-- CreateIndex
CREATE UNIQUE INDEX "CompetenciaConsolidada_auditoriaId_competencia_tributo_key" ON "CompetenciaConsolidada"("auditoriaId", "competencia", "tributo");

-- CreateIndex
CREATE INDEX "Achado_auditoriaId_severidade_idx" ON "Achado"("auditoriaId", "severidade");

-- CreateIndex
CREATE INDEX "Achado_auditoriaId_codigo_idx" ON "Achado"("auditoriaId", "codigo");

-- CreateIndex
CREATE INDEX "Achado_competencia_idx" ON "Achado"("competencia");

-- CreateIndex
CREATE INDEX "Evidencia_achadoId_idx" ON "Evidencia"("achadoId");

-- CreateIndex
CREATE INDEX "Relatorio_auditoriaId_idx" ON "Relatorio"("auditoriaId");

-- CreateIndex
CREATE INDEX "LogAuditoria_entidade_entidadeId_idx" ON "LogAuditoria"("entidade", "entidadeId");

-- CreateIndex
CREATE INDEX "LogAuditoria_criadoEm_idx" ON "LogAuditoria"("criadoEm");

-- AddForeignKey
ALTER TABLE "Usuario" ADD CONSTRAINT "Usuario_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Empresa" ADD CONSTRAINT "Empresa_organizacaoId_fkey" FOREIGN KEY ("organizacaoId") REFERENCES "Organizacao"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RegimePorExercicio" ADD CONSTRAINT "RegimePorExercicio_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "Empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Socio" ADD CONSTRAINT "Socio_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "Empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auditoria" ADD CONSTRAINT "Auditoria_empresaId_fkey" FOREIGN KEY ("empresaId") REFERENCES "Empresa"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Auditoria" ADD CONSTRAINT "Auditoria_responsavelId_fkey" FOREIGN KEY ("responsavelId") REFERENCES "Usuario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lacuna" ADD CONSTRAINT "Lacuna_auditoriaId_fkey" FOREIGN KEY ("auditoriaId") REFERENCES "Auditoria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Documento" ADD CONSTRAINT "Documento_auditoriaId_fkey" FOREIGN KEY ("auditoriaId") REFERENCES "Auditoria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaFiscal" ADD CONSTRAINT "NotaFiscal_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotaFiscalItem" ADD CONSTRAINT "NotaFiscalItem_notaId_fkey" FOREIGN KEY ("notaId") REFERENCES "NotaFiscal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApuracaoFiscal" ADD CONSTRAINT "ApuracaoFiscal_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApuracaoContribuicoes" ADD CONSTRAINT "ApuracaoContribuicoes_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApuracaoSimples" ADD CONSTRAINT "ApuracaoSimples_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LancamentoContabil" ADD CONSTRAINT "LancamentoContabil_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SaldoConta" ADD CONSTRAINT "SaldoConta_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApuracaoEcf" ADD CONSTRAINT "ApuracaoEcf_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Confissao" ADD CONSTRAINT "Confissao_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Arrecadacao" ADD CONSTRAINT "Arrecadacao_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendenciaFiscal" ADD CONSTRAINT "PendenciaFiscal_documentoId_fkey" FOREIGN KEY ("documentoId") REFERENCES "Documento"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompetenciaConsolidada" ADD CONSTRAINT "CompetenciaConsolidada_auditoriaId_fkey" FOREIGN KEY ("auditoriaId") REFERENCES "Auditoria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Achado" ADD CONSTRAINT "Achado_auditoriaId_fkey" FOREIGN KEY ("auditoriaId") REFERENCES "Auditoria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidencia" ADD CONSTRAINT "Evidencia_achadoId_fkey" FOREIGN KEY ("achadoId") REFERENCES "Achado"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Relatorio" ADD CONSTRAINT "Relatorio_auditoriaId_fkey" FOREIGN KEY ("auditoriaId") REFERENCES "Auditoria"("id") ON DELETE CASCADE ON UPDATE CASCADE;

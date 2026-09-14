import { PrismaClient } from "@prisma/client";

/**
 * Cliente único. Em desenvolvimento o Next recarrega o módulo a cada alteração;
 * sem o cache no globalThis, cada recarga abriria um pool novo e o Postgres
 * esgotaria as conexões em poucos minutos de trabalho.
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

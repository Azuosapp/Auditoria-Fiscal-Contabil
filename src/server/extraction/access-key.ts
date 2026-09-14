/**
 * Validação da chave de acesso de NF-e/NFC-e/CT-e: 44 dígitos, sendo o último
 * o dígito verificador (DV) calculado por módulo 11 sobre os 43 anteriores,
 * pesos 2..9 cíclicos da direita para a esquerda.
 *
 * Algoritmo público e estável (Manual de Orientação do Contribuinte da NF-e,
 * Anexo IV — cálculo do dígito verificador da chave de acesso). Não depende de
 * versão de leiaute do SPED, por isso a confiança aqui é alta mesmo sem poder
 * confirmar a fonte online nesta sessão (ver observação no relatório de
 * importação do SPED).
 */
export function isValidAccessKeyFormat(key: string): boolean {
  return /^\d{44}$/.test(key);
}

/** Calcula o DV esperado para os 43 primeiros dígitos de uma chave de 44 dígitos. */
export function computeAccessKeyCheckDigit(first43: string): number {
  let sum = 0;
  let weight = 2;
  for (let i = first43.length - 1; i >= 0; i--) {
    sum += Number(first43[i]) * weight;
    weight = weight === 9 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  return remainder < 2 ? 0 : 11 - remainder;
}

/** Valida formato (44 dígitos) e dígito verificador da chave de acesso. */
export function isValidAccessKey(key: string | undefined): boolean {
  if (!key) return false;
  if (!isValidAccessKeyFormat(key)) return false;
  const expectedDv = computeAccessKeyCheckDigit(key.slice(0, 43));
  return expectedDv === Number(key[43]);
}

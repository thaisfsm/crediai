import "server-only";
import { randomInt } from "node:crypto";

// Sem caracteres que se confundem na leitura (0/O, 1/l/I), para a administradora repassar a senha sem erro.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

// Senha provisória: 4 grupos de 4 caracteres sorteados com gerador criptográfico (cerca de 90 bits).
export function generateTemporaryPassword() {
  return Array.from({ length: 4 }, () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("")).join("-");
}

// Mesmo hash que o Better Auth usa no login (respeita a configuração de emailAndPassword).
export async function hashPassword(password: string) {
  const { auth } = await import("@/lib/auth");
  const context = await auth.$context;
  return context.password.hash(password);
}

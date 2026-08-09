import bcrypt from 'bcryptjs';

export function hashPassword(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

export function verifyPassword(pw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(pw, hash);
}

// Operator auth: OPERATOR_EMAIL + bcrypt hash of the operator password in env.
export async function hashForEnv(pw: string): Promise<string> {
  return bcrypt.hash(pw, 12);
}

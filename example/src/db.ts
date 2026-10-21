// @state DB層
// @state-group データ層
// @state-desc ユーザーとセッションを持つメモリ上のストア

export type User = { readonly email: string; readonly password: string };
export type Session = { readonly email: string };

const users = new Map<string, User>();
let current: Session | null = null;

export function findUser(email: string): User | undefined {
  return users.get(email);
}

export function saveUser(user: User): void {
  users.set(user.email, user);
}

export function createSession(email: string): Session {
  current = { email };
  return current;
}

export function clearSession(): void {
  current = null;
}

export function currentSession(): Session | null {
  return current;
}

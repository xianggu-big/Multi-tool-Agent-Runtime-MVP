const users = new Map();

export function findUserByEmail(email) {
  return users.get(email) ?? null;
}

export function createUser(email, passwordHash) {
  const user = { email, passwordHash, lastLoginAt: null };
  users.set(email, user);
  return user;
}

export function updateLastLogin(email, at = Date.now()) {
  const user = findUserByEmail(email);
  if (!user) return null;
  user.lastLoginAt = at;
  return user;
}
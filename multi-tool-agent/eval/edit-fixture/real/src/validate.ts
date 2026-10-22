export interface User {
  name: string;
  age: number;
  email: string;
}

export function validateUser(input: Partial<User>): string[] {
  const errors: string[] = [];
  if (!input.name || input.name.trim() === '') errors.push('name is required');
  if (typeof input.age !== 'number' || input.age < 0 || input.age > 150) errors.push('age must be 0..150');
  if (!input.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) errors.push('email is invalid');
  return errors;
}
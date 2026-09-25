export function total(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

export function first<T>(xs: T[]): T | undefined {
  return xs[0];
}

/** Enumerate every sequence up to a small bound, including the empty one. */
export function* sequences<T>(
  values: readonly T[],
  maxLength: number,
): Generator<T[]> {
  yield [];
  if (maxLength === 0) return;
  for (const head of values) {
    for (const tail of sequences(values, maxLength - 1)) yield [head, ...tail];
  }
}

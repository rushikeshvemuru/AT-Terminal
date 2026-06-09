/**
 * Creates a debounced version of a function that delays invocation until after wait milliseconds.
 * @param fn - Function to debounce
 * @param wait - Milliseconds to wait before invoking
 * @returns Debounced function
 */
export function debounce<T extends (...args: unknown[]) => unknown>(fn: T, wait: number): T {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  return ((...args: Parameters<T>) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      fn(...args);
    }, wait);
  }) as T;
}

/**
 * Creates a debounced callback for a specific value setter.
 * @param setValue - Function that takes a single value
 * @param wait - Milliseconds to wait before invoking
 * @returns Debounced function
 */
export function debounceValue<T>(setValue: (value: T) => void, wait: number) {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  return (value: T) => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      setValue(value);
    }, wait);
  };
}

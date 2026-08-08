import { Converter } from 'opencc-js/t2cn';

const convert = Converter({ from: 'tw', to: 'cn' });

export function toSimplified<T>(value: T): T {
  if (typeof value === 'string') return convert(value) as T;
  if (Array.isArray(value)) return value.map(item => toSimplified(item)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toSimplified(item)])) as T;
  }
  return value;
}

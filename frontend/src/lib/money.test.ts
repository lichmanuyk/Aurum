import { describe, expect, it } from 'vitest';
import { parseDecimalAmount } from './csv';
import { formatMoney } from './format';

describe('native money precision', () => {
  it('preserves exact decimal digits at the supported upper bound', () => {
    expect(parseDecimalAmount('999999999999.99', 'dot-decimal')).toBe('999999999999.99');
    expect(parseDecimalAmount('-1 234,56', 'comma-decimal')).toBe('-1234.56');
    expect(parseDecimalAmount('0.10', 'dot-decimal')).toBe('0.10');
  });
  it('rejects excess precision rather than silently rounding an import', () => {
    expect(parseDecimalAmount('1.005', 'dot-decimal')).toBe('1.005');
    expect(parseDecimalAmount('1.0000001', 'dot-decimal')).toBeNull();
    expect(parseDecimalAmount('1000000000000', 'dot-decimal')).toBeNull();
    expect(parseDecimalAmount('Infinity')).toBeNull();
  });
  it('shows native cents and distinguishes currencies', () => {
    expect(formatMoney('431.27', 'PLN')).toMatch(/431[,.]27/);
    expect(formatMoney('100.00', 'EUR')).toContain('€');
    expect(formatMoney('100', 'JPY')).not.toMatch(/[,.]00/);
  });
});

it('displays sub-cents without converting an exact decimal string to a binary float', () => {
  expect(formatMoney('20.003', 'USD')).toMatch(/20[,.]003/);
  expect(formatMoney('-10.123456', 'USD')).toMatch(/-10[,.]123456/);
  expect(formatMoney('999999999999.123456', 'USD')).toMatch(/[,.]123456/);
});

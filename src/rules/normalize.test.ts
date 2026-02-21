import { describe, it, expect } from 'vitest';
import { extractMatchValue } from './normalize.js';

describe('extractMatchValue', () => {
  // ── Examples straight from the docblock ──────────────────────────────────

  it('strips asterisk transaction code (rule 1)', () => {
    expect(extractMatchValue('AMAZON MKTPL*0C2091XO3')).toBe('AMAZON MKTPL');
    expect(extractMatchValue('Amazon.com*0K3MH0VR3')).toBe('Amazon.com');
    expect(extractMatchValue('Amazon Kids+*4R0KO2MY3')).toBe('Amazon Kids+');
  });

  it('strips trailing dash (rule 2)', () => {
    expect(extractMatchValue('TST* THE HAMPTON SOCIAL -')).toBe('TST* THE HAMPTON SOCIAL');
  });

  it('strips dash-separated location code (rule 3)', () => {
    expect(extractMatchValue('TST* CORIANDER GOLDEN - N')).toBe('TST* CORIANDER GOLDEN');
    expect(extractMatchValue('TST* JAMBA JUICE - 1286 -')).toBe('TST* JAMBA JUICE');
  });

  it('strips hash-prefixed number (rule 4)', () => {
    expect(extractMatchValue('A-B PETROLEUM #34')).toBe('A-B PETROLEUM');
    expect(extractMatchValue('WHOLEFDS #1234')).toBe('WHOLEFDS');
  });

  it('strips double-space location code (rule 5)', () => {
    expect(extractMatchValue('TST* CHIRINGUITO LLC  ARL')).toBe('TST* CHIRINGUITO LLC');
    expect(extractMatchValue('TST* SOME PLACE  BWI')).toBe('TST* SOME PLACE');
  });

  it('strips trailing 4+ digit number (rule 6)', () => {
    expect(extractMatchValue('2ND AND CHARLES 2149')).toBe('2ND AND CHARLES');
  });

  // ── Multi-rule stripping (loop) ───────────────────────────────────────────

  it('applies multiple rules in sequence', () => {
    // e.g. code after * AND trailing dash: "TST* JAMBA JUICE - 1286 -"
    // rule 3 strips " - 1286 -", then rule 2 strips any remaining trailing dash
    expect(extractMatchValue('TST* JAMBA JUICE - 1286 -')).toBe('TST* JAMBA JUICE');
  });

  // ── No stripping needed ───────────────────────────────────────────────────

  it('returns clean payees unchanged', () => {
    expect(extractMatchValue('STARBUCKS')).toBe('STARBUCKS');
    expect(extractMatchValue('NETFLIX.COM')).toBe('NETFLIX.COM');
    expect(extractMatchValue('A-B PETROLEUM')).toBe('A-B PETROLEUM');
  });

  it('trims surrounding whitespace', () => {
    expect(extractMatchValue('  STARBUCKS  ')).toBe('STARBUCKS');
  });

  // ── Minimum length guard (4 chars) ───────────────────────────────────────

  it('does not strip below 4-character minimum', () => {
    // "GAS #1" → strip "#1" → "GAS" (3 chars) — should NOT strip
    expect(extractMatchValue('GAS #1')).toBe('GAS #1');
  });

  it('strips when result is exactly 4 chars', () => {
    // "FUEL #123" → "FUEL" (4 chars) — should strip
    expect(extractMatchValue('FUEL #123')).toBe('FUEL');
  });

  // ── Legitimate trailing numbers that shouldn't be stripped ───────────────

  it('does not strip 3-digit numbers (only 4+ digit rule 6)', () => {
    // "STORE 24" — only 2 digits, rule 6 requires 4+
    expect(extractMatchValue('STORE 24')).toBe('STORE 24');
    expect(extractMatchValue('HWY 41')).toBe('HWY 41');
  });

  // ── Edge cases added to improve coverage ─────────────────────────────────

  it('does not strip mid-name numbers like "7-ELEVEN"', () => {
    // The dash is surrounded by non-whitespace; no rule matches
    expect(extractMatchValue('7-ELEVEN')).toBe('7-ELEVEN');
  });

  it('does not strip an all-numeric string', () => {
    // Rule 6 requires leading whitespace before the digits, so "1234" alone is not stripped
    expect(extractMatchValue('1234')).toBe('1234');
  });

  it('does not strip asterisk code when base would be too short', () => {
    // "T*0C2091XO3" → would strip to "T" (1 char) — minimum guard prevents strip
    expect(extractMatchValue('T*0C2091XO3')).toBe('T*0C2091XO3');
  });

  it('strips eight-digit trailing number that looks like a date (rule 6, as-designed)', () => {
    // Rule 6 strips any 4+ digit trailing number, including 8-digit dates
    expect(extractMatchValue('PAYROLL 20261215')).toBe('PAYROLL');
  });
});

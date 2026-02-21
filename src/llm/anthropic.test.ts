import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(() => ({ messages: { create: mockCreate } })),
}));

import { AnthropicAdapter, DEFAULT_FAST_MODEL, DEFAULT_REVIEW_MODEL } from './anthropic.js';

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter;

  beforeEach(() => {
    mockCreate.mockReset();
    adapter = new AnthropicAdapter('test-key');
  });

  // ── proposePayee ─────────────────────────────────────────────────────────────

  describe('proposePayee', () => {
    it('returns trimmed text from response', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: '  Amazon  ' }],
        stop_reason: 'end_turn',
      });
      expect(await adapter.proposePayee('AMAZON MKTPL 12345', [])).toBe('Amazon');
    });

    it('falls back to rawPayee when no text block is present', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'x', name: 'foo', input: {} }],
        stop_reason: 'end_turn',
      });
      expect(await adapter.proposePayee('AMAZON MKTPL 12345', [])).toBe('AMAZON MKTPL 12345');
    });

    it('falls back to rawPayee when content is empty', async () => {
      mockCreate.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
      expect(await adapter.proposePayee('RAW PAYEE', [])).toBe('RAW PAYEE');
    });

    it('uses the default fast model', async () => {
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'X' }], stop_reason: 'end_turn' });
      await adapter.proposePayee('PAYEE', []);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_FAST_MODEL }));
    });

    it('respects fastModel override', async () => {
      const custom = new AnthropicAdapter('key', { fastModel: 'my-fast-model' });
      mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'X' }], stop_reason: 'end_turn' });
      await custom.proposePayee('PAYEE', []);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'my-fast-model' }));
    });
  });

  // ── proposeCategory ──────────────────────────────────────────────────────────

  describe('proposeCategory', () => {
    it('returns trimmed category text', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: ' Groceries ' }],
        stop_reason: 'end_turn',
      });
      expect(await adapter.proposeCategory('Amazon Fresh', ['Groceries', 'Shopping'])).toBe('Groceries');
    });

    it('falls back to first category when content is empty', async () => {
      mockCreate.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
      expect(await adapter.proposeCategory('Amazon Fresh', ['Groceries', 'Shopping'])).toBe('Groceries');
    });

    it('falls back to first category when no text block is present', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'x', name: 'foo', input: {} }],
        stop_reason: 'end_turn',
      });
      expect(await adapter.proposeCategory('Amazon Fresh', ['Groceries', 'Shopping'])).toBe('Groceries');
    });
  });

  // ── reviewGroupings ──────────────────────────────────────────────────────────

  describe('reviewGroupings', () => {
    it('returns empty array for empty input without calling API', async () => {
      expect(await adapter.reviewGroupings([])).toEqual([]);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('warns when stop_reason is max_tokens', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockCreate.mockResolvedValue({ content: [], stop_reason: 'max_tokens' });
      await adapter.reviewGroupings([{ cleanPayee: 'Amazon', category: 'Shopping', rawPayees: ['AMZN'] }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('token limit'));
      warn.mockRestore();
    });

    it('returns empty array when no tool_use block is found', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'nothing useful' }],
        stop_reason: 'end_turn',
      });
      const result = await adapter.reviewGroupings([{ cleanPayee: 'Amazon', category: 'Shopping', rawPayees: ['AMZN'] }]);
      expect(result).toEqual([]);
    });

    it('extracts suggestions from tool_use block', async () => {
      const suggestions = [{ type: 'rename', cleanPayee: 'Amazon', reason: 'Too generic', suggestedName: 'Amazon Marketplace' }];
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'x', name: 'report_anomalies', input: { suggestions } }],
        stop_reason: 'tool_use',
      });
      const result = await adapter.reviewGroupings([{ cleanPayee: 'Amazon', category: 'Shopping', rawPayees: ['AMZN'] }]);
      expect(result).toEqual(suggestions);
    });

    it('uses the default review model', async () => {
      mockCreate.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
      await adapter.reviewGroupings([{ cleanPayee: 'Amazon', category: null, rawPayees: ['AMZN'] }]);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_REVIEW_MODEL }));
    });

    it('respects reviewModel override', async () => {
      const custom = new AnthropicAdapter('key', { reviewModel: 'my-review-model' });
      mockCreate.mockResolvedValue({ content: [], stop_reason: 'end_turn' });
      await custom.reviewGroupings([{ cleanPayee: 'Amazon', category: null, rawPayees: ['AMZN'] }]);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'my-review-model' }));
    });
  });

  // ── suggestConsolidation ─────────────────────────────────────────────────────

  describe('suggestConsolidation', () => {
    it('returns empty array for empty input without calling API', async () => {
      expect(await adapter.suggestConsolidation([])).toEqual([]);
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('warns when stop_reason is max_tokens', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockCreate.mockResolvedValue({ content: [], stop_reason: 'max_tokens' });
      await adapter.suggestConsolidation([{ actionValue: 'Amazon', matchValues: ['AMZN', 'AMAZON'] }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('token limit'));
      warn.mockRestore();
    });

    it('returns empty array when no tool_use block is found', async () => {
      mockCreate.mockResolvedValue({
        content: [{ type: 'text', text: 'nothing' }],
        stop_reason: 'end_turn',
      });
      const result = await adapter.suggestConsolidation([{ actionValue: 'Amazon', matchValues: ['AMZN', 'AMAZON'] }]);
      expect(result).toEqual([]);
    });

    it('extracts consolidations from tool_use block', async () => {
      const consolidations = [{ actionValue: 'Amazon', suggestedMatchValue: 'AMZN', reason: 'Common prefix' }];
      mockCreate.mockResolvedValue({
        content: [{ type: 'tool_use', id: 'x', name: 'report_consolidations', input: { consolidations } }],
        stop_reason: 'tool_use',
      });
      const result = await adapter.suggestConsolidation([{ actionValue: 'Amazon', matchValues: ['AMZN', 'AMAZON'] }]);
      expect(result).toEqual(consolidations);
    });
  });
});

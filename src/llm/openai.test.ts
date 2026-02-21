import { vi, describe, it, expect, beforeEach } from 'vitest';

const mockCreate = vi.hoisted(() => vi.fn());

vi.mock('openai', () => ({
  default: vi.fn(() => ({ chat: { completions: { create: mockCreate } } })),
}));

import { OpenAIAdapter, DEFAULT_FAST_MODEL, DEFAULT_REVIEW_MODEL } from './openai.js';

describe('OpenAIAdapter', () => {
  let adapter: OpenAIAdapter;

  beforeEach(() => {
    mockCreate.mockReset();
    adapter = new OpenAIAdapter('test-key');
  });

  // ── proposePayee ─────────────────────────────────────────────────────────────

  describe('proposePayee', () => {
    it('returns trimmed text from response', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '  Amazon  ' }, finish_reason: 'stop' }],
      });
      expect(await adapter.proposePayee('AMAZON MKTPL 12345', [])).toBe('Amazon');
    });

    it('falls back to rawPayee when content is null', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null }, finish_reason: 'stop' }],
      });
      expect(await adapter.proposePayee('AMAZON MKTPL 12345', [])).toBe('AMAZON MKTPL 12345');
    });

    it('uses the default fast model', async () => {
      mockCreate.mockResolvedValue({ choices: [{ message: { content: 'X' }, finish_reason: 'stop' }] });
      await adapter.proposePayee('PAYEE', []);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_FAST_MODEL }));
    });

    it('respects fastModel override', async () => {
      const custom = new OpenAIAdapter('key', { fastModel: 'my-fast-model' });
      mockCreate.mockResolvedValue({ choices: [{ message: { content: 'X' }, finish_reason: 'stop' }] });
      await custom.proposePayee('PAYEE', []);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'my-fast-model' }));
    });
  });

  // ── proposeCategory ──────────────────────────────────────────────────────────

  describe('proposeCategory', () => {
    it('returns trimmed category text', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: ' Groceries ' }, finish_reason: 'stop' }],
      });
      expect(await adapter.proposeCategory('Amazon Fresh', ['Groceries', 'Shopping'])).toBe('Groceries');
    });

    it('falls back to first category when content is null', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null }, finish_reason: 'stop' }],
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

    it('warns when finish_reason is length', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockCreate.mockResolvedValue({
        choices: [{ message: { tool_calls: null }, finish_reason: 'length' }],
      });
      await adapter.reviewGroupings([{ cleanPayee: 'Amazon', category: 'Shopping', rawPayees: ['AMZN'] }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('token limit'));
      warn.mockRestore();
    });

    it('returns empty array when no tool_calls present', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { tool_calls: null }, finish_reason: 'stop' }],
      });
      const result = await adapter.reviewGroupings([{ cleanPayee: 'Amazon', category: 'Shopping', rawPayees: ['AMZN'] }]);
      expect(result).toEqual([]);
    });

    it('extracts suggestions from tool call arguments', async () => {
      const suggestions = [{ type: 'rename', cleanPayee: 'Amazon', reason: 'Too generic', suggestedName: 'Amazon Marketplace' }];
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            tool_calls: [{
              type: 'function',
              function: { name: 'report_anomalies', arguments: JSON.stringify({ suggestions }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      });
      const result = await adapter.reviewGroupings([{ cleanPayee: 'Amazon', category: 'Shopping', rawPayees: ['AMZN'] }]);
      expect(result).toEqual(suggestions);
    });

    it('uses the default review model', async () => {
      mockCreate.mockResolvedValue({ choices: [{ message: { tool_calls: null }, finish_reason: 'stop' }] });
      await adapter.reviewGroupings([{ cleanPayee: 'Amazon', category: null, rawPayees: ['AMZN'] }]);
      expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ model: DEFAULT_REVIEW_MODEL }));
    });

    it('respects reviewModel override', async () => {
      const custom = new OpenAIAdapter('key', { reviewModel: 'my-review-model' });
      mockCreate.mockResolvedValue({ choices: [{ message: { tool_calls: null }, finish_reason: 'stop' }] });
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

    it('warns when finish_reason is length', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockCreate.mockResolvedValue({
        choices: [{ message: { tool_calls: null }, finish_reason: 'length' }],
      });
      await adapter.suggestConsolidation([{ actionValue: 'Amazon', matchValues: ['AMZN', 'AMAZON'] }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('token limit'));
      warn.mockRestore();
    });

    it('returns empty array when no tool_calls present', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { tool_calls: null }, finish_reason: 'stop' }],
      });
      const result = await adapter.suggestConsolidation([{ actionValue: 'Amazon', matchValues: ['AMZN', 'AMAZON'] }]);
      expect(result).toEqual([]);
    });

    it('extracts consolidations from tool call arguments', async () => {
      const consolidations = [{ actionValue: 'Amazon', suggestedMatchValue: 'AMZN', reason: 'Common prefix' }];
      mockCreate.mockResolvedValue({
        choices: [{
          message: {
            tool_calls: [{
              type: 'function',
              function: { name: 'report_consolidations', arguments: JSON.stringify({ consolidations }) },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      });
      const result = await adapter.suggestConsolidation([{ actionValue: 'Amazon', matchValues: ['AMZN', 'AMAZON'] }]);
      expect(result).toEqual(consolidations);
    });
  });
});

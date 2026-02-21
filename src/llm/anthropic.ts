import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, GroupForReview, Suggestion, ConsolidationGroup, ConsolidationSuggestion } from '../types.js';
import { buildProposePayeePrompt, buildProposeCategoryPrompt, buildReviewGroupingsPrompt, buildSuggestConsolidationPrompt } from './prompts.js';

const DEFAULT_FAST_MODEL   = 'claude-haiku-4-5-20251001';
const DEFAULT_REVIEW_MODEL = 'claude-sonnet-4-6';

export class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic;
  private fastModel: string;
  private reviewModel: string;

  constructor(apiKey: string, opts: { fastModel?: string; reviewModel?: string } = {}) {
    this.client      = new Anthropic({ apiKey });
    this.fastModel   = opts.fastModel   ?? DEFAULT_FAST_MODEL;
    this.reviewModel = opts.reviewModel ?? DEFAULT_REVIEW_MODEL;
  }

  async proposePayee(rawPayee: string, knownPayees: string[]): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.fastModel,
      max_tokens: 64,
      messages: [{ role: 'user', content: buildProposePayeePrompt(rawPayee, knownPayees) }],
    });

    return (msg.content[0] as { text: string }).text.trim();
  }

  async proposeCategory(cleanPayee: string, categories: string[]): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.fastModel,
      max_tokens: 64,
      messages: [{ role: 'user', content: buildProposeCategoryPrompt(cleanPayee, categories) }],
    });

    return (msg.content[0] as { text: string }).text.trim();
  }

  async reviewGroupings(groups: GroupForReview[]): Promise<Suggestion[]> {
    if (groups.length === 0) return [];

    const groupText = groups
      .map(g => `- "${g.cleanPayee}" (${g.category ?? 'no category'}): ${g.rawPayees.join(' | ')}`)
      .join('\n');

    const msg = await this.client.messages.create({
      model: this.reviewModel,
      max_tokens: 4096,
      tools: [{
        name: 'report_anomalies',
        description: 'Report anomalies and suggestions for payee groupings',
        input_schema: {
          type: 'object' as const,
          properties: {
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['split', 'rename', 'category', 'flag'] },
                  cleanPayee: { type: 'string', description: 'Current clean payee name this applies to' },
                  rawPayees: { type: 'array', items: { type: 'string' }, description: 'split only: exact raw payee strings to split off (must match exactly)' },
                  suggestedName: { type: 'string', description: 'split/rename: new clean name' },
                  suggestedCategory: { type: 'string', description: 'split/category: new category name' },
                  reason: { type: 'string', description: 'One sentence explanation' },
                },
                required: ['type', 'cleanPayee', 'reason'],
              },
            },
          },
          required: ['suggestions'],
        },
      }],
      tool_choice: { type: 'tool' as const, name: 'report_anomalies' },
      messages: [{ role: 'user', content: buildReviewGroupingsPrompt(groupText) }],
    });

    if (msg.stop_reason === 'max_tokens') {
      console.warn('⚠  AI review hit the token limit — results may be incomplete. Try running with fewer transactions.');
    }

    const toolUse = msg.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return [];
    return ((toolUse.input as any).suggestions as Suggestion[]) ?? [];
  }

  async suggestConsolidation(groups: ConsolidationGroup[]): Promise<ConsolidationSuggestion[]> {
    if (groups.length === 0) return [];

    const groupText = groups
      .map(g => `- "${g.actionValue}": ${g.matchValues.map(v => `"${v}"`).join(', ')}`)
      .join('\n');

    const msg = await this.client.messages.create({
      model: this.reviewModel,
      max_tokens: 2048,
      tools: [{
        name: 'report_consolidations',
        description: 'Report suggested consolidations for payee match patterns',
        input_schema: {
          type: 'object' as const,
          properties: {
            consolidations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  actionValue:          { type: 'string', description: 'The clean payee name (exactly as given)' },
                  suggestedMatchValue:  { type: 'string', description: 'A single contains-pattern that matches all variants' },
                  reason:               { type: 'string', description: 'One sentence explanation' },
                },
                required: ['actionValue', 'suggestedMatchValue', 'reason'],
              },
            },
          },
          required: ['consolidations'],
        },
      }],
      tool_choice: { type: 'tool' as const, name: 'report_consolidations' },
      messages: [{ role: 'user', content: buildSuggestConsolidationPrompt(groupText) }],
    });

    const toolUse = msg.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return [];
    return ((toolUse.input as any).consolidations as ConsolidationSuggestion[]) ?? [];
  }
}

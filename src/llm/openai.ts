import OpenAI from 'openai';
import type { LLMAdapter, GroupForReview, Suggestion, ConsolidationGroup, ConsolidationSuggestion } from '../types.js';
import { buildProposePayeePrompt, buildProposeCategoryPrompt, buildReviewGroupingsPrompt, buildSuggestConsolidationPrompt } from './prompts.js';

const DEFAULT_FAST_MODEL   = 'gpt-4o-mini';
const DEFAULT_REVIEW_MODEL = 'gpt-4o';

export class OpenAIAdapter implements LLMAdapter {
  private client: OpenAI;
  private fastModel: string;
  private reviewModel: string;

  constructor(apiKey: string, opts: { fastModel?: string; reviewModel?: string } = {}) {
    this.client      = new OpenAI({ apiKey });
    this.fastModel   = opts.fastModel   ?? DEFAULT_FAST_MODEL;
    this.reviewModel = opts.reviewModel ?? DEFAULT_REVIEW_MODEL;
  }

  async proposePayee(rawPayee: string, knownPayees: string[]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.fastModel,
      max_tokens: 64,
      messages: [{ role: 'user', content: buildProposePayeePrompt(rawPayee, knownPayees) }],
    });

    return response.choices[0].message.content?.trim() ?? rawPayee;
  }

  async proposeCategory(cleanPayee: string, categories: string[]): Promise<string> {
    const response = await this.client.chat.completions.create({
      model: this.fastModel,
      max_tokens: 64,
      messages: [{ role: 'user', content: buildProposeCategoryPrompt(cleanPayee, categories) }],
    });

    return response.choices[0].message.content?.trim() ?? categories[0];
  }

  async reviewGroupings(groups: GroupForReview[]): Promise<Suggestion[]> {
    if (groups.length === 0) return [];

    const groupText = groups
      .map(g => `- "${g.cleanPayee}" (${g.category ?? 'no category'}): ${g.rawPayees.join(' | ')}`)
      .join('\n');

    const response = await this.client.chat.completions.create({
      model: this.reviewModel,
      max_tokens: 4096,
      tools: [{
        type: 'function',
        function: {
          name: 'report_anomalies',
          description: 'Report anomalies and suggestions for payee groupings',
          parameters: {
            type: 'object',
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
        },
      }],
      tool_choice: { type: 'function', function: { name: 'report_anomalies' } },
      messages: [{ role: 'user', content: buildReviewGroupingsPrompt(groupText) }],
    });

    if (response.choices[0].finish_reason === 'length') {
      console.warn('⚠  AI review hit the token limit — results may be incomplete. Try running with fewer transactions.');
    }

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') return [];
    return (JSON.parse(toolCall.function.arguments).suggestions as Suggestion[]) ?? [];
  }

  async suggestConsolidation(groups: ConsolidationGroup[]): Promise<ConsolidationSuggestion[]> {
    if (groups.length === 0) return [];

    const groupText = groups
      .map(g => `- "${g.actionValue}": ${g.matchValues.map(v => `"${v}"`).join(', ')}`)
      .join('\n');

    const response = await this.client.chat.completions.create({
      model: this.reviewModel,
      max_tokens: 2048,
      tools: [{
        type: 'function',
        function: {
          name: 'report_consolidations',
          description: 'Report suggested consolidations for payee match patterns',
          parameters: {
            type: 'object',
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
        },
      }],
      tool_choice: { type: 'function', function: { name: 'report_consolidations' } },
      messages: [{ role: 'user', content: buildSuggestConsolidationPrompt(groupText) }],
    });

    const toolCall = response.choices[0].message.tool_calls?.[0];
    if (!toolCall || toolCall.type !== 'function') return [];
    return (JSON.parse(toolCall.function.arguments).consolidations as ConsolidationSuggestion[]) ?? [];
  }
}

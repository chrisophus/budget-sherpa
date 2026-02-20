import Anthropic from '@anthropic-ai/sdk';
import type { LLMAdapter, GroupForReview, Suggestion } from '../types.js';

export class AnthropicAdapter implements LLMAdapter {
  private client: Anthropic;
  private model = 'claude-haiku-4-5-20251001'; // fast + cheap for bulk guessing

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async proposePayee(rawPayee: string, knownPayees: string[]): Promise<string> {
    const known = knownPayees.length > 0
      ? `Known payees (prefer reusing these if appropriate):\n${knownPayees.join(', ')}`
      : '';

    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: `Convert this raw bank transaction payee name to a clean, human-readable name.
Return ONLY the clean name, nothing else.

Raw payee: "${rawPayee}"
${known}`,
      }],
    });

    return (msg.content[0] as { text: string }).text.trim();
  }

  async proposeCategory(cleanPayee: string, categories: string[]): Promise<string> {
    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 64,
      messages: [{
        role: 'user',
        content: `Which category best fits this payee? Return ONLY the category name, nothing else.

Payee: "${cleanPayee}"
Categories: ${categories.join(', ')}`,
      }],
    });

    return (msg.content[0] as { text: string }).text.trim();
  }

  async reviewGroupings(groups: GroupForReview[]): Promise<Suggestion[]> {
    const groupText = groups
      .map(g => `- "${g.cleanPayee}" (${g.category ?? 'no category'}): ${g.rawPayees.join(' | ')}`)
      .join('\n');

    const msg = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
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
      messages: [{
        role: 'user',
        content: `Review these bank transaction payee groupings. Each line shows the assigned clean name, category, and the raw bank strings that map to it.

Flag only genuine issues: payees that are miscategorized, should be split into distinct payees, have a better clean name, or are otherwise suspicious. Do not flag things that look correct.

${groupText}`,
      }],
    });

    const toolUse = msg.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return [];
    return ((toolUse.input as any).suggestions as Suggestion[]) ?? [];
  }
}

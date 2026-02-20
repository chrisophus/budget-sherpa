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
      model: 'claude-sonnet-4-6', // use smarter model — this is a single analysis call
      max_tokens: 2048,
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
        content: `You are reviewing bank transaction payee groupings for a personal finance app. Each line shows: clean name (category): raw bank strings that map to it.

Actively look for and flag these patterns:

- SPLIT: raw payees in the same group that represent meaningfully different merchants or expense types (e.g. "AMAZON FRESH" mixed with "AMAZON MKTPL" — groceries vs shopping; or multiple distinct gas station brands like "CASEY'S", "KWIK TRIP", "SHELL" all collapsed under one name — each brand should be its own payee)
- RENAME: the clean name is a generic category word ("Gas Station", "Restaurant", "Store") instead of the actual merchant name, or is unclear/too abbreviated
- CATEGORY: the assigned category seems wrong for the merchant type
- FLAG: transfers between accounts disguised as expenses (e.g. "AUTOMATIC PAYMENT", "ONLINE PAYMENT"), or other notable issues

Key rule: different businesses should never share a clean name, even if they're in the same industry. "Shell" and "Casey's" and "Kwik Trip" are different payees that happen to sell gas — they should not be merged.

Be thorough. Flag every issue you find.

${groupText}`,
      }],
    });

    const toolUse = msg.content.find(b => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') return [];
    return ((toolUse.input as any).suggestions as Suggestion[]) ?? [];
  }
}

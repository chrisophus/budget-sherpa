export function buildProposePayeePrompt(rawPayee: string, knownPayees: string[]): string {
  const known = knownPayees.length > 0
    ? `Known payees (prefer reusing these if appropriate):\n${knownPayees.join(', ')}`
    : '';

  return `Convert this raw bank transaction payee name to a clean, human-readable name.
Return ONLY the clean name, nothing else.

Raw payee: "${rawPayee}"
${known}`;
}

export function buildProposeCategoryPrompt(cleanPayee: string, categories: string[]): string {
  return `Which category best fits this payee? Return ONLY the category name, nothing else.

Payee: "${cleanPayee}"
Categories: ${categories.join(', ')}`;
}

export function buildSuggestConsolidationPrompt(groupText: string): string {
  return `You are reviewing bank transaction payee import rules. Each entry shows a clean payee name that is currently matched by multiple distinct "contains" patterns. Suggest a single, shorter "contains" pattern that would match all variants.

Look for the stable base string shared by all variants — typically the longest meaningful prefix after removing trailing transaction codes, session IDs, store numbers, or random suffixes. The suggested pattern must be a real substring present in every listed variant.

${groupText}`;
}

export function buildReviewGroupingsPrompt(groupText: string): string {
  return `You are reviewing bank transaction payee groupings for a personal finance app. Each line shows: clean name (category): raw bank strings that map to it.

Actively look for and flag these patterns:

- SPLIT: raw payees in the same group that represent meaningfully different merchants or expense types (e.g. "AMAZON FRESH" mixed with "AMAZON MKTPL" — groceries vs shopping; or multiple distinct gas station brands like "CASEY'S", "KWIK TRIP", "SHELL" all collapsed under one name — each brand should be its own payee)
- RENAME: the clean name is a generic category word ("Gas Station", "Restaurant", "Store") instead of the actual merchant name, or is unclear/too abbreviated
- CATEGORY: the assigned category seems wrong for the merchant type
- FLAG: transfers between accounts disguised as expenses (e.g. "AUTOMATIC PAYMENT", "ONLINE PAYMENT"), or other notable issues

Key rule: different businesses should never share a clean name, even if they're in the same industry. "Shell" and "Casey's" and "Kwik Trip" are different payees that happen to sell gas — they should not be merged.

Be thorough. Flag every issue you find.

${groupText}`;
}

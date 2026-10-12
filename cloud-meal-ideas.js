const recipeSchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    ingredients: { type: 'string' },
    directions: { type: 'string' },
    servings: { type: 'integer' },
  },
  required: ['title', 'ingredients', 'directions', 'servings'],
  additionalProperties: false,
};

const responseSchema = {
  type: 'object',
  properties: {
    ideas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          day: { type: 'string' },
          category: { type: 'string' },
          recipeDraft: recipeSchema,
        },
        required: ['day', 'category', 'recipeDraft'],
        additionalProperties: false,
      },
    },
  },
  required: ['ideas'],
  additionalProperties: false,
};

export async function generateCloudMealIdeas({
  slots,
  servings,
  avoid,
  apiKey,
  model = 'gpt-6-luna',
}) {
  if (!apiKey) throw new Error('Set OPENAI_API_KEY on the server to use cloud meal ideas.');
  if (!Array.isArray(slots) || !slots.length || slots.length > 14) {
    throw new Error('Choose up to 14 open meal slots for cloud ideas.');
  }
  const requested = new Set(slots.map((slot) => `${slot.day}:${slot.category}`));
  if (requested.size !== slots.length) throw new Error('Choose distinct meal slots.');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      instructions:
        'Suggest practical, original family meals. Give precise ingredient quantities, complete short directions, and one recipe for each requested slot. Keep the supplied dates and categories exactly. Avoid every excluded word. Do not claim allergy safety. Return only the required structured output.',
      input: JSON.stringify({ slots, servings, avoid }),
      text: {
        format: {
          type: 'json_schema',
          name: 'family_meal_ideas',
          strict: true,
          schema: responseSchema,
        },
      },
      max_output_tokens: Math.min(12000, 800 + slots.length * 700),
      store: false,
    }),
    signal: AbortSignal.timeout(45000),
  });
  if (!response.ok) throw new Error(`Cloud meal ideas are unavailable (HTTP ${response.status}).`);
  const result = await response.json();
  const output = result.output
    ?.flatMap((item) => item.content || [])
    .find((item) => item.type === 'output_text')?.text;
  if (result.status !== 'completed' || !output)
    throw new Error('Cloud meal ideas did not finish. Try again.');
  let ideas;
  try {
    ideas = JSON.parse(output).ideas;
  } catch {
    throw new Error('Cloud meal ideas could not be read. Try again.');
  }
  if (!Array.isArray(ideas) || ideas.length !== slots.length)
    throw new Error('Cloud meal ideas were incomplete. Try again.');
  const excluded = String(avoid || '')
    .split(',')
    .map((term) => term.trim().toLowerCase())
    .filter(Boolean);
  const seen = new Set();
  return ideas.map((idea) => {
    const key = `${idea.day}:${idea.category}`;
    const draft = idea.recipeDraft;
    if (!requested.has(key) || seen.has(key) || !draft || typeof draft !== 'object') {
      throw new Error('Cloud meal ideas did not match the requested days. Try again.');
    }
    seen.add(key);
    const title = String(draft.title || '').trim();
    const ingredients = String(draft.ingredients || '').trim();
    const directions = String(draft.directions || '').trim();
    const lines = ingredients
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (
      !title ||
      title.length > 120 ||
      !directions ||
      directions.length > 5000 ||
      !lines.length ||
      lines.length > 30 ||
      lines.some((line) => line.length > 120) ||
      draft.servings !== servings ||
      excluded.some((term) => `${title}\n${ingredients}`.toLowerCase().includes(term))
    ) {
      throw new Error(
        'Cloud meal ideas need review before planning. Try again with different options.',
      );
    }
    return {
      day: idea.day,
      category: idea.category,
      servings,
      recipeDraft: { title, ingredients: lines.join('\n'), directions, servings },
    };
  });
}

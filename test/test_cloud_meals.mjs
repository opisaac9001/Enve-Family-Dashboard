import assert from 'node:assert/strict';
import { generateCloudMealIdeas } from '../cloud-meal-ideas.js';

const originalFetch = globalThis.fetch;
const slots = [{ day: '2026-10-06', category: 'Dinner' }];
const base = { slots, servings: 4, avoid: 'peanut', apiKey: 'test-key' };

try {
  let request;
  globalThis.fetch = async (_url, options) => {
    request = options;
    return {
      ok: true,
      json: async () => ({
        status: 'completed',
        output: [
          {
            content: [
              {
                type: 'output_text',
                text: JSON.stringify({
                  ideas: [
                    {
                      day: slots[0].day,
                      category: slots[0].category,
                      recipeDraft: {
                        title: 'Tomato pasta',
                        ingredients: '2 cups pasta\n4 tomatoes',
                        directions: 'Cook pasta and add tomatoes.',
                        servings: 4,
                      },
                    },
                  ],
                }),
              },
            ],
          },
        ],
      }),
    };
  };
  const ideas = await generateCloudMealIdeas(base);
  assert.equal(ideas[0].recipeDraft.title, 'Tomato pasta');
  assert.equal(JSON.parse(request.body).text.format.type, 'json_schema');
  assert.equal(JSON.parse(request.body).store, false);
  assert.equal(request.headers.Authorization, 'Bearer test-key');

  await assert.rejects(generateCloudMealIdeas({ ...base, apiKey: '' }), /OPENAI_API_KEY/);
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                ideas: [
                  {
                    day: slots[0].day,
                    category: slots[0].category,
                    recipeDraft: {
                      title: 'Peanut pasta',
                      ingredients: '1 cup peanuts',
                      directions: 'Mix.',
                      servings: 4,
                    },
                  },
                ],
              }),
            },
          ],
        },
      ],
    }),
  });
  await assert.rejects(generateCloudMealIdeas(base), /need review/);
} finally {
  globalThis.fetch = originalFetch;
}

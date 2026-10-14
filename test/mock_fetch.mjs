import { appendFileSync } from 'node:fs';

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const method = options.method || 'GET';
  const search = url.searchParams.get('q');
  appendFileSync(
    process.env.MOCK_FETCH_LOG,
    `${method} ${url.origin}${url.pathname}${search ? ` q=${search}` : ''}\n`,
  );
  if (url.origin === 'https://www.googleapis.com' && method === 'PATCH')
    appendFileSync(
      process.env.MOCK_FETCH_LOG,
      `GOOGLE_PATCH_KEYS ${Object.keys(JSON.parse(options.body)).sort().join(',')}\n`,
    );
  const ok = (data) =>
    new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

  if (url.origin === 'https://api.openai.com' && url.pathname === '/v1/responses') {
    const prompt = JSON.parse(options.body);
    const { slots, servings } = JSON.parse(prompt.input);
    return ok({
      status: 'completed',
      output: [
        {
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                ideas: slots.map((slot) => ({
                  ...slot,
                  recipeDraft: {
                    title: 'Mock tomato pasta',
                    ingredients: '2 cups pasta\n4 tomatoes',
                    directions: 'Cook the pasta and tomatoes.',
                    servings,
                  },
                })),
              }),
            },
          ],
        },
      ],
    });
  }

  if (url.origin === 'https://login.microsoftonline.com' && url.pathname.endsWith('/token')) {
    return ok({
      access_token: 'outlook-access',
      refresh_token: 'outlook-refresh',
      expires_in: 3600,
    });
  }
  if (url.origin === 'https://graph.microsoft.com') {
    if (url.pathname === '/v1.0/me') return ok({ mail: 'outlook@example.test' });
    if (url.pathname === '/v1.0/me/calendars')
      return ok({ value: [{ id: 'outlook-calendar', name: 'Personal' }] });
    if (url.pathname.endsWith('/calendarView'))
      return ok({
        value: [
          {
            id: 'outlook-event',
            subject: 'Outlook appointment',
            isAllDay: false,
            start: { dateTime: '2026-10-05T09:00:00.0000000', timeZone: 'UTC' },
            end: { dateTime: '2026-10-05T10:00:00.0000000', timeZone: 'UTC' },
          },
        ],
      });
  }
  if (url.origin === 'https://oauth2.googleapis.com' && url.pathname === '/token') {
    return ok({ access_token: 'google-access', refresh_token: 'google-refresh', expires_in: 3600 });
  }
  if (url.origin === 'https://www.googleapis.com') {
    if (url.pathname === '/calendar/v3/colors')
      return ok({
        calendar: { 1: { background: '#123456', foreground: '#ffffff' } },
        event: { 2: { background: '#ABCDEF', foreground: '#000000' } },
      });
    if (url.pathname === '/calendar/v3/users/me/calendarList')
      return ok({
        items: [
          {
            id: 'google@example.test',
            summary: 'Main',
            primary: true,
            accessRole: 'owner',
            colorId: '1',
          },
        ],
      });
    if (url.pathname.endsWith('/events') && method === 'GET') {
      if (search === 'unavailable') return new Response('{}', { status: 500 });
      const items = [
        {
          id: 'google-event',
          summary: 'Google appointment',
          colorId: '2',
          start: { dateTime: '2026-10-05T11:00:00Z' },
          end: { dateTime: '2026-10-05T12:00:00Z' },
        },
        {
          id: 'google-other',
          summary: 'Google default color',
          start: { dateTime: '2026-10-05T13:00:00Z' },
          end: { dateTime: '2026-10-05T14:00:00Z' },
        },
      ];
      if (search)
        items.push({
          id: 'google-far',
          summary: 'Dentist checkup far ahead',
          start: { dateTime: '2027-06-15T16:00:00Z' },
          end: { dateTime: '2027-06-15T17:00:00Z' },
        });
      return ok({
        items: search ? items.filter((item) => item.summary.toLowerCase().includes(search)) : items,
      });
    }
    if (url.pathname.endsWith('/google-event') && method === 'PATCH')
      return ok({ id: 'google-event' });
    if (url.pathname.endsWith('/google-event') && method === 'DELETE')
      return new Response(null, { status: 204 });
  }
  throw new Error(`Unexpected provider request: ${method} ${url.origin}${url.pathname}`);
};

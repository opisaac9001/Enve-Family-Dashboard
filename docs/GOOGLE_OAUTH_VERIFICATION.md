# Google Calendar production verification

Enve Family's Google connection is currently for testing. Publishing the source and product page does not make the Google consent screen verified. Public sign-in needs a separate Google review of the exact client, scopes, domain, and demonstrated flow.

## Public URLs

- Homepage: https://envemedia.com/family/
- Privacy policy: https://envemedia.com/family/privacy.html
- Terms: https://envemedia.com/family/terms.html
- Support: enve.audiobook@gmail.com

The OAuth consent screen must use these live URLs. Verify ownership of `envemedia.com` in Google Search Console and add it as an authorized domain. Confirm each URL is reachable without sign-in after deployment.

## Current request and justification

The server currently requests `https://www.googleapis.com/auth/calendar.readonly` to list selected calendars and show/search their events, and `https://www.googleapis.com/auth/calendar.events` to create, update, or delete events the user chooses to change in a writable Google calendar. The connection is optional. A user connects each account explicitly in Settings, chooses visible calendars, and can disconnect it. Refresh tokens stay in the household's own SQLite database.

The production project should request only these scopes if the implementation still needs both. Review the exact scopes shown in Google Cloud before submitting; Google's classification and evidence requirements are authoritative. The app's privacy page describes the corresponding access, use, storage, and deletion behavior.

## Before submission

1. Publish and inspect the homepage, privacy policy, and terms above, including their mobile layout and links.
2. Decide the supported public sign-in address. Configure `GOOGLE_REDIRECT_URI` with its exact HTTPS callback ending in `/api/google/callback`, and enter the same URI on the OAuth web client. The current `localhost` callback is for testing on the server device.
3. Complete sign-in through a full browser or an approved external browser handoff. Do not direct Google's authorization page into the Pi's embedded WPE kiosk or the iPhone app's embedded web view.
4. Verify the final consent branding, support email, authorized domain, test users, and scopes in Google Cloud. Do not put the client secret, refresh tokens, or private household data in the repository or video.
5. Record a demo with a disposable Google account. Show opening Settings, choosing Connect Google, the full external browser consent flow, selecting a calendar, seeing its events, creating or editing an event, and disconnecting. Show the app URL and consent screen clearly.
6. Submit the scope justification and demo video in Google Cloud, then respond to Google's review questions. Keep the app in testing until Google confirms production access.

Google's current requirements: [verification overview](https://support.google.com/cloud/answer/13463073), [homepage and privacy requirements](https://support.google.com/cloud/answer/13464321), [submission evidence](https://support.google.com/cloud/answer/13461325), and [OAuth user-agent policy](https://developers.google.com/identity/protocols/oauth2/policies).

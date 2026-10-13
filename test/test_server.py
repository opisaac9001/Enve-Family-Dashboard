import json
import base64
import os
from pathlib import Path
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, urlparse
from urllib.request import Request, urlopen
from urllib.request import HTTPRedirectHandler, build_opener


ROOT = Path(__file__).resolve().parents[1]


class DashboardServerCase(unittest.TestCase):
    def environment(self):
        return {}

    def prepare_database(self, path):
        pass

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="enve-family-")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            self.port = sock.getsockname()[1]
        self.origin = f"http://127.0.0.1:{self.port}"
        database = Path(self.temp.name) / "family.sqlite"
        self.prepare_database(database)
        wifi_tool = Path(self.temp.name) / "nmcli"
        wifi_tool.write_text("#!/bin/sh\nexit 0\n")
        wifi_tool.chmod(0o700)
        env = os.environ.copy()
        env.update(PORT=str(self.port), DATABASE_PATH=str(database), ENVE_DEMO_SEED="1",
                   ENVE_NMCLI_BIN=str(wifi_tool))
        env.update(self.environment())
        self.server = subprocess.Popen(["node", "server.js"], cwd=ROOT, env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(50):
            try:
                urlopen(self.origin, timeout=1).close()
                break
            except (URLError, ConnectionError):
                time.sleep(0.05)
        else:
            self.fail(self.server.stderr.read().decode())

    def tearDown(self):
        self.server.terminate()
        self.server.wait(timeout=5)
        self.server.stderr.close()
        self.temp.cleanup()

    def call(self, path, method="GET", payload=None, headers=None):
        data = json.dumps(payload).encode() if payload is not None else None
        request = Request(self.origin + path, data=data, method=method,
                          headers={"Content-Type": "application/json", **(headers or {})})
        try:
            response = urlopen(request, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, json.load(response)

    def post_with_cookie(self, path, payload):
        request = Request(self.origin + path, data=json.dumps(payload).encode(), method="POST",
                          headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=5) as response:
            return response.status, response.headers.get("Set-Cookie"), json.load(response)


class DashboardApiTest(DashboardServerCase):

    def test_rotating_chore_assigns_next_person(self):
        payload = {'title': 'Dishes', 'profileId': 'alex', 'dueDate': '2026-10-05',
                   'repeatRule': 'daily', 'taskType': 'chore',
                   'rotationProfiles': ['alex', 'sam', 'jamie']}
        status, created = self.call('/api/tasks', 'POST', payload)
        self.assertEqual(status, 201)
        self.assertEqual(self.call('/api/tasks', 'POST', {**payload, 'rotationProfiles': ['alex', 'alex']})[0], 400)
        self.assertEqual(self.call('/api/tasks/' + created['id'], 'PATCH', {'completed': True})[0], 200)
        tasks = self.call('/api/state?from=2026-10-05&to=2026-10-12')[1]['tasks']
        second = next(task for task in tasks if task['seriesId'] == created['id'] and not task['completed'])
        self.assertEqual((second['profileId'], second['dueDate'], second['rotationIndex']), ('sam', '2026-10-06', 1))
        self.assertEqual(second['rotationProfiles'], ['alex', 'sam', 'jamie'])
        self.assertEqual(self.call('/api/tasks/' + second['id'], 'PATCH', {'skipped': True})[0], 200)
        tasks = self.call('/api/state?from=2026-10-05&to=2026-10-12')[1]['tasks']
        third = next(task for task in tasks if task['seriesId'] == created['id'] and not task['completed'])
        self.assertEqual((third['profileId'], third['dueDate'], third['rotationIndex']), ('jamie', '2026-10-07', 2))

    def test_meal_suggestions_and_combined_groceries(self):
        _, rice = self.call('/api/recipes', 'POST', {
            'title': 'Rice bowls', 'ingredients': '2 eggs\n1 cup rice', 'servings': 2,
        })
        self.call('/api/recipes', 'POST', {
            'title': 'Nut salad', 'ingredients': '2 cups nuts', 'servings': 2,
        })
        status, result = self.call('/api/meals/suggestions', 'POST', {
            'startDay': '2026-10-04', 'categories': ['Dinner'], 'servings': 4, 'avoid': 'nuts',
        })
        self.assertEqual(status, 200)
        self.assertEqual(len(result['suggestions']), 7)
        self.assertEqual(result['suggestions'][0]['ingredients'], ['4 eggs', '2 cups rice'])
        self.assertEqual(self.call('/api/state?from=2026-10-04&to=2026-10-11')[1]['meals'], [])
        selected = [{key: suggestion[key] for key in ('day', 'category', 'recipeId', 'servings')}
                    for suggestion in result['suggestions'][:2]]
        self.assertEqual(self.call('/api/meals/plan', 'POST', {'meals': selected})[0], 201)
        _, state = self.call('/api/state?from=2026-10-04&to=2026-10-11')
        self.assertEqual(len(state['meals']), 2)
        self.assertTrue(all(meal['recipe_id'] == rice['id'] for meal in state['meals']))
        self.assertEqual(self.call('/api/meals/plan', 'POST', {'meals': selected})[0], 400)
        ids = [meal['id'] for meal in state['meals']]
        status, grocery = self.call('/api/meals/groceries', 'POST', {'mealIds': ids})
        self.assertEqual(status, 200)
        self.assertEqual(grocery['ingredients'], ['8 eggs', '4 cups rice'])
        self.assertEqual(grocery['added'], 2)
        self.assertEqual(self.call('/api/meals/groceries', 'POST', {'mealIds': ids})[1]['added'], 0)
        _, backup = self.call('/api/backup')
        self.assertEqual(self.call('/api/restore', 'POST', backup)[0], 200)
        self.assertEqual(len(self.call('/api/state?from=2026-10-04&to=2026-10-11')[1]['meals']), 2)

    def test_live_change_stream_notifies_other_devices(self):
        with urlopen(self.origin + '/api/changes', timeout=5) as stream:
            self.assertEqual(stream.headers.get_content_type(), 'text/event-stream')
            self.assertEqual(stream.readline(), b': connected\n')
            self.assertEqual(self.call('/api/lists', 'POST', {'name': 'Shared'})[0], 201)
            self.assertEqual(stream.readline(), b'\n')
            self.assertEqual(stream.readline(), b'data: refresh\n')

    def test_phone_app_assets(self):
        with urlopen(self.origin + '/manifest.webmanifest') as response:
            manifest = json.load(response)
        self.assertEqual(manifest['display'], 'standalone')
        self.assertEqual({icon['sizes'] for icon in manifest['icons']}, {'192x192', '512x512'})
        for icon in manifest['icons']:
            with urlopen(self.origin + icon['src']) as response:
                self.assertEqual(response.headers.get_content_type(), 'image/png')
                self.assertEqual(response.read(8), bytes.fromhex('89504e470d0a1a0a'))
        with urlopen(self.origin + '/sw.js') as response:
            self.assertIn(b'/offline.html', response.read())

    def test_import_drafts_require_review(self):
        status, result = self.call('/api/import/drafts', 'POST', {
            'type': 'event', 'text': 'School concert October 12, 2026 at 6pm',
        })
        self.assertEqual(status, 200)
        self.assertEqual(result['drafts'][0]['title'], 'School concert')
        self.assertEqual(result['drafts'][0]['type'], 'event')
        self.assertEqual(self.call('/api/state?from=2026-10-11&to=2026-10-15')[1]['events'], [])
        status, result = self.call('/api/import/drafts', 'POST', {
            'type': 'recipe', 'text': 'Family dinner\nIngredients:\n2 cups rice\n1 onion\nDirections:\nCook it',
        })
        self.assertEqual(status, 200)
        self.assertEqual(result['drafts'][0]['ingredients'], '2 cups rice\n1 onion')
        ics = ('BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nUID:one\n'
               'DTSTART;VALUE=DATE:20261012\nDTEND;VALUE=DATE:20261013\n'
               'SUMMARY:School day\nEND:VEVENT\nEND:VCALENDAR')
        self.assertEqual(self.call('/api/import/drafts', 'POST', {'type': 'event', 'text': ics})[1]
                         ['drafts'][0]['title'], 'School day')

    def test_recipe_servings_and_reward_goals(self):
        png = bytes.fromhex('89504e470d0a1a0a') + b'test'
        _, photo = self.call('/api/photos', 'POST', {
            'name': 'Recipe.png', 'mime': 'image/png', 'purpose': 'recipe',
            'data': base64.b64encode(png).decode(),
        })
        _, recipe = self.call('/api/recipes', 'POST', {
            'title': 'Rice', 'ingredients': '2 cups rice\n1/2 tsp salt\nSalt to taste',
            'servings': 4, 'photoId': photo['id'],
        })
        recipe_id = recipe['id']
        state = self.call('/api/state?from=2026-10-04&to=2026-10-11')[1]
        self.assertEqual(next(row['photo_id'] for row in state['recipes'] if row['id'] == recipe_id), photo['id'])
        self.assertEqual(self.call('/api/photos')[1], [])
        status, scaled = self.call(f'/api/recipes/{recipe_id}/scale?servings=8')
        self.assertEqual(status, 200)
        self.assertEqual(scaled['ingredients'], '4 cups rice\n1 tsp salt\nSalt to taste')
        self.assertEqual(self.call(f'/api/recipes/{recipe_id}/groceries', 'POST', {'servings': 8})[0], 200)
        _, state = self.call('/api/state?from=2026-10-04&to=2026-10-11')
        self.assertTrue(any(row['title'] == '4 cups rice' for row in state['listItems']))
        _, goal = self.call('/api/goals', 'POST', {'title': 'New book', 'profileId': 'jamie', 'target': 12})
        self.assertTrue(any(row['id'] == goal['id'] for row in self.call('/api/state?from=2026-10-04&to=2026-10-11')[1]['goals']))
        self.assertEqual(self.call('/api/goals/' + goal['id'], 'DELETE')[0], 200)

    def test_calendar_url_rejects_private_addresses(self):
        self.assertEqual(self.call('/api/feed-calendars', 'POST', {
            'name': 'Unsafe', 'profileId': 'family', 'url': 'https://127.0.0.1/calendar.ics',
        })[0], 400)

    def test_list_sections_sort_and_local_photos(self):
        _, household_list = self.call('/api/lists', 'POST', {'name': 'Trip'})
        list_id = household_list['id']
        self.assertEqual(self.call(f'/api/lists/{list_id}', 'PATCH', {'sortOrder': 'alpha'})[0], 200)
        self.assertEqual(self.call(f'/api/lists/{list_id}', 'PATCH', {'sortOrder': 'bad'})[0], 400)
        self.call('/api/list-items', 'POST', {'listId': list_id, 'title': 'Passport', 'section': 'Documents'})
        _, state = self.call('/api/state?from=2026-10-04&to=2026-10-11')
        self.assertEqual(next(row['sort_order'] for row in state['lists'] if row['id'] == list_id), 'alpha')
        self.assertEqual(next(row['section'] for row in state['listItems'] if row['listId'] == list_id), 'Documents')
        png = bytes.fromhex('89504e470d0a1a0a') + b'test'
        _, photo = self.call('/api/photos', 'POST', {
            'name': 'Family.png', 'mime': 'image/png', 'data': base64.b64encode(png).decode(),
        })
        self.assertEqual(self.call('/api/photos')[1][0]['id'], photo['id'])
        with urlopen(self.origin + '/api/photos/' + photo['id']) as response:
            self.assertEqual(response.read(), png)
        self.assertEqual(self.call('/api/photos', 'POST', {
            'name': 'Invalid.png', 'mime': 'image/png', 'data': base64.b64encode(b'wrong').decode(),
        })[0], 400)
        self.assertEqual(self.call('/api/photos/' + photo['id'], 'DELETE')[0], 200)

    def test_local_backup_restore_and_failed_restore_rollback(self):
        _, item = self.call('/api/list-items', 'POST', {'listId': 'groceries', 'title': 'Apples'})
        _, backup = self.call('/api/backup')
        self.assertEqual(backup['format'], 'enve-family-backup')
        self.assertNotIn('google_accounts', backup['tables'])
        self.call('/api/list-items/' + item['id'], 'DELETE')
        self.assertEqual(self.call('/api/restore', 'POST', backup)[0], 200)
        path = '/api/state?from=2026-10-04&to=2026-10-11'
        self.assertTrue(any(row['id'] == item['id'] for row in self.call(path)[1]['listItems']))
        legacy = json.loads(json.dumps(backup))
        legacy['tables'].pop('goals', None)
        self.assertEqual(self.call('/api/restore', 'POST', legacy)[0], 200)
        invalid = json.loads(json.dumps(backup))
        invalid['tables']['list_items'][0]['list_id'] = 'missing'
        self.assertEqual(self.call('/api/restore', 'POST', invalid)[0], 400)
        self.assertTrue(any(row['id'] == item['id'] for row in self.call(path)[1]['listItems']))

    def test_parent_pin_protects_edits_and_keeps_chore_completion_available(self):
        _, task = self.call('/api/tasks', 'POST', {'title': 'Feed cat', 'profileId': 'family'})
        self.assertEqual(self.call('/api/pin', 'POST', {'pin': '2846'})[0], 200)
        self.assertEqual(self.call('/api/pin')[1], {'enabled': True, 'unlocked': False})
        self.assertEqual(self.call('/api/lists', 'POST', {'name': 'Blocked'})[0], 423)
        self.assertEqual(self.call('/api/tasks/' + task['id'], 'PATCH', {'completed': True})[0], 200)
        self.assertEqual(self.call('/api/pin/unlock', 'POST', {'pin': '0000'})[0], 401)
        request = Request(self.origin + '/api/pin/unlock', data=json.dumps({'pin': '2846'}).encode(),
                          method='POST', headers={'Content-Type': 'application/json'})
        with urlopen(request) as response:
            cookie = response.headers['Set-Cookie'].split(';', 1)[0]
        request = Request(self.origin + '/api/lists', data=json.dumps({'name': 'Allowed'}).encode(),
                          method='POST', headers={'Content-Type': 'application/json', 'Cookie': cookie})
        with urlopen(request) as response:
            self.assertEqual(response.status, 201)
        request = Request(self.origin + '/api/pin', method='DELETE', headers={'Cookie': cookie})
        with urlopen(request) as response:
            self.assertEqual(response.status, 200)
        self.assertEqual(self.call('/api/pin')[1], {'enabled': False, 'unlocked': False})

    def test_events_tasks_settings_and_persistence(self):
        path = "/api/state?from=2026-10-04&to=2026-10-11"
        status, event = self.call("/api/events", "POST", {
            "title": "Family lunch", "profileId": "family", "allDay": False,
            "start": "2026-10-04T19:00:00.000Z", "end": "2026-10-04T20:00:00.000Z",
        })
        self.assertEqual(status, 201)
        self.assertEqual(self.call(f"/api/events/{event['id']}", "PATCH", {
            "title": "Family brunch", "profileId": "family", "allDay": False,
            "start": "2026-10-04T18:00:00.000Z", "end": "2026-10-04T19:00:00.000Z",
        })[0], 200)
        status, task = self.call("/api/tasks", "POST", {
            "title": "Take out trash", "profileId": "family",
            "dueDate": "2026-10-04", "repeatRule": "weekly",
        })
        self.assertEqual(status, 201)
        _, state = self.call(path)
        self.assertTrue(any(item["title"] == "Family brunch" for item in state["events"]))
        self.assertEqual([item["title"] for item in self.call("/api/search?q=brunch")[1]["events"]], ["Family brunch"])
        self.assertEqual(self.call("/api/search?q=%25")[1]["events"], [])
        self.call("/api/events", "POST", {
            "title": "Late local event", "profileId": "family", "allDay": False,
            "start": "2026-10-06T06:00:00.000Z", "end": "2026-10-06T07:00:00.000Z",
        })
        self.assertTrue(any(item["title"] == "Late local event" for item in
                            self.call("/api/state?from=2026-10-05&to=2026-10-06")[1]["events"]))
        self.assertTrue(any(item["title"] == "Take out trash" for item in state["tasks"]))
        self.assertEqual(self.call(f"/api/tasks/{task['id']}", "PATCH", {"completed": True})[0], 200)
        _, state = self.call(path)
        self.assertTrue(any(item["dueDate"] == "2026-10-11" and not item["completed"] for item in state["tasks"]))
        self.call(f"/api/tasks/{task['id']}", "PATCH", {"completed": False})
        self.call(f"/api/tasks/{task['id']}", "PATCH", {"completed": True})
        _, state = self.call(path)
        self.assertEqual(sum(item["dueDate"] == "2026-10-11" for item in state["tasks"]), 1)
        _, month_task = self.call("/api/tasks", "POST", {
            "title": "Monthly check", "profileId": "family",
            "dueDate": "2026-01-31", "repeatRule": "monthly",
        })
        self.call(f"/api/tasks/{month_task['id']}", "PATCH", {"completed": True})
        self.assertTrue(any(item["dueDate"] == "2026-02-28" for item in self.call(path)[1]["tasks"]))
        self.assertEqual(self.call("/api/settings", "PATCH", {"theme": "light"})[0], 200)
        self.assertEqual(self.call(path)[1]["settings"]["theme"], "light")
        self.assertEqual(self.call("/api/settings", "PATCH", {"accent_color": "#8DBBF1"})[0], 200)
        self.assertEqual(self.call(path)[1]["settings"]["accent_color"], "#8DBBF1")
        self.assertEqual(self.call("/api/settings", "PATCH", {"accent_color": "#000000"})[0], 400)
        self.assertEqual(self.call("/api/settings", "PATCH", {"sleep_at": "22:30", "wake_at": "06:15"})[0], 200)
        self.assertEqual(self.call(path)[1]["settings"]["sleep_at"], "22:30")
        self.assertEqual(self.call("/api/settings", "PATCH", {"wake_at": "25:00"})[0], 400)
        self.assertEqual(self.call("/api/settings", "PATCH", {
            "dim_after_minutes": "0.5", "night_dim_amount": "100",
        })[0], 200)
        settings = self.call(path)[1]["settings"]
        self.assertEqual((settings["dim_after_minutes"], settings["night_dim_amount"]), ("0.5", "100"))
        self.assertEqual(self.call("/api/settings", "PATCH", {"dim_after_minutes": "0"})[0], 200)
        self.assertEqual(self.call("/api/settings", "PATCH", {"night_dim_amount": "200"})[0], 400)
        self.assertEqual(self.call("/api/events", "POST", {
            "title": "Invalid", "profileId": "family", "allDay": True,
            "start": "2026-02-31", "end": "2026-03-01",
        })[0], 400)
        self.assertEqual(self.call(f"/api/events/{event['id']}", "DELETE")[0], 200)
        self.assertFalse(any(item["title"] == "Family brunch" for item in self.call(path)[1]["events"]))

    def test_recurring_event_occurrence_and_series_edits(self):
        status, series = self.call("/api/events", "POST", {
            "title": "Monthly lunch", "profileId": "family", "allDay": True,
            "start": "2026-01-31", "end": "2026-02-01", "repeatRule": "monthly",
            "repeatUntil": "2026-04-30",
        })
        self.assertEqual(status, 201)
        path = "/api/state?from=2026-02-25&to=2026-04-05"
        _, state = self.call(path)
        events = [item for item in state["events"] if item.get("seriesId") == series["id"]]
        self.assertEqual([item["start"] for item in events], ["2026-02-28", "2026-03-31"])
        self.assertEqual(self.call(f"/api/events/{series['id']}?occurrence=2026-02-28", "PATCH", {
            "title": "Special lunch", "profileId": "family", "allDay": True,
            "start": "2026-03-01", "end": "2026-03-02",
        })[0], 200)
        self.assertEqual(self.call(f"/api/events/{series['id']}?occurrence=2026-03-31", "DELETE")[0], 200)
        events = [item for item in self.call(path)[1]["events"] if item.get("seriesId") == series["id"]]
        self.assertEqual([(item["title"], item["start"]) for item in events], [("Special lunch", "2026-03-01")])
        self.assertEqual(self.call(f"/api/events/{series['id']}", "PATCH", {
            "title": "Family meal", "profileId": "family", "allDay": True,
            "start": "2026-01-31", "end": "2026-02-01", "repeatRule": "monthly",
            "repeatUntil": "2026-04-30",
        })[0], 200)
        events = [item for item in self.call(path)[1]["events"] if item.get("seriesId") == series["id"]]
        self.assertEqual([item["title"] for item in events], ["Family meal", "Family meal"])
        self.assertTrue(any(item.get("seriesId") == series["id"] for item in
                            self.call("/api/search?q=Family%20meal")[1]["events"]))

    def test_lists_meals_and_month_range(self):
        path = "/api/state?from=2026-09-27&to=2026-11-08"
        status, household_list = self.call("/api/lists", "POST", {"name": "Packing"})
        self.assertEqual(status, 201)
        status, item = self.call("/api/list-items", "POST", {
            "listId": household_list["id"], "title": "Chargers",
        })
        self.assertEqual(status, 201)
        self.assertEqual(self.call(f"/api/list-items/{item['id']}", "PATCH", {"checked": True})[0], 200)
        status, meal = self.call("/api/meals", "POST", {
            "day": "2026-10-05", "category": "Dinner", "title": "Pasta",
        })
        self.assertEqual(status, 201)
        _, state = self.call(path)
        self.assertTrue(any(row["name"] == "Packing" for row in state["lists"]))
        self.assertTrue(any(row["title"] == "Chargers" and row["checked"] for row in state["listItems"]))
        self.assertTrue(any(row["title"] == "Pasta" for row in state["meals"]))
        self.assertEqual(self.call("/api/meals", "POST", {
            "day": "2026-02-31", "category": "Dinner", "title": "Invalid",
        })[0], 400)
        self.assertEqual(self.call(f"/api/meals/{meal['id']}", "DELETE")[0], 200)
        self.assertEqual(self.call(f"/api/lists/{household_list['id']}", "DELETE")[0], 200)
        self.assertFalse(any(row["id"] == item["id"] for row in self.call(path)[1]["listItems"]))

    def test_recipe_box_and_grocery_transfer(self):
        path = "/api/state?from=2026-10-04&to=2026-10-11"
        status, recipe = self.call("/api/recipes", "POST", {
            "title": "Pasta", "ingredients": "Tomatoes\nBasil\nTomatoes", "directions": "Boil and mix.",
        })
        self.assertEqual(status, 201)
        self.assertEqual(self.call(f"/api/recipes/{recipe['id']}/groceries", "POST")[1]["added"], 2)
        self.assertEqual(self.call(f"/api/recipes/{recipe['id']}/groceries", "POST")[1]["added"], 0)
        self.assertEqual(self.call(f"/api/recipes/{recipe['id']}", "PATCH", {
            "title": "Pasta salad", "ingredients": "Tomatoes\nBasil", "directions": "Mix cold.",
        })[0], 200)
        state = self.call(path)[1]
        self.assertEqual(state["recipes"][0]["title"], "Pasta salad")
        self.assertEqual(sorted(row["title"] for row in state["listItems"]), ["Basil", "Tomatoes"])
        self.assertEqual(self.call(f"/api/recipes/{recipe['id']}", "DELETE")[0], 200)
        self.assertEqual(self.call(path)[1]["recipes"], [])

    def test_task_stars_and_reward_redemption(self):
        path = "/api/state?from=2026-10-04&to=2026-10-11"
        status, task = self.call("/api/tasks", "POST", {
            "title": "Set the table", "profileId": "jamie", "dueDate": "2026-10-05",
            "dueTime": "17:30", "repeatRule": "daily", "starValue": 3,
        })
        self.assertEqual(status, 201)
        self.assertEqual(self.call(f"/api/tasks/{task['id']}", "PATCH", {"completed": True})[0], 200)
        self.assertEqual(self.call(f"/api/tasks/{task['id']}", "PATCH", {"completed": True})[0], 200)
        state = self.call(path)[1]
        self.assertEqual(next(row["stars"] for row in state["rewardBalances"] if row["profileId"] == "jamie"), 3)
        self.assertTrue(any(row["dueDate"] == "2026-10-06" and row["dueTime"] == "17:30" and row["starValue"] == 3
                            for row in state["tasks"]))
        self.assertEqual(self.call(f"/api/tasks/{task['id']}", "PATCH", {"completed": False})[0], 200)
        self.assertEqual(self.call(path)[1]["rewardBalances"], [])
        self.call(f"/api/tasks/{task['id']}", "PATCH", {"completed": True})
        status, reward = self.call("/api/rewards", "POST", {
            "title": "Choose dessert", "profileId": "jamie", "cost": 2,
        })
        self.assertEqual(status, 201)
        self.assertEqual(self.call(f"/api/rewards/{reward['id']}/redeem", "POST")[0], 200)
        self.assertEqual(self.call(f"/api/rewards/{reward['id']}/redeem", "POST")[0], 400)
        self.assertEqual(self.call(f"/api/tasks/{task['id']}", "PATCH", {"completed": False})[0], 400)
        state = self.call(path)[1]
        self.assertEqual(next(row["stars"] for row in state["rewardBalances"] if row["profileId"] == "jamie"), 1)
        self.assertEqual(len(state["rewardHistory"]), 2)
        self.assertEqual(self.call(f"/api/rewards/{reward['id']}", "DELETE")[0], 200)
        self.assertEqual(len(self.call(path)[1]["rewardHistory"]), 2)

    def test_claimable_chores_and_skipped_routines(self):
        path = "/api/state?from=2026-10-04&to=2026-10-11"
        status, task = self.call("/api/tasks", "POST", {
            "title": "Water plants", "profileId": "family", "dueDate": "2026-10-05",
            "repeatRule": "daily", "taskType": "chore", "claimable": True, "starValue": 2,
        })
        self.assertEqual(status, 201)
        endpoint = f"/api/tasks/{task['id']}"
        self.assertEqual(self.call(endpoint, "PATCH", {"completed": True})[0], 400)
        self.assertEqual(self.call(endpoint, "PATCH", {"claimProfileId": "jamie"})[0], 200)
        self.assertEqual(self.call(endpoint, "PATCH", {"completed": True})[0], 200)
        state = self.call(path)[1]
        self.assertEqual(next(row["stars"] for row in state["rewardBalances"] if row["profileId"] == "jamie"), 2)
        next_task = next(row for row in state["tasks"] if row["dueDate"] == "2026-10-06")
        self.assertTrue(next_task["claimable"])
        self.assertIsNone(next_task["claimedBy"])
        self.assertEqual(self.call(f"/api/tasks/{next_task['id']}", "PATCH", {"skipped": True})[0], 200)
        self.assertTrue(next(row for row in self.call(path)[1]["tasks"] if row["id"] == next_task["id"])["skipped"])
        self.assertEqual(next(row["stars"] for row in self.call(path)[1]["rewardBalances"] if row["profileId"] == "jamie"), 2)

    def test_meal_categories_are_configurable_with_stable_ids(self):
        path = "/api/state?from=2026-10-04&to=2026-10-11"
        state = self.call(path)[1]
        self.assertEqual([row["id"] for row in state["mealCategories"]], ["Breakfast", "Lunch", "Dinner", "Snack"])
        self.assertTrue(all(row["enabled"] for row in state["mealCategories"]))
        self.assertNotIn("meal_categories", state["settings"])
        categories = [
            {"id": "Dinner", "name": "Supper", "color": "#112233", "enabled": True},
            {"id": "Breakfast", "name": "Breakfast", "color": "#F2B84B", "enabled": True},
            {"id": "Lunch", "name": "Lunch", "color": "#8EBF83", "enabled": True},
            {"id": "Snack", "name": "Treats", "color": "#6ca8df", "enabled": False},
        ]
        status, saved = self.call("/api/meal-categories", "PATCH", categories)
        self.assertEqual(status, 200)
        self.assertEqual(saved["mealCategories"][3]["color"], "#6CA8DF")
        state = self.call(path)[1]
        self.assertEqual([(row["id"], row["name"], row["enabled"]) for row in state["mealCategories"]],
                         [("Dinner", "Supper", True), ("Breakfast", "Breakfast", True),
                          ("Lunch", "Lunch", True), ("Snack", "Treats", False)])
        for invalid in (
            categories[:3],
            [*categories[:3], {**categories[3], "name": "supper"}],
            [*categories[:3], {**categories[3], "id": "Brunch"}],
            [*categories[:3], {**categories[3], "color": "orange"}],
            [*categories[:3], {**categories[3], "id": "Dinner"}],
            [{**row, "enabled": False} for row in categories],
        ):
            self.assertEqual(self.call("/api/meal-categories", "PATCH", invalid)[0], 400)
        self.assertEqual(self.call("/api/meals", "POST", {"day": "2026-10-05", "category": "Dinner", "title": "Pasta"})[0], 201)
        self.assertEqual(self.call("/api/meals", "POST", {"day": "2026-10-06", "category": "Supper", "title": "Pasta"})[0], 400)
        self.assertEqual(self.call(path)[1]["meals"][0]["category"], "Dinner")
        _, backup = self.call("/api/backup")
        self.call("/api/meal-categories", "PATCH", [{**row, "name": row["id"]} for row in categories])
        self.assertEqual(self.call("/api/restore", "POST", backup)[0], 200)
        self.assertEqual(self.call(path)[1]["mealCategories"][0]["name"], "Supper")
        broken = json.loads(json.dumps(backup))
        next(row for row in broken["tables"]["settings"] if row["key"] == "meal_categories")["value"] = "[]"
        self.assertEqual(self.call("/api/restore", "POST", broken)[0], 400)
        self.assertEqual(self.call(path)[1]["mealCategories"][0]["name"], "Supper")

    def test_builtin_meal_ideas_save_draft_recipes_when_planned(self):
        path = "/api/state?from=2026-10-04&to=2026-10-11"
        request = {"startDay": "2026-10-04", "categories": ["Dinner", "Breakfast"], "servings": 4, "avoid": "dairy"}
        status, result = self.call("/api/meals/ideas", "POST", request)
        self.assertEqual(status, 200)
        ideas = result["suggestions"]
        self.assertEqual(len(ideas), 14)
        for idea in ideas:
            draft = idea["draftRecipe"]
            self.assertIsNone(idea["recipeId"])
            self.assertTrue(draft["directions"])
            self.assertEqual(len(idea["ingredients"]), len(draft["ingredients"].split("\n")))
            self.assertFalse(any(word in draft["ingredients"].lower() for word in ("cheddar", "mozzarella", "parmesan", "yogurt")))
        self.assertEqual(self.call(path)[1]["recipes"], [])
        self.assertEqual(self.call("/api/meals/ideas", "POST", {**request, "categories": ["Breakfast"], "avoid": "dairy, pork"})[0], 400)

        dinners = [idea for idea in ideas if idea["category"] == "Dinner"]
        self.assertNotEqual(dinners[0]["title"], dinners[1]["title"])
        planned = [{key: idea[key] for key in ("day", "category", "servings", "draftRecipe")} for idea in dinners[:2]]
        planned.append({"day": dinners[0]["day"], "category": "Lunch", "servings": 2, "draftRecipe": dinners[0]["draftRecipe"]})
        broken = {**planned[1], "day": "2026-10-10", "draftRecipe": {**dinners[1]["draftRecipe"], "ingredients": ""}}
        self.assertEqual(self.call("/api/meals/plan", "POST", {"meals": [planned[0], broken]})[0], 400)
        self.assertEqual(self.call(path)[1]["recipes"], [])

        status, plan = self.call("/api/meals/plan", "POST", {"meals": planned})
        self.assertEqual(status, 201)
        self.assertEqual(len(plan["createdRecipeIds"]), 2)
        state = self.call(path)[1]
        self.assertEqual(sorted(row["title"] for row in state["recipes"]), sorted(idea["title"] for idea in dinners[:2]))
        meals = {meal["id"]: meal for meal in state["meals"]}
        first, second, lunch = (meals[meal_id] for meal_id in plan["ids"])
        self.assertEqual(first["recipeIds"], lunch["recipeIds"])
        self.assertEqual(first["recipe_id"], first["recipeIds"][0])
        self.assertEqual((lunch["servings"], second["servings"]), (2, 4))
        recipe = next(row for row in state["recipes"] if row["id"] == first["recipe_id"])
        self.assertEqual(recipe["ingredients"], dinners[0]["draftRecipe"]["ingredients"])
        self.assertEqual(recipe["directions"], dinners[0]["draftRecipe"]["directions"])

        _, again = self.call("/api/meals/ideas", "POST", {**request, "startDay": "2026-10-11"})
        saved_titles = {row["title"] for row in state["recipes"]}
        self.assertFalse(any(idea["title"] in saved_titles for idea in again["suggestions"]))
        _, suggestions = self.call("/api/meals/suggestions", "POST", {"startDay": "2026-10-11", "categories": ["Dinner"]})
        self.assertEqual(len(suggestions["suggestions"]), 7)
        self.assertTrue(all(row["recipeIds"] == [row["recipeId"]] and
                            row["recipeId"] in {recipe["id"] for recipe in state["recipes"]}
                            for row in suggestions["suggestions"]))

    def test_multiple_recipes_per_meal_and_merged_grocery_transfers(self):
        path = "/api/state?from=2026-10-04&to=2026-10-11"
        _, omelets = self.call("/api/recipes", "POST", {"title": "Omelets", "ingredients": "4 eggs\n1 cup milk", "servings": 2})
        _, wraps = self.call("/api/recipes", "POST", {"title": "Wraps", "ingredients": "2 tortillas\n2 eggs", "servings": 2})
        status, combo = self.call("/api/meals", "POST", {
            "day": "2026-10-05", "category": "Breakfast", "recipeIds": [omelets["id"], wraps["id"]], "servings": 4,
        })
        self.assertEqual(status, 201)
        _, named = self.call("/api/meals", "POST", {
            "day": "2026-10-06", "category": "Breakfast", "title": "Big breakfast",
            "recipeIds": [wraps["id"], omelets["id"]],
        })
        _, legacy = self.call("/api/meals", "POST", {
            "day": "2026-10-06", "category": "Dinner", "title": "Ignored", "recipeId": omelets["id"], "servings": 2,
        })
        self.assertEqual(self.call("/api/meals", "POST", {
            "day": "2026-10-05", "category": "Breakfast", "title": "Second breakfast",
        })[0], 400)
        self.assertEqual(self.call("/api/meals", "POST", {
            "day": "2026-10-07", "category": "Dinner", "recipeIds": [omelets["id"], omelets["id"]],
        })[0], 400)
        meals = {meal["id"]: meal for meal in self.call(path)[1]["meals"]}
        self.assertEqual(meals[combo["id"]]["title"], "Omelets + Wraps")
        self.assertEqual(meals[combo["id"]]["recipeIds"], [omelets["id"], wraps["id"]])
        self.assertEqual(meals[combo["id"]]["recipe_id"], omelets["id"])
        self.assertEqual((meals[named["id"]]["title"], meals[named["id"]]["servings"]), ("Big breakfast", 2))
        self.assertEqual((meals[legacy["id"]]["title"], meals[legacy["id"]]["recipeIds"]), ("Omelets", [omelets["id"]]))

        self.assertEqual(self.call(f"/api/meals/{named['id']}", "PATCH", {
            "recipeIds": [wraps["id"]], "notes": "Make extra", "servings": 4,
        })[0], 200)
        edited = next(meal for meal in self.call(path)[1]["meals"] if meal["id"] == named["id"])
        self.assertEqual((edited["title"], edited["recipeIds"], edited["notes"], edited["servings"]),
                         ("Wraps", [wraps["id"]], "Make extra", 4))
        self.assertEqual(self.call(f"/api/meals/{named['id']}", "PATCH", {"category": "Dinner"})[0], 400)
        self.assertEqual(self.call(f"/api/meals/{named['id']}", "PATCH", {"recipeIds": [wraps["id"]], "servings": 2})[0], 200)

        _, manual = self.call("/api/list-items", "POST", {"listId": "groceries", "title": "2 eggs"})
        _, checked = self.call("/api/list-items", "POST", {"listId": "groceries", "title": "1 cup milk", "section": "Meal plan"})
        self.call(f"/api/list-items/{checked['id']}", "PATCH", {"checked": True})

        status, first = self.call("/api/meals/groceries", "POST", {"mealIds": [combo["id"]]})
        self.assertEqual(status, 200)
        self.assertEqual(first["ingredients"], ["12 eggs", "2 cups milk", "4 tortillas"])
        self.assertEqual((first["added"], first["updated"]), (3, 0))
        status, second = self.call("/api/meals/groceries", "POST", {"mealIds": [combo["id"], legacy["id"]]})
        self.assertEqual(second["ingredients"], ["4 eggs", "1 cup milk"])
        self.assertEqual((second["added"], second["updated"], second["skippedMealIds"]), (0, 2, [combo["id"]]))
        repeat = self.call("/api/meals/groceries", "POST", {"mealIds": [combo["id"], legacy["id"]]})[1]
        self.assertEqual((repeat["added"], repeat["updated"], repeat["ingredients"]), (0, 0, []))
        items = {row["id"]: row for row in self.call(path)[1]["listItems"] if row["listId"] == "groceries"}
        self.assertEqual(sorted(row["title"] for row in items.values()),
                         ["1 cup milk", "16 eggs", "2 eggs", "3 cups milk", "4 tortillas"])
        self.assertEqual(items[manual["id"]]["title"], "2 eggs")
        self.assertTrue(items[checked["id"]]["checked"])

        _, backup = self.call("/api/backup")
        self.assertEqual(len(backup["tables"]["meal_grocery_transfers"]), 2)
        self.assertEqual(len(backup["tables"]["meal_recipes"]), 4)
        self.assertEqual(self.call("/api/restore", "POST", backup)[0], 200)
        self.assertEqual(self.call("/api/meals/groceries", "POST", {"mealIds": [legacy["id"]]})[1]["added"], 0)
        self.assertEqual(self.call(f"/api/recipes/{wraps['id']}", "DELETE")[0], 200)
        combo_after = next(meal for meal in self.call(path)[1]["meals"] if meal["id"] == combo["id"])
        self.assertEqual((combo_after["recipeIds"], combo_after["recipe_id"]), ([omelets["id"]], omelets["id"]))

    def test_repeating_meals_occurrence_and_series_edits(self):
        _, tacos = self.call("/api/recipes", "POST", {"title": "Taco night", "ingredients": "1 lb ground beef", "servings": 4})
        status, created = self.call("/api/meals", "POST", {
            "day": "2026-10-06", "category": "Dinner", "recipeId": tacos["id"],
            "repeatRule": "weekly", "repeatUntil": "2026-11-30",
        })
        self.assertEqual(status, 201)
        self.assertEqual(len(created["ids"]), 6)
        self.assertEqual(created["id"], created["ids"][0])
        for invalid in ({"repeatRule": "yearly"}, {"repeatRule": "weekly", "repeatUntil": "2026-10-01"}):
            self.assertEqual(self.call("/api/meals", "POST", {
                "day": "2026-10-08", "category": "Dinner", "title": "Soup", **invalid,
            })[0], 400)
        self.assertEqual(self.call("/api/meals", "POST", {"day": "2026-10-13", "category": "Dinner", "title": "Pizza"})[0], 400)

        october = "/api/state?from=2026-10-04&to=2026-11-08"
        november = "/api/state?from=2026-11-08&to=2026-12-07"

        def dinners(path):
            return {meal["day"]: meal for meal in self.call(path)[1]["meals"] if meal["category"] == "Dinner"}

        series = dinners(october)
        self.assertEqual(sorted(series), ["2026-10-06", "2026-10-13", "2026-10-20", "2026-10-27", "2026-11-03"])
        self.assertTrue(all(meal["repeatRule"] == "weekly" and meal["repeatUntil"] == "2026-11-30" and
                            meal["seriesId"] == created["seriesId"] for meal in series.values()))
        self.assertEqual(sorted(dinners(november)), ["2026-11-10", "2026-11-17", "2026-11-24"])

        moved = series["2026-10-13"]["id"]
        self.assertEqual(self.call(f"/api/meals/{moved}?scope=bogus", "PATCH", {"day": "2026-10-14"})[0], 400)
        self.assertEqual(self.call(f"/api/meals/{moved}", "PATCH", {"day": "2026-10-14", "repeatRule": "daily"})[0], 400)
        self.assertEqual(self.call(f"/api/meals/{moved}", "PATCH", {
            "day": "2026-10-14", "repeatRule": "weekly", "repeatUntil": "2026-11-30",
        })[0], 200)
        self.assertEqual(self.call(f"/api/meals/{series['2026-10-20']['id']}", "DELETE")[0], 200)
        self.assertEqual(self.call("/api/meals", "POST", {"day": "2026-10-20", "category": "Dinner", "title": "Pizza"})[0], 201)
        series = dinners(october)
        self.assertEqual(sorted(series), ["2026-10-06", "2026-10-14", "2026-10-20", "2026-10-27", "2026-11-03"])
        self.assertTrue(series["2026-10-14"]["detached"])
        self.assertEqual(series["2026-10-14"]["occurrenceDay"], "2026-10-13")
        self.assertEqual(series["2026-10-20"]["title"], "Pizza")

        pivot = series["2026-10-27"]["id"]
        status, rewritten = self.call(f"/api/meals/{pivot}?scope=series", "PATCH", {"notes": "Taco Tuesday", "servings": 8})
        self.assertEqual(status, 200)
        self.assertEqual(rewritten["id"], pivot)
        self.assertNotEqual(rewritten["seriesId"], created["seriesId"])
        series = dinners(october)
        self.assertEqual([series[day]["notes"] for day in ("2026-10-06", "2026-10-14", "2026-10-27", "2026-11-03")],
                         ["", "", "Taco Tuesday", "Taco Tuesday"])
        self.assertEqual(series["2026-10-06"]["repeatUntil"], "2026-10-26")
        later = dinners(november)
        self.assertEqual(sorted(later), ["2026-11-10", "2026-11-17", "2026-11-24"])
        self.assertTrue(all(meal["servings"] == 8 and meal["seriesId"] == rewritten["seriesId"] for meal in later.values()))

        grocery = self.call("/api/meals/groceries", "POST", {"mealIds": [pivot]})[1]
        self.assertEqual(grocery["ingredients"], ["2 lb ground beef"])

        self.assertEqual(self.call(f"/api/meals/{later['2026-11-17']['id']}?scope=series", "DELETE")[0], 200)
        self.assertEqual(sorted(dinners(november)), ["2026-11-10"])
        self.assertEqual(sorted(dinners(october)), ["2026-10-06", "2026-10-14", "2026-10-20", "2026-10-27", "2026-11-03"])

        _, soup = self.call("/api/meals", "POST", {"day": "2026-12-01", "category": "Lunch", "title": "Soup"})
        status, converted = self.call(f"/api/meals/{soup['id']}", "PATCH", {"repeatRule": "daily", "repeatUntil": "2026-12-03"})
        self.assertEqual(status, 200)
        lunches = [meal for meal in self.call("/api/state?from=2026-12-01&to=2026-12-08")[1]["meals"]
                   if meal["category"] == "Lunch"]
        self.assertEqual([(meal["day"], meal["title"]) for meal in lunches],
                         [("2026-12-01", "Soup"), ("2026-12-02", "Soup"), ("2026-12-03", "Soup")])
        self.assertEqual(lunches[0]["id"], soup["id"])
        self.assertTrue(all(meal["seriesId"] == converted["seriesId"] for meal in lunches))

        _, backup = self.call("/api/backup")
        self.assertEqual(self.call("/api/restore", "POST", backup)[0], 200)
        self.assertEqual(sorted(dinners(october)), ["2026-10-06", "2026-10-14", "2026-10-20", "2026-10-27", "2026-11-03"])
        self.assertEqual(self.call(f"/api/meals/{soup['id']}?scope=series", "DELETE")[0], 200)
        self.assertEqual(self.call("/api/state?from=2026-12-01&to=2026-12-08")[1]["meals"], [])


class FirstRunTest(DashboardServerCase):
    def environment(self):
        return {"ENVE_DEMO_SEED": "0"}

    def test_incomplete_setup_survives_restart(self):
        self.assertTrue(self.call('/api/setup/status')[1]['needed'])
        self.server.terminate()
        self.server.wait(timeout=5)
        self.server.stderr.close()
        env = os.environ.copy()
        env.update(PORT=str(self.port), DATABASE_PATH=str(Path(self.temp.name) / 'family.sqlite'), ENVE_DEMO_SEED='0')
        self.server = subprocess.Popen(['node', 'server.js'], cwd=ROOT, env=env,
                                       stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        for _ in range(50):
            try:
                self.assertTrue(self.call('/api/setup/status')[1]['needed'])
                break
            except (URLError, ConnectionError):
                time.sleep(0.05)
        else:
            self.fail(self.server.stderr.read().decode())

    def test_connected_program_keys_limit_access_and_can_be_revoked(self):
        payload = {
            'householdName': 'Home', 'signInMode': 'shared',
            'owner': {'name': 'Alex', 'color': '#6CA8DF', 'password': 'example password 123'},
            'people': [],
        }
        _, cookie, _ = self.post_with_cookie('/api/setup/complete', payload)
        owner = {'Cookie': cookie.split(';')[0]}
        self.assertEqual(self.call('/api/integrations/keys')[0], 401)
        status, reader = self.call('/api/integrations/keys', 'POST',
                                   {'name': 'Daily checker', 'scope': 'read'}, owner)
        self.assertEqual(status, 201)
        read_header = {'Authorization': 'Bearer ' + reader['token']}
        self.assertEqual(len(reader['token']), 69)
        self.assertEqual(self.call('/api/integrations/v1/profiles', headers=read_header)[0], 200)
        self.assertEqual(self.call('/api/integrations/v1/tasks', 'POST',
                                   {'title': 'No', 'profileId': 'family'}, read_header)[0], 403)
        self.assertEqual(self.call('/api/settings', headers=read_header)[0], 401)
        self.assertEqual(self.call('/api/integrations/v1/events?from=bad&to=2026-10-12',
                                   headers=read_header)[0], 400)

        status, writer = self.call('/api/integrations/keys', 'POST',
                                   {'name': 'Planner', 'scope': 'read_write'}, owner)
        self.assertEqual(status, 201)
        write_header = {'Authorization': 'Bearer ' + writer['token']}
        profiles = self.call('/api/integrations/v1/profiles', headers=write_header)[1]['profiles']
        alex_id = next(profile['id'] for profile in profiles if profile['name'] == 'Alex')
        self.assertEqual(self.call('/api/pin', 'POST', {'pin': '2846'}, owner)[0], 200)
        status, task = self.call('/api/integrations/v1/tasks', 'POST',
                                 {'title': 'Check school forms', 'profileId': alex_id,
                                  'dueDate': '2026-10-12'}, write_header)
        self.assertEqual(status, 201)
        self.assertEqual(self.call('/api/integrations/v1/tasks/' + task['id'], 'PATCH',
                                   {'completed': True}, write_header)[0], 200)
        status, event = self.call('/api/integrations/v1/events', 'POST',
                                  {'title': 'School open house', 'profileId': alex_id,
                                   'start': '2026-10-12T18:00:00Z',
                                   'end': '2026-10-12T19:00:00Z'}, write_header)
        self.assertEqual(status, 201)
        events = self.call('/api/integrations/v1/events?from=2026-10-12&to=2026-10-13',
                           headers=write_header)[1]['events']
        self.assertTrue(any(item['id'] == event['id'] for item in events))
        self.assertEqual(self.call('/api/integrations/v1/events/' + event['id'], 'DELETE',
                                   headers=write_header)[0], 404)
        self.assertEqual(self.call('/api/integrations/keys', headers=owner)[1]['keys'][0]['name'], 'Planner')

        request = Request(self.origin + '/api/pin/unlock', data=json.dumps({'pin': '2846'}).encode(),
                          method='POST', headers={'Content-Type': 'application/json', **owner})
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            pin_cookie = response.headers['Set-Cookie']
        cookies = {'Cookie': owner['Cookie'] + '; ' + pin_cookie.split(';')[0]}
        self.assertEqual(self.call('/api/integrations/keys/' + writer['id'], 'DELETE',
                                   headers=cookies)[0], 200)
        self.assertEqual(self.call('/api/integrations/v1/profiles', headers=write_header)[0], 401)

    def test_shared_first_run_requires_setup_and_password(self):
        self.assertEqual(self.call('/api/setup/status'), (200, {'needed': True,
            'browserSetupAllowed': True, 'bootstrapRequired': False}))
        self.assertEqual(self.call('/api/state')[0], 409)
        payload = {
            'householdName': 'The Test Family', 'signInMode': 'shared',
            'owner': {'name': 'Alex', 'color': '#6CA8DF', 'password': 'correct horse battery staple'},
            'people': [{'name': 'Sam', 'color': '#A88ADD'}],
        }
        self.assertEqual(self.call('/api/setup/complete', 'POST', {**payload, 'owner': {**payload['owner'], 'password': '123'}})[0], 400)
        status, cookie, _ = self.post_with_cookie('/api/setup/complete', payload)
        self.assertEqual(status, 201)
        self.assertIn('HttpOnly', cookie)
        self.assertEqual(self.call('/api/wifi/networks')[0], 403)
        wifi_request = Request(self.origin + '/api/wifi/networks',
                               headers={'Cookie': cookie.split(';')[0]})
        with urlopen(wifi_request, timeout=5) as response:
            self.assertEqual(json.load(response)['networks'], [])
        self.assertEqual(self.call('/api/setup/status'), (200, {'needed': False,
            'browserSetupAllowed': True, 'bootstrapRequired': False}))
        self.assertEqual(self.call('/api/state')[0], 401)
        self.assertEqual(self.call('/api/setup/complete', 'POST', payload)[0], 409)
        self.assertEqual(self.call('/api/login', 'POST', {'key': 'wrong'})[0], 401)
        status, login_cookie, _ = self.post_with_cookie('/api/login', {'key': payload['owner']['password']})
        self.assertEqual(status, 200)
        request = Request(self.origin + '/api/state?from=2026-10-01&to=2026-10-08',
                          headers={'Cookie': login_cookie.split(';')[0]})
        with urlopen(request, timeout=5) as response:
            state = json.load(response)
        self.assertEqual(state['settings']['household_name'], 'The Test Family')
        self.assertEqual({profile['name'] for profile in state['profiles']}, {'Family', 'Enve', 'Alex', 'Sam'})

    def test_no_password_setup_can_add_a_sign_in_later(self):
        payload = {
            'householdName': 'Home', 'signInMode': 'none',
            'owner': {'name': 'Alex', 'color': '#6CA8DF', 'password': ''},
            'people': [{'name': 'Sam', 'color': '#A88ADD'}],
        }
        status, cookie, _ = self.post_with_cookie('/api/setup/complete', payload)
        self.assertEqual(status, 201)
        self.assertIsNone(cookie)
        self.assertEqual(self.call('/api/state?from=2026-10-01&to=2026-10-08')[0], 200)
        self.assertEqual(self.call('/api/users')[1]['mode'], 'none')
        self.assertEqual(self.call('/api/users/activate', 'POST', {'mode': 'shared', 'password': '2468'})[0], 201)
        self.assertEqual(self.call('/api/state?from=2026-10-01&to=2026-10-08')[0], 401)
        _, cookie, _ = self.post_with_cookie('/api/login', {'key': '2468'})
        self.assertEqual(self.call('/api/users/disable', 'POST', {'confirm': True})[0], 401)
        self.assertEqual(self.call('/api/users/disable', 'POST', {'confirm': False}, {'Cookie': cookie.split(';')[0]})[0], 400)
        self.assertEqual(self.call('/api/users/disable', 'POST', {'confirm': True}, {'Cookie': cookie.split(';')[0]})[0], 200)
        self.assertEqual(self.call('/api/state?from=2026-10-01&to=2026-10-08')[0], 200)

    def test_shared_sign_in_can_become_individual(self):
        payload = {
            'householdName': 'Home', 'signInMode': 'shared',
            'owner': {'name': 'Alex', 'color': '#6CA8DF', 'password': '2468'},
            'people': [],
        }
        _, cookie, _ = self.post_with_cookie('/api/setup/complete', payload)
        owner = {'Cookie': cookie.split(';')[0]}
        profiles = self.call('/api/state?from=2026-10-01&to=2026-10-08', headers=owner)[1]['profiles']
        alex = next(profile for profile in profiles if profile['name'] == 'Alex')
        self.assertEqual(self.call('/api/users/individual', 'POST', {
            'username': 'alex', 'displayName': 'Alex', 'profileId': alex['id'],
        }, owner)[0], 200)
        self.assertEqual(self.call('/api/login', 'POST', {'key': '2468'})[0], 401)
        self.assertEqual(self.call('/api/login', 'POST', {'username': 'alex', 'key': '2468'})[0], 200)

    def test_individual_adult_sign_ins(self):
        payload = {
            'householdName': 'Home', 'signInMode': 'individual',
            'owner': {'name': 'Alex', 'color': '#6CA8DF', 'username': 'alex', 'password': 'first strong password'},
            'people': [{'name': 'Sam', 'color': '#A88ADD', 'adult': True,
                        'username': 'sam', 'password': 'second strong password'}],
        }
        self.assertEqual(self.post_with_cookie('/api/setup/complete', payload)[0], 201)
        self.assertEqual(self.call('/api/login', 'POST', {'key': 'first strong password'})[0], 401)
        _, owner_cookie, _ = self.post_with_cookie('/api/login', {'username': 'alex', 'key': 'first strong password'})
        _, member_cookie, _ = self.post_with_cookie('/api/login', {'username': 'sam', 'key': 'second strong password'})
        for cookie, expected in [(owner_cookie, 200), (member_cookie, 403)]:
            request = Request(self.origin + '/api/users', headers={'Cookie': cookie.split(';')[0]})
            try:
                response = urlopen(request, timeout=5)
            except HTTPError as error:
                response = error
            with response:
                self.assertEqual(response.status, expected)

    def test_device_session_requires_private_key(self):
        key = (Path(self.temp.name) / '.device-key').read_text().strip()
        self.assertEqual(len(key), 64)
        self.assertEqual(self.call('/api/device/session', 'POST', {})[0], 403)
        payload = {
            'householdName': 'Home', 'signInMode': 'shared',
            'owner': {'name': 'Alex', 'color': '#6CA8DF', 'password': 'example password 123'},
            'people': [],
        }
        self.assertEqual(self.post_with_cookie('/api/setup/complete', payload)[0], 201)
        self.assertEqual(self.call('/api/device/session', 'POST', {})[0], 403)
        request = Request(self.origin + '/api/device/session', data=b'{}', method='POST',
                          headers={'Content-Type': 'application/json', 'X-Enve-Device-Key': key})
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertIn('enve_session=', response.headers['Set-Cookie'])

    def test_wall_display_opens_without_owner_password(self):
        self.assertEqual(self.call('/api/kiosk/session', 'POST', {})[0], 403)
        self.post_with_cookie('/api/setup/complete', {
            'householdName': 'Home', 'signInMode': 'shared',
            'owner': {'name': 'Alex', 'color': '#6CA8DF', 'password': 'example password 123'},
            'people': [],
        })
        status, cookie, _ = self.post_with_cookie('/api/kiosk/session', {})
        self.assertEqual(status, 200)
        headers = {'Cookie': cookie.split(';')[0]}
        self.assertEqual(self.call('/api/state?from=2026-10-01&to=2026-10-08', headers=headers)[0], 200)
        self.assertEqual(self.call('/api/users', headers=headers)[0], 403)
        self.assertEqual(self.call('/api/wifi/networks', headers=headers)[0], 200)
        self.assertEqual(self.call('/api/wifi/networks', headers={**headers, 'Host': 'enve-family.local:4317'})[0], 403)


class RemoteFirstRunTest(DashboardServerCase):
    def environment(self):
        return {'ENVE_DEMO_SEED': '0', 'HOST': '0.0.0.0', 'ACCESS_KEY': 'example bootstrap key 123'}

    def call(self, path, method="GET", payload=None, headers=None):
        return super().call(path, method, payload, {'Host': 'enve-family.local:4317', **(headers or {})})

    def test_remote_setup_needs_bootstrap_key(self):
        self.assertEqual(self.call('/api/setup/status')[1], {
            'needed': True, 'browserSetupAllowed': True, 'bootstrapRequired': True})
        payload = {
            'householdName': 'Home', 'signInMode': 'shared',
            'owner': {'name': 'Alex', 'color': '#6CA8DF', 'password': 'example password 123'},
            'people': [],
        }
        self.assertEqual(self.call('/api/setup/complete', 'POST', payload)[0], 403)
        request = Request(self.origin + '/api/setup/complete', data=json.dumps(payload).encode(), method='POST',
                          headers={'Content-Type': 'application/json', 'Host': 'enve-family.local:4317',
                                   'X-Enve-Bootstrap-Key': 'example bootstrap key 123'})
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 201)
        self.assertEqual(self.call('/api/setup/complete', 'POST', payload)[0], 403)
        self.assertEqual(self.call('/api/kiosk/session', 'POST', {})[0], 403)


class DeviceOnlyFirstRunTest(DashboardServerCase):
    def environment(self):
        return {'ENVE_DEMO_SEED': '0', 'HOST': '0.0.0.0', 'ACCESS_KEY': ''}

    def call(self, path, method="GET", payload=None, headers=None):
        return super().call(path, method, payload, {'Host': 'enve-family.local:4317', **(headers or {})})

    def test_network_browser_waits_for_wall_setup(self):
        self.assertEqual(self.call('/api/setup/status')[1], {
            'needed': True, 'browserSetupAllowed': False, 'bootstrapRequired': False})
        self.assertEqual(self.call('/api/setup/network')[0], 403)
        self.assertEqual(self.call('/api/wifi/networks')[0], 403)
        self.assertEqual(self.call('/api/wifi/connect', 'POST', {
            'ssid': 'Test network', 'password': 'test password', 'security': 'personal'})[0], 403)
        key = (Path(self.temp.name) / '.device-key').read_text().strip()
        request = Request(self.origin + '/api/wifi/networks',
                          headers={'X-Enve-Device-Key': key})
        with urlopen(request, timeout=5) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(json.load(response)['networks'], [])

    def test_local_kiosk_can_open_setup_when_listening_on_lan(self):
        self.assertEqual(super().call('/api/setup/status')[1], {
            'needed': True, 'browserSetupAllowed': True, 'bootstrapRequired': False})
        self.assertEqual(super().call('/api/wifi/networks')[0], 200)


class TailscaleAccessTest(DashboardServerCase):
    def environment(self):
        return {'ENVE_DEMO_SEED': '0', 'ENVE_TAILSCALE_BIN': '/missing/tailscale'}

    def test_only_local_owner_can_manage_private_access(self):
        self.assertEqual(self.call('/api/tailscale/status')[0], 403)
        payload = {
            'householdName': 'Home', 'signInMode': 'individual',
            'owner': {'name': 'Alex', 'color': '#6CA8DF', 'username': 'alex', 'password': 'owner password'},
            'people': [{'name': 'Sam', 'color': '#A88ADD', 'adult': True,
                        'username': 'sam', 'password': 'member password'}],
        }
        self.post_with_cookie('/api/setup/complete', payload)
        _, owner_cookie, _ = self.post_with_cookie('/api/login', {'username': 'alex', 'key': 'owner password'})
        _, member_cookie, _ = self.post_with_cookie('/api/login', {'username': 'sam', 'key': 'member password'})
        owner = {'Cookie': owner_cookie.split(';')[0]}
        member = {'Cookie': member_cookie.split(';')[0]}
        self.assertEqual(self.call('/api/tailscale/status')[0], 403)
        self.assertEqual(self.call('/api/tailscale/status', headers=member)[0], 403)
        self.assertEqual(self.call('/api/tailscale/status', headers=owner)[1]['installed'], False)
        self.assertEqual(self.call('/api/tailscale/login', 'POST', {}, owner)[0], 400)
        self.assertEqual(self.call('/api/tailscale/serve', 'POST', {}, owner)[0], 400)
        remote = {**owner, 'Host': 'enve-family.local:4317'}
        self.assertEqual(self.call('/api/tailscale/status', headers=remote)[0], 403)
        self.assertEqual(self.call('/api/tailscale/serve', 'POST', {}, remote)[0], 403)
        for headers in ({}, member, remote):
            self.assertEqual(self.call('/api/device/status', headers=headers)[0], 403)
            self.assertEqual(self.call('/api/device/action', 'POST', {'action': 'reboot'}, headers)[0], 403)
        self.assertEqual(self.call('/api/device/status', headers=owner)[0], 200)
        self.assertEqual(self.call('/api/device/action', 'POST', {'action': 'shell'}, owner)[0], 400)
        self.assertEqual(self.call('/api/device/action', 'POST', {'action': 'reboot'},
                                  {**owner, 'Origin': 'https://example.com'})[0], 403)
        _, wall_cookie, _ = self.post_with_cookie('/api/kiosk/session', {})
        wall = {'Cookie': wall_cookie.split(';')[0]}
        self.assertEqual(self.call('/api/device/status', headers=wall)[0], 200)
        self.assertFalse(self.call('/api/device/status', headers=wall)[1]['ownerAccess'])
        self.assertEqual(self.call('/api/pin', 'POST', {'pin': '2846'}, owner)[0], 200)
        self.assertEqual(self.call('/api/device/action', 'POST', {'action': 'restart-display'}, wall)[0], 423)


class LegacyMealDatabaseTest(DashboardServerCase):
    recipe_id = "a" * 32
    meal_id = "b" * 32
    duplicate_id = "c" * 32

    def prepare_database(self, path):
        with sqlite3.connect(path) as connection:
            connection.executescript(f"""
                CREATE TABLE photos (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL,
                  content BLOB NOT NULL, created_at TEXT NOT NULL);
                CREATE TABLE recipes (id TEXT PRIMARY KEY, title TEXT NOT NULL, ingredients TEXT NOT NULL,
                  directions TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
                CREATE TABLE meals (id TEXT PRIMARY KEY, day TEXT NOT NULL, category TEXT NOT NULL,
                  title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
                  recipe_id TEXT REFERENCES recipes(id) ON DELETE SET NULL, servings INTEGER);
                INSERT INTO recipes VALUES ('{self.recipe_id}', 'Pancakes', '2 eggs\n1 cup flour', '', '2026-01-01T00:00:00Z');
                INSERT INTO meals VALUES ('{self.meal_id}', '2026-10-05', 'Breakfast', 'Pancakes', '', '{self.recipe_id}', 8);
                INSERT INTO meals VALUES ('{self.duplicate_id}', '2026-10-05', 'Breakfast', 'Fruit', '', NULL, NULL);
            """)
        connection.close()

    def test_existing_meals_keep_ids_and_gain_recipe_links(self):
        path = "/api/state?from=2026-10-04&to=2026-10-11"
        meals = {meal["id"]: meal for meal in self.call(path)[1]["meals"]}
        self.assertEqual(set(meals), {self.meal_id, self.duplicate_id})
        pancakes = meals[self.meal_id]
        self.assertEqual((pancakes["recipe_id"], pancakes["recipeIds"], pancakes["repeatRule"], pancakes["seriesId"]),
                         (self.recipe_id, [self.recipe_id], "none", None))
        self.assertEqual(meals[self.duplicate_id]["recipeIds"], [])
        self.assertEqual(self.call("/api/meals/groceries", "POST", {"mealIds": [self.meal_id]})[1]["ingredients"],
                         ["4 eggs", "2 cups flour"])
        self.assertEqual(self.call(f"/api/meals/{self.meal_id}", "PATCH", {"category": "Lunch"})[0], 200)
        self.assertEqual(self.call("/api/meals", "POST", {"day": "2026-10-05", "category": "Lunch", "title": "Soup"})[0], 400)

        _, backup = self.call("/api/backup")
        for table in ("meal_recipes", "meal_series", "meal_series_skips", "meal_grocery_transfers"):
            backup["tables"].pop(table)
        for row in backup["tables"]["meals"]:
            for column in ("series_id", "occurrence_day", "detached"):
                row.pop(column)
        self.assertEqual(self.call("/api/restore", "POST", backup)[0], 200)
        restored = next(meal for meal in self.call(path)[1]["meals"] if meal["id"] == self.meal_id)
        self.assertEqual((restored["category"], restored["recipeIds"]), ("Lunch", [self.recipe_id]))


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        return None


class CloudMealApiTest(DashboardServerCase):
    def environment(self):
        self.mock_log = Path(self.temp.name) / "cloud.log"
        return {
            "NODE_OPTIONS": f"--import={(ROOT / 'test' / 'mock_fetch.mjs').as_uri()}",
            "MOCK_FETCH_LOG": str(self.mock_log),
            "OPENAI_API_KEY": "synthetic-test-key",
        }

    def test_cloud_ideas_are_reviewed_before_saving(self):
        self.assertTrue(self.call("/api/state?from=2026-10-04&to=2026-10-11")[1]["cloudMealIdeasConfigured"])
        status, result = self.call("/api/meals/ideas", "POST", {
            "startDay": "2026-10-04", "categories": ["Dinner"],
            "servings": 4, "source": "cloud",
        })
        self.assertEqual(status, 200)
        self.assertEqual(len(result["suggestions"]), 7)
        self.assertEqual(result["suggestions"][0]["draftRecipe"]["title"], "Mock tomato pasta")
        self.assertEqual(self.call("/api/state?from=2026-10-04&to=2026-10-11")[1]["recipes"], [])
        selected = result["suggestions"][0]
        status, planned = self.call("/api/meals/plan", "POST", {"meals": [{
            "day": selected["day"], "category": selected["category"],
            "servings": selected["servings"], "draftRecipe": selected["draftRecipe"],
        }]})
        self.assertEqual(status, 201)
        self.assertEqual(len(planned["createdRecipeIds"]), 1)
        self.assertIn("POST https://api.openai.com/v1/responses", self.mock_log.read_text())


class ProviderApiTest(DashboardServerCase):
    def environment(self):
        self.mock_log = Path(self.temp.name) / "provider.log"
        return {
            "NODE_OPTIONS": f"--import={(ROOT / 'test' / 'mock_fetch.mjs').as_uri()}",
            "MOCK_FETCH_LOG": str(self.mock_log),
            "OUTLOOK_CLIENT_ID": "test-outlook-client",
            "OUTLOOK_CLIENT_SECRET": "test-outlook-secret",
            "GOOGLE_CLIENT_ID": "test-google-client",
            "GOOGLE_CLIENT_SECRET": "test-google-secret",
            "GOOGLE_REDIRECT_URI": "https://family.example.test/api/google/callback",
        }

    def redirect(self, path):
        opener = build_opener(NoRedirect)
        try:
            response = opener.open(self.origin + path, timeout=5)
        except HTTPError as error:
            response = error
        with response:
            return response.status, response.headers.get("Location")

    def test_google_and_outlook_connections(self):
        status, location = self.redirect("/api/outlook/start?profileId=family")
        self.assertEqual(status, 302)
        self.assertIn("code_challenge", parse_qs(urlparse(location).query))
        state = parse_qs(urlparse(location).query)["state"][0]
        self.assertEqual(self.redirect(f"/api/outlook/callback?state={state}&code=fake")[0], 302)

        status, location = self.redirect("/api/google/start?profileId=family")
        self.assertEqual(status, 302)
        self.assertEqual(parse_qs(urlparse(location).query)["redirect_uri"],
                         ["https://family.example.test/api/google/callback"])
        state = parse_qs(urlparse(location).query)["state"][0]
        self.assertEqual(self.redirect(f"/api/google/callback?state={state}&code=fake")[0], 302)

        _, dashboard = self.call("/api/state?from=2026-10-04&to=2026-10-11")
        self.assertEqual(len(dashboard["outlookAccounts"]), 1)
        self.assertEqual(len(dashboard["accounts"]), 1)
        self.assertEqual(dashboard["syncFailures"], [])
        outlook = next(row for row in dashboard["events"] if row["source"] == "outlook")
        google = next(row for row in dashboard["events"] if row["source"] == "google")
        self.assertEqual(outlook["start"], "2026-10-05T09:00:00.000Z")
        self.assertFalse(outlook.get("writable", False))
        self.assertEqual(google["color"], "#ABCDEF")
        self.assertEqual(next(row for row in dashboard["events"] if row["title"] == "Google default color")["color"], "#123456")
        endpoint = f"/api/google/events/{quote(google['calendarId'])}/{quote(google['googleEventId'])}"
        self.assertEqual(self.call(endpoint, "PATCH", {
            "title": "Changed", "profileId": "family", "allDay": False,
            "start": "2026-10-05T11:00:00Z", "end": "2026-10-05T12:00:00Z",
        })[0], 200)
        self.assertEqual(self.call(endpoint, "DELETE")[0], 200)
        self.assertIn("PATCH https://www.googleapis.com/calendar/v3/calendars/google%40example.test/events/google-event",
                      self.mock_log.read_text())

    def test_search_reaches_connected_calendars_beyond_displayed_dates(self):
        for provider in ("outlook", "google"):
            state = parse_qs(urlparse(self.redirect(f"/api/{provider}/start?profileId=family")[1]).query)["state"][0]
            self.assertEqual(self.redirect(f"/api/{provider}/callback?state={state}&code=fake")[0], 302)
        self.call("/api/events", "POST", {
            "title": "Dentist forms", "profileId": "family", "allDay": True, "start": "2026-10-07", "end": "2026-10-08",
        })
        status, result = self.call("/api/search?q=Dentist")
        self.assertEqual(status, 200)
        self.assertEqual([item["title"] for item in result["events"]], ["Dentist forms"])
        self.assertEqual([(item["title"], item["source"], item["start"]) for item in result["connectedEvents"]],
                         [("Dentist checkup far ahead", "google", "2027-06-15T16:00:00Z")])
        self.assertEqual(result["failures"], [])
        coverage = {item["source"]: item for item in result["coverage"]}
        self.assertEqual(set(coverage), {"google", "outlook"})
        self.assertEqual((coverage["google"]["method"], coverage["outlook"]["method"]), ("query", "range"))
        self.assertTrue(coverage["google"]["from"] < coverage["google"]["to"])
        self.assertIn("GET https://www.googleapis.com/calendar/v3/calendars/google%40example.test/events q=dentist",
                      self.mock_log.read_text())
        self.assertEqual({item["title"] for item in self.call("/api/search?q=appointment")[1]["connectedEvents"]},
                         {"Google appointment", "Outlook appointment"})
        failed = self.call("/api/search?q=unavailable")[1]
        self.assertEqual([(item["source"], item["calendar"]) for item in failed["failures"]], [("google", "Main")])
        self.assertEqual(failed["connectedEvents"], [])


if __name__ == "__main__":
    unittest.main()

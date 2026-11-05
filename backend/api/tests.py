import json
from unittest.mock import patch

from django.test import TestCase, Client

from . import fallback
from . import llm


MANIFEST = {
    'variants': [
        {
            'assetId': 'kniga', 'name': 'Книга', 'state': 'main', 'size': 'L',
            'synonyms': ['книга', 'book', 'образование', 'учёба', 'обучение'],
            'tags': ['education', 'knowledge', 'образование', 'обучение'],
        },
        {
            'assetId': 'moneta', 'name': 'Монета', 'state': 'main', 'size': 'L',
            'synonyms': ['монета', 'coin', 'деньги', 'финансы'],
            'tags': ['finance', 'money', 'деньги'],
        },
        {
            'assetId': 'telefon', 'name': 'Телефон', 'state': 'main', 'size': 'L',
            'synonyms': ['телефон', 'phone'], 'tags': ['technology'],
        },
        {
            'assetId': 'lampa', 'name': 'Лампа', 'state': 'main', 'size': 'L',
            'synonyms': ['лампа', 'light', 'идея'],
            'tags': ['idea', 'technology', 'идея'],
        },
        {
            'assetId': 'papka', 'name': 'Папка', 'state': 'main', 'size': 'L',
            'synonyms': ['папка', 'folder'],
            'tags': ['documents', 'office'],
            'backgroundFor': ['финансы', 'бюджет'],
        },
        {
            'assetId': 'kniga', 'name': 'Книга', 'state': 'background', 'size': 'L',
            'synonyms': [], 'tags': [],
        },
    ]
}


class ApiTest(TestCase):
    def setUp(self):
        self.client = Client()

    def test_health(self):
        response = self.client.get('/api/health/')
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data['status'], 'ok')
        self.assertIn('llm_configured', data)

    def test_manifest(self):
        response = self.client.get('/api/manifest/')
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertIn('variants', data)
        self.assertEqual(len(data['variants']), 40)

    def test_interpret_metaphor_local_fallback(self):
        with patch.dict('os.environ', {
            'LLM_BASE_URL': '', 'LLM_MODEL': '', 'LLM_API_KEY': '',
        }, clear=False):
            response = self.client.post(
                '/api/interpret-metaphor/',
                data=json.dumps({'text': 'образование'}),
                content_type='application/json',
            )
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data['source'], 'local_fallback')
        self.assertTrue(data['objects'])
        self.assertIn('kniga', [o['assetId'] for o in data['objects']])

    def test_endpoint_adds_a_background_object(self):
        with patch.dict('os.environ', {
            'LLM_BASE_URL': '', 'LLM_MODEL': '', 'LLM_API_KEY': '',
        }, clear=False):
            response = self.client.post(
                '/api/interpret-metaphor/',
                data=json.dumps({'text': 'финансы'}),
                content_type='application/json',
            )
        data = json.loads(response.content)
        roles = {o['role'] for o in data['objects']}
        self.assertIn('main', roles)
        self.assertIn('background', roles)

    def test_endpoint_finds_obuchenie(self):
        with patch.dict('os.environ', {
            'LLM_BASE_URL': '', 'LLM_MODEL': '', 'LLM_API_KEY': '',
        }, clear=False):
            response = self.client.post(
                '/api/interpret-metaphor/',
                data=json.dumps({'text': 'Обучение'}),
                content_type='application/json',
            )
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data['source'], 'local_fallback')
        self.assertIn('kniga', [o['assetId'] for o in data['objects']])

    def test_interpret_metaphor_requires_text(self):
        response = self.client.post(
            '/api/interpret-metaphor/',
            data=json.dumps({'text': ''}),
            content_type='application/json',
        )
        self.assertEqual(response.status_code, 400)

    def test_interpret_metaphor_rejects_wrong_method(self):
        response = self.client.get('/api/interpret-metaphor/')
        self.assertEqual(response.status_code, 405)


class LlmProxyTest(TestCase):
    def setUp(self):
        self.allowed = {'kniga', 'moneta', 'telefon', 'lampa'}

    def test_validate_drops_unknown_ids(self):
        raw = {'objects': [
            {'assetId': 'kniga', 'role': 'main'},
            {'assetId': 'drone', 'role': 'main'},
        ]}
        objects, errors = llm.validate_objects(raw['objects'], self.allowed, 3)
        self.assertEqual([o['assetId'] for o in objects], ['kniga'])
        self.assertTrue(any('drone' in e for e in errors))

    def test_validate_drops_invalid_role(self):
        raw = [{'assetId': 'kniga', 'role': 'boss'}]
        objects, errors = llm.validate_objects(raw, self.allowed, 3)
        self.assertEqual(objects, [])
        self.assertTrue(any('role' in e for e in errors))

    def test_validate_limits_main_objects(self):
        raw = [
            {'assetId': 'kniga', 'role': 'main'},
            {'assetId': 'moneta', 'role': 'main'},
            {'assetId': 'telefon', 'role': 'main'},
            {'assetId': 'lampa', 'role': 'main'},
        ]
        objects, errors = llm.validate_objects(raw, self.allowed, 3)
        mains = [o for o in objects if o['role'] == 'main']
        self.assertEqual(len(mains), 3)
        self.assertTrue(any('too many' in e for e in errors))

    def test_parse_json_object_with_fences(self):
        content = '```json\n{"objects": [{"assetId": "kniga", "role": "main"}]}\n```'
        parsed = llm.parse_json_object(content)
        self.assertEqual(parsed['objects'][0]['assetId'], 'kniga')

    def test_parse_json_object_with_prose(self):
        content = 'Вот ответ: {"objects": []} — готово'
        parsed = llm.parse_json_object(content)
        self.assertEqual(parsed['objects'], [])

    def test_parse_json_object_raises_on_garbage(self):
        with self.assertRaises(RuntimeError):
            llm.parse_json_object('no json here')

    def test_build_catalog_deduplicates_states(self):
        catalog = llm.build_catalog(MANIFEST['variants'])
        ids = [c['assetId'] for c in catalog]
        self.assertEqual(len(ids), len(set(ids)))
        expected = len({v['assetId'] for v in MANIFEST['variants'] if v['state'] == 'main'})
        self.assertEqual(len(ids), expected)

    def test_call_llm_builds_prompt_with_literal_json(self):
        # SYSTEM_PROMPT contains a literal {"objects": ...} example. Building
        # the request must not treat those braces as format fields.
        import io
        import urllib.request

        from . import llm as llm_module

        captured = {}

        class FakeResponse(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(req, timeout=None):
            captured['url'] = req.full_url
            captured['body'] = req.data.decode('utf-8')
            return FakeResponse(json.dumps({
                'choices': [{'message': {'content': '{"objects": []}'}}],
            }).encode('utf-8'))

        with patch.dict('os.environ', {
            'LLM_BASE_URL': 'https://example.test/v1',
            'LLM_MODEL': 'test-model',
            'LLM_API_KEY': 'secret',
        }, clear=False):
            with patch.object(urllib.request, 'urlopen', fake_urlopen):
                llm_module.call_llm('учёба', [], 3, 5)

        self.assertIn('https://example.test/v1/chat/completions', captured['url'])

        sent = json.loads(captured['body'])
        system = sent['messages'][0]['content']
        self.assertIn('{"objects"', system)
        self.assertIn('at most 3 objects', system)
        self.assertEqual(sent['temperature'], 0)

    def test_endpoint_uses_llm_when_configured(self):
        with patch.dict('os.environ', {
            'LLM_BASE_URL': 'https://example.test/v1',
            'LLM_MODEL': 'test-model',
            'LLM_API_KEY': 'secret',
        }, clear=False):
            with patch('api.llm.call_llm') as call:
                call.return_value = ({'objects': [{'assetId': 'kniga', 'role': 'main', 'reason': 'ok'}]}, [])
                response = self.client.post(
                    '/api/interpret-metaphor/',
                    data=json.dumps({'text': 'учёба'}),
                    content_type='application/json',
                )
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data['source'], 'llm')
        self.assertEqual(data['objects'][0]['assetId'], 'kniga')
        call.assert_called_once()

    def test_endpoint_falls_back_when_llm_fails(self):
        with patch.dict('os.environ', {
            'LLM_BASE_URL': 'https://example.test/v1',
            'LLM_MODEL': 'test-model',
            'LLM_API_KEY': 'secret',
        }, clear=False):
            with patch('api.llm.call_llm', side_effect=RuntimeError('boom')):
                response = self.client.post(
                    '/api/interpret-metaphor/',
                    data=json.dumps({'text': 'финансы'}),
                    content_type='application/json',
                )
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data['source'], 'local_fallback')
        self.assertIn('moneta', [o['assetId'] for o in data['objects']])

    def test_endpoint_falls_back_when_llm_returns_unknown_ids(self):
        with patch.dict('os.environ', {
            'LLM_BASE_URL': 'https://example.test/v1',
            'LLM_MODEL': 'test-model',
            'LLM_API_KEY': 'secret',
        }, clear=False):
            with patch('api.llm.call_llm') as call:
                call.return_value = ({'objects': [{'assetId': 'alien', 'role': 'main'}]}, [])
                response = self.client.post(
                    '/api/interpret-metaphor/',
                    data=json.dumps({'text': 'что-то'}),
                    content_type='application/json',
                )
        self.assertEqual(response.status_code, 200)
        data = json.loads(response.content)
        self.assertEqual(data['source'], 'local_fallback')
        self.assertNotIn('alien', [o['assetId'] for o in data['objects']])


class FallbackTest(TestCase):
    def test_match_by_tag(self):
        index = fallback.build_index(MANIFEST['variants'])
        matched = fallback.match('финансы и деньги', index, 3)
        self.assertIn('moneta', matched)

    def test_match_by_synonym(self):
        index = fallback.build_index(MANIFEST['variants'])
        matched = fallback.match('купил новый phone', index, 3)
        self.assertIn('telefon', matched)

    def test_match_returns_empty_for_unknown_text(self):
        index = fallback.build_index(MANIFEST['variants'])
        matched = fallback.match('квантовая хромодинамика', index, 3)
        self.assertEqual(matched, [])

    def test_match_finds_obuchenie(self):
        index = fallback.build_index(MANIFEST['variants'])
        matched = fallback.match('Обучение', index, 3)
        self.assertIn('kniga', matched)

    def test_match_handles_word_forms(self):
        index = fallback.build_index(MANIFEST['variants'])
        for word in ['обучению', 'обучения', 'обучением']:
            self.assertIn('kniga', fallback.match(word, index, 3), word)

    def test_pick_background_uses_default_when_nothing_else_matches(self):
        index = fallback.build_index(MANIFEST['variants'])
        bg = fallback.pick_background('обучение', index, {'kniga'}, 'kniga')
        self.assertIsNone(bg, 'the only asset is already used')

    def test_build_background_index_reads_background_for(self):
        index = fallback.build_background_index(MANIFEST['variants'])
        self.assertIn('papka', index.get('финансы', []))

    def test_pick_background_prefers_declared_theme_object(self):
        index = fallback.build_index(MANIFEST['variants'])
        bg_index = fallback.build_background_index(MANIFEST['variants'])
        bg = fallback.pick_background(
            'финансы', index, {'moneta'}, 'kniga', bg_index
        )
        self.assertEqual(bg, 'papka', 'the folder is declared for finance')

    def test_pick_background_ignores_declared_object_used_as_main(self):
        index = fallback.build_index(MANIFEST['variants'])
        bg_index = fallback.build_background_index(MANIFEST['variants'])
        bg = fallback.pick_background(
            'финансы', index, {'moneta', 'papka'}, 'kniga', bg_index
        )
        self.assertEqual(bg, 'kniga', 'falls back to the default')

    def test_pick_background_returns_unused_match(self):
        index = fallback.build_index(MANIFEST['variants'])
        bg = fallback.pick_background('идея', index, {'moneta'}, 'kniga')
        self.assertEqual(bg, 'lampa', 'a matching object is preferred over the default')

    def test_match_respects_limit(self):
        index = fallback.build_index(MANIFEST['variants'])
        matched = fallback.match('технологии и идея и деньги', index, 2)
        self.assertLessEqual(len(matched), 2)

import io
import json
import stat
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from zipfile import ZipFile, ZipInfo

import requests

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python'))
from github_download import GitHubDownloader, check_sources, download_skill


REF = 'a' * 40
URL = f'https://github.com/owner/repo/blob/{REF}/skills/fixture-skill'
CONTENTS = f'https://api.github.com/repos/owner/repo/contents/skills/fixture-skill?ref={REF}'
RAW = f'https://raw.githubusercontent.com/owner/repo/{REF}/skills/fixture-skill/'
SOURCE = b'---\nname: fixture-skill\ndescription: Download fixture.\n---\n# Fixture\nRead references/helper.txt.\n'


def response(status, content=None, headers=None):
    value = requests.Response()
    value.status_code = status
    value.headers.update(headers or {})
    value._content = json.dumps(content).encode() if isinstance(content, (dict, list)) else content or b''
    value._content_consumed = True
    return value


def archive(extra=None):
    stream = io.BytesIO()
    with ZipFile(stream, 'w') as package:
        package.writestr('repo-' + REF + '/', '')
        for name, content in {'SKILL.md': SOURCE, 'references/helper.txt': b'complete helper', **(extra or {})}.items():
            package.writestr(f'repo-{REF}/skills/fixture-skill/{name}', content)
        package.writestr(f'repo-{REF}/unrelated.txt', b'not part of this skill')
    return stream.getvalue()


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='skillnet-download-unit-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.settings = patch('skillnet_ai.downloader.resolve_settings', return_value=SimpleNamespace(github_token=None, github_mirror=None))
        self.settings.start()
        self.addCleanup(self.settings.stop)
        self.client = SimpleNamespace(github_token=None, settings=SimpleNamespace(github_mirror=None))

    def quota(self):
        return response(403, {'message': 'API rate limit exceeded'}, {'x-ratelimit-remaining': '0'})

    def test_catalog_check_uses_pinned_skill_file_without_downloading_package(self):
        with patch('requests.Session.get', return_value=response(200)) as get:
            result = check_sources(self.client, [URL, URL])
        self.assertEqual(result, [{'url': URL, 'status': 'available'}])
        self.assertEqual(get.call_count, 1)
        self.assertEqual(get.call_args.args[0], RAW + 'SKILL.md')
        self.assertTrue(get.call_args.kwargs['stream'])
        self.assertFalse(get.call_args.kwargs['allow_redirects'])

    def test_catalog_missing_is_confirmed_by_api_and_never_switches_revision(self):
        with patch('requests.Session.get', side_effect=[response(404), response(404)]) as get:
            self.assertEqual(check_sources(self.client, [URL])[0]['status'], 'missing')
        self.assertEqual(get.call_args.args[0], CONTENTS.replace('?ref=', '/SKILL.md?ref='))
        self.assertNotIn('main', get.call_args.args[0])

    def test_catalog_transient_errors_do_not_hide_skills(self):
        for status in (401, 403, 429, 500, 503):
            with self.subTest(status=status), patch('requests.Session.get', return_value=response(status)) as get:
                self.assertEqual(check_sources(self.client, [URL])[0]['status'], 'unknown')
                self.assertEqual(get.call_count, 1)
        with patch('requests.Session.get', side_effect=requests.Timeout('fixture timeout')):
            self.assertEqual(check_sources(self.client, [URL])[0]['status'], 'unknown')

    def test_catalog_raw_404_is_not_enough_to_hide_available_or_redirected_sources(self):
        for status, expected in ((200, 'available'), (301, 'unknown'), (403, 'unknown')):
            with self.subTest(status=status), patch('requests.Session.get', side_effect=[response(404), response(status)]):
                self.assertEqual(check_sources(self.client, [URL])[0]['status'], expected)

    def test_catalog_authenticated_check_uses_only_github_api(self):
        self.client.github_token = 'fixture-only-token'
        with patch('requests.Session.get', return_value=response(200)) as get:
            self.assertEqual(check_sources(self.client, [URL])[0]['status'], 'available')
        self.assertEqual(get.call_count, 1)
        self.assertTrue(get.call_args.args[0].startswith('https://api.github.com/'))
        self.assertEqual(get.call_args.kwargs['headers']['Authorization'], 'Bearer fixture-only-token')

    def fallback(self, url, **kwargs):
        if url == CONTENTS:
            return self.quota()
        self.assertEqual(url, f'https://codeload.github.com/owner/repo/zip/{REF}')
        self.assertFalse(kwargs['allow_redirects'])
        self.assertNotIn('Authorization', kwargs['headers'])
        return response(200, archive())

    def test_quota_fallback_publishes_complete_same_revision_only(self):
        with patch('requests.Session.get', side_effect=self.fallback) as get:
            folder = Path(download_skill(self.client, URL, self.root))
        self.assertEqual(get.call_count, 2)
        self.assertEqual((folder / 'SKILL.md').read_bytes(), SOURCE)
        self.assertEqual((folder / 'references/helper.txt').read_bytes(), b'complete helper')
        self.assertFalse((folder / 'unrelated.txt').exists())

    def test_normal_api_download_keeps_resources_without_archive(self):
        def get(url, **kwargs):
            if url == CONTENTS:
                return response(200, [
                    {'type': 'file', 'path': 'skills/fixture-skill/SKILL.md', 'download_url': RAW + 'SKILL.md'},
                    {'type': 'file', 'path': 'skills/fixture-skill/helper.txt', 'download_url': RAW + 'helper.txt'},
                ])
            self.assertTrue(url.startswith(RAW))
            return response(200, SOURCE if url.endswith('SKILL.md') else b'original resource')
        with patch('requests.Session.get', side_effect=get):
            folder = Path(download_skill(self.client, URL, self.root))
        self.assertEqual((folder / 'helper.txt').read_bytes(), b'original resource')

    def test_permission_refusal_does_not_become_anonymous_archive_download(self):
        with patch('requests.Session.get', return_value=response(403, {'message': 'Resource not accessible'}, {'x-ratelimit-remaining': '42'})) as get:
            with self.assertRaisesRegex(ValueError, '403.*未表明'):
                download_skill(self.client, URL, self.root)
        self.assertEqual(get.call_count, 1)
        self.assertFalse((self.root / 'fixture-skill').exists())

    def test_authenticated_quota_is_not_sent_to_public_archive(self):
        self.client.github_token = 'fixture-only-token'
        self.settings.stop()
        with patch('skillnet_ai.downloader.resolve_settings', return_value=SimpleNamespace(github_token='fixture-only-token', github_mirror=None)):
            with patch('requests.Session.get', return_value=self.quota()) as get:
                with self.assertRaisesRegex(ValueError, '限流'):
                    download_skill(self.client, URL, self.root)
        self.assertEqual(get.call_count, 1)

    def test_missing_version_never_falls_back_to_main(self):
        with patch('requests.Session.get', return_value=response(404, {'message': 'Not Found'})) as get:
            with self.assertRaisesRegex(ValueError, '路径或版本不存在'):
                download_skill(self.client, URL, self.root)
        self.assertEqual(get.call_count, 1)
        self.assertEqual(get.call_args.args[0], CONTENTS)

    def test_archive_failure_keeps_error_and_does_not_publish(self):
        with patch('requests.Session.get', side_effect=[self.quota(), response(404)]) as get:
            with self.assertRaisesRegex(ValueError, '限流.*归档.*404'):
                download_skill(self.client, URL, self.root)
        self.assertEqual(get.call_count, 2)
        self.assertFalse((self.root / 'fixture-skill').exists())

    def test_archive_transport_errors_do_not_expose_network_configuration(self):
        with patch('requests.Session.get', side_effect=[self.quota(), requests.ConnectionError('fixture-sensitive-network-detail')]):
            with self.assertRaisesRegex(ValueError, '官方归档也无法连接') as error:
                download_skill(self.client, URL, self.root)
        self.assertNotIn('fixture-sensitive-network-detail', str(error.exception))

    def test_moved_repository_redirect_keeps_ref_and_sdk_validation(self):
        target = f'https://api.github.com/repositories/123/contents/skills/fixture-skill?ref={REF}'
        def get(url, **kwargs):
            if url == CONTENTS:
                return response(301, headers={'location': target})
            if url == target:
                return response(200, [{'type': 'file', 'path': 'skills/fixture-skill/SKILL.md', 'download_url': RAW + 'SKILL.md'}])
            self.assertEqual(url, RAW + 'SKILL.md')
            return response(200, SOURCE)
        with patch('requests.Session.get', side_effect=get):
            folder = Path(download_skill(self.client, URL, self.root))
        self.assertEqual((folder / 'SKILL.md').read_bytes(), SOURCE)

    def test_untrusted_or_changed_revision_redirect_is_rejected(self):
        for target in ['https://outside.invalid/', CONTENTS.replace(REF, 'main')]:
            with self.subTest(target=target):
                with patch('requests.Session.get', return_value=response(301, headers={'location': target})) as get:
                    with self.assertRaisesRegex(ValueError, '无法验证的重定向'):
                        download_skill(self.client, URL, self.root)
                self.assertEqual(get.call_count, 1)

    def test_archive_paths_and_links_cannot_escape_staging(self):
        link = ZipInfo(f'repo-{REF}/skills/fixture-skill/link')
        link.create_system = 3
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        stream = io.BytesIO()
        with ZipFile(stream, 'w') as package:
            package.writestr(f'repo-{REF}/', '')
            package.writestr(link, '../../outside')
        for content in [archive({'../../outside': b'escape'}), stream.getvalue()]:
            with self.subTest(size=len(content)):
                with patch('requests.Session.get', side_effect=[self.quota(), response(200, content)]):
                    with self.assertRaises(ValueError):
                        download_skill(self.client, URL, self.root)
                self.assertFalse((self.root / 'fixture-skill').exists())
                self.assertFalse((self.root / 'outside').exists())

    def test_oversized_skill_and_invalid_frontmatter_do_not_publish(self):
        with patch('github_download.SKILL_LIMIT', 10):
            with patch('requests.Session.get', side_effect=[self.quota(), response(200, archive())]):
                with self.assertRaisesRegex(ValueError, '超过'):
                    download_skill(self.client, URL, self.root)
        with patch('requests.Session.get', side_effect=[self.quota(), response(200, archive({'SKILL.md': b'not frontmatter'}))]):
            with self.assertRaisesRegex(ValueError, 'invalid'):
                download_skill(self.client, URL, self.root)
        self.assertFalse((self.root / 'fixture-skill').exists())


if __name__ == '__main__':
    unittest.main()

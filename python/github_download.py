"""SkillNet 0.1.5 download transport fixes; retain its publication and validation."""

import stat
import tempfile
from concurrent.futures import ThreadPoolExecutor, wait
from pathlib import Path
from urllib.parse import parse_qs, quote, urljoin, urlsplit
from zipfile import BadZipFile, ZipFile

import requests
from skillnet_ai.downloader import GitHubAPIError, SkillDownloader


ARCHIVE_LIMIT = 64 * 1024 * 1024
SKILL_LIMIT = 20 * 1024 * 1024


def rate_limited(response):
    if response.status_code not in (403, 429):
        return False
    if response.headers.get('x-ratelimit-remaining') == '0' or response.headers.get('retry-after'):
        return True
    try:
        message = response.json().get('message', '').lower()
    except (ValueError, AttributeError):
        return False
    return 'rate limit' in message


def request_failure(response):
    if response is None:
        return 'GitHub 读取超时或连接失败，请稍后重试。'
    if rate_limited(response):
        return 'GitHub API 暂时限流，未能读取技能包，请稍后重试。'
    status = response.status_code
    if status == 404:
        return '技能来源的路径或版本不存在（404）；私有仓库请检查访问权限。'
    if status in (401, 403):
        return f'GitHub 拒绝读取技能包（{status}），响应未表明是请求额度耗尽。'
    return f'GitHub 读取技能包失败（{status}），请稍后重试。'


class GitHubDownloader(SkillDownloader):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.last_response = None
        self.archive_files = {}

    def _request_with_retry(self, url, *args, **kwargs):
        original = urlsplit(url)
        for _ in range(4):
            response = super()._request_with_retry(url, *args, **kwargs)
            self.last_response = response
            if response is None or response.status_code not in (301, 302, 307, 308):
                return response
            target = urljoin(url, response.headers.get('location', ''))
            parsed = urlsplit(target)
            # SDK authentication stays on api.github.com; redirects must also
            # preserve the requested ref rather than selecting a new version.
            if (not response.headers.get('location') or parsed.scheme != 'https'
                    or parsed.netloc != original.netloc
                    or parsed.username or parsed.password or parsed.fragment
                    or parse_qs(parsed.query).get('ref') != parse_qs(original.query).get('ref')):
                raise ValueError('GitHub 返回了无法验证的重定向，已停止读取。')
            response.close()
            url = target
        raise ValueError('GitHub 重定向次数过多，已停止读取。')

    def _get_file_tree(self, owner, repo, ref, dir_path):
        try:
            return super()._get_file_tree(owner, repo, ref, dir_path)
        except GitHubAPIError:
            response = self.last_response
            # Only a confirmed anonymous API rate limit uses public codeload.
            # Authentication failures and missing revisions keep their errors.
            if response is not None and rate_limited(response) and not self.api_token:
                try:
                    return self._archive_tree(owner, repo, ref, dir_path)
                except requests.RequestException:
                    raise ValueError('GitHub API 暂时限流，官方归档也无法连接，请稍后重试。') from None
                except BadZipFile:
                    raise ValueError('GitHub API 暂时限流，官方归档内容无效，请稍后重试。') from None
                except ValueError as error:
                    raise ValueError('GitHub API 暂时限流；官方归档读取也未完成：' + str(error)) from None
            raise ValueError(request_failure(response)) from None

    def _archive_tree(self, owner, repo, ref, dir_path):
        url = (f'https://codeload.github.com/{quote(owner, safe="")}/'
               f'{quote(repo, safe="")}/zip/{quote(ref, safe="")}')
        # An explicit no-op auth handler prevents ambient .netrc credentials
        # from being attached to this anonymous, non-redirecting public request.
        with self.session.get(url, headers={'Accept': 'application/zip'}, auth=lambda request: request,
                              timeout=(10, 30), allow_redirects=False, stream=True) as response:
            if response.status_code != 200:
                raise ValueError(f'同一版本的官方归档不可读取（{response.status_code}）。')
            with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024) as stream:
                size = 0
                for chunk in response.iter_content(64 * 1024):
                    size += len(chunk)
                    if size > ARCHIVE_LIMIT:
                        raise ValueError('仓库归档超过 64 MiB，未解包或安装。')
                    stream.write(chunk)
                stream.seek(0)
                with ZipFile(stream) as archive:
                    members = archive.infolist()
                    if not members or len(members) > 100_000:
                        raise ValueError('仓库归档的文件列表无效或过大。')
                    root = members[0].filename.split('/')[0]
                    prefix = root + '/' + (dir_path.rstrip('/') + '/' if dir_path else '')
                    files, selected, total = [], {}, 0
                    for member in members:
                        if member.is_dir() or not member.filename.startswith(prefix):
                            continue
                        relative = member.filename[len(prefix):]
                        path = f'{dir_path}/{relative}' if dir_path else relative
                        self._relative_file(path, dir_path)
                        mode = stat.S_IFMT(member.external_attr >> 16)
                        if mode not in (0, stat.S_IFREG):
                            raise ValueError('技能归档包含不支持的链接或特殊文件。')
                        total += member.file_size
                        if total > SKILL_LIMIT:
                            raise ValueError('技能归档超过 20 MiB，未解包或安装。')
                        selected[path] = archive.read(member)
                        files.append({'path': path})
                    if not files:
                        raise ValueError('该版本的归档中不存在所选技能目录。')
                    self.archive_files.update(selected)
                    return files

    def _download_single_file(self, owner, repo, ref, dir_path, file_info, folder_name, target_dir):
        path = file_info['path']
        if path in self.archive_files:
            relative = self._relative_file(path, dir_path)
            destination = Path(target_dir) / folder_name / str(relative)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(self.archive_files[path])
            return True
        downloaded = super()._download_single_file(owner, repo, ref, dir_path, file_info, folder_name, target_dir)
        if not downloaded:
            raise ValueError(request_failure(self.last_response))
        return True


def download_skill(client, url, target_dir):
    downloader = GitHubDownloader(api_token=client.github_token, mirror_url=client.settings.github_mirror)
    try:
        return downloader.download(url, target_dir=target_dir, require_skill=True)
    finally:
        downloader.session.close()


def check_sources(client, urls):
    """Check the original revision without downloading or validating full packages."""
    if not isinstance(urls, list) or len(urls) > 100 or any(not isinstance(url, str) for url in urls):
        raise ValueError('技能来源列表无效。')
    urls = list(dict.fromkeys(urls))
    if not urls:
        return []

    def check(url):
        downloader = GitHubDownloader(api_token=client.github_token)
        # Suppress ambient .netrc credentials on public raw requests. Explicit
        # GitHub credentials below stay on the API host, as in the downloader.
        downloader.session.auth = lambda request: request
        try:
            try:
                owner, repo, ref, directory, _ = downloader._parse_github_url(url)
            except ValueError:
                return 'missing'
            file = f'{directory}/SKILL.md' if directory else 'SKILL.md'
            headers = {'Accept': 'application/vnd.github+json'}
            if client.github_token:
                headers['Authorization'] = f'Bearer {client.github_token}'
            else:
                raw = (f'https://raw.githubusercontent.com/{quote(owner, safe="")}/'
                       f'{quote(repo, safe="")}/{quote(ref, safe="")}/{quote(file, safe="/")}')
                with downloader.session.get(raw, timeout=(2, 3), allow_redirects=False, stream=True) as response:
                    if response.status_code == 200:
                        return 'available'
                    if response.status_code not in (404, 410):
                        return 'unknown'
            # Confirm missing raw files against the actual contents API used by
            # downloads. A redirect or a transient/permission error stays unknown.
            api = downloader._contents_url(owner, repo, ref, file)
            with downloader.session.get(api, headers=headers, timeout=(2, 3),
                                        allow_redirects=False, stream=True) as response:
                if response.status_code == 200:
                    return 'available'
                return 'missing' if response.status_code in (404, 410) else 'unknown'
        except requests.RequestException:
            return 'unknown'
        finally:
            downloader.session.close()

    pool = ThreadPoolExecutor(max_workers=6)
    futures = {url: pool.submit(check, url) for url in urls}
    done, _ = wait(futures.values(), timeout=12)
    pool.shutdown(wait=False, cancel_futures=True)
    return [{'url': url, 'status': future.result() if future in done else 'unknown'}
            for url, future in futures.items()]

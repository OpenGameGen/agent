# Publish only after all three installer jobs succeed.
import hashlib, json, os, subprocess, zipfile
from pathlib import Path
repo = os.environ['GITHUB_REPOSITORY']
run_id = int(os.environ['GITHUB_RUN_ID'])
source = os.environ['GITHUB_SHA']
version = os.environ['PRODUCT_BUILD_VERSION']
tag = 'v' + version
def api(path):
    return json.loads(subprocess.check_output(['gh', 'api', path]))
run = api(f'repos/{repo}/actions/runs/{run_id}')
assert run['head_sha'] == source and run['head_branch'] == 'main'
jobs = api(f'repos/{repo}/actions/runs/{run_id}/jobs?filter=all&per_page=100')['jobs']
latest = {}
for job in sorted(jobs, key=lambda item: item['id']):
    latest[job['name']] = job
for target in ('mac-arm64', 'mac-x64', 'win-x64'):
    assert latest[f'Installer / {target}']['conclusion'] == 'success'
artifacts = api(f'repos/{repo}/actions/runs/{run_id}/artifacts')['artifacts']
out = Path(os.environ['RUNNER_TEMP']) / 'release-installers'; out.mkdir(exist_ok=True)
details = []
for target, platform, extension in [('mac-arm64', 'macOS-arm64', 'dmg'), ('mac-x64', 'macOS-x64', 'dmg'), ('win-x64', 'Windows-x64', 'exe')]:
    expected = f'opengamegen-{target}-unsigned-{version}-{source}'
    matches = [a for a in artifacts if a['name'] == expected]
    assert len(matches) == 1 and not matches[0]['expired']
    artifact = matches[0]
    archive = out / (target + '.zip')
    with archive.open('wb') as stream:
        subprocess.run(['gh', 'api', f'repos/{repo}/actions/artifacts/{artifact["id"]}/zip'], stdout=stream, check=True)
    digest = artifact.get('digest')
    if digest:
        assert digest == 'sha256:' + hashlib.file_digest(archive.open('rb'), 'sha256').hexdigest()
    asset = out / f'OpenGameGen-{platform}.{extension}'
    with zipfile.ZipFile(archive) as zipped:
        installers = [n for n in zipped.namelist() if n.lower().endswith('.' + extension)]
        assert len(installers) == 1
        with zipped.open(installers[0]) as inp, asset.open('wb') as dst:
            import shutil
            shutil.copyfileobj(inp, dst)
    assert asset.stat().st_size > 1000000
    with asset.open('rb') as stream:
        sha = hashlib.file_digest(stream, 'sha256').hexdigest()
    details.append({'name': asset.name, 'bytes': asset.stat().st_size, 'sha256': sha})
notes = '\n'.join([
    '# OpenGameGen 三平台预览版',
    '',
    '从下方 Assets 直接下载适合你电脑的安装包：',
    '- Apple Silicon Mac：macOS-arm64.dmg',
    '- Intel Mac：macOS-x64.dmg',
    '- Windows 64 位：Windows-x64.exe',
    '',
    '这些安装包未签名；macOS 未公证。版本仍为 alpha 预览版。',
    '本次已通过三个原生平台的 CI 打包及包内运行检查；尚未完成真实桌面安装交互验收。',
    '',
    f'构建来源：https://github.com/{repo}/actions/runs/{run_id}',
    f'源码提交：`{source}`',
    '',
    '## SHA-256',
    '',
    '```text',
    *[f'{d["sha256"]}  {d["name"]}' for d in details],
    '```',
])
Path('release-notes.md').write_text(notes)
existing = subprocess.run(['gh', 'release', 'view', tag, '--json', 'isDraft'], capture_output=True, text=True)
if existing.returncode == 0:
    if not json.loads(existing.stdout)['isDraft']:
        published = api(f'repos/{repo}/releases/tags/{tag}')
        existing_assets = {a['name']: a for a in published['assets']}
        assert set(existing_assets) == {d['name'] for d in details}
        for d in details:
            assert existing_assets[d['name']]['size'] == d['bytes']
            assert existing_assets[d['name']]['digest'] == 'sha256:' + d['sha256']
        print(published['html_url'])
        raise SystemExit(0)
else:
    subprocess.run(['gh', 'release', 'create', tag, '--target', source, '--title', 'OpenGameGen 三平台预览版', '--notes-file', 'release-notes.md', '--draft', '--prerelease'], check=True)
subprocess.run(['gh', 'release', 'upload', tag, *[str(out / d['name']) for d in details], '--clobber'], check=True)
release_ref = json.loads(subprocess.check_output(['gh', 'release', 'view', tag, '--json', 'apiUrl']))
release = api(release_ref['apiUrl'])
assert release['draft'] and release['prerelease']
actual = {a['name']: a for a in release['assets']}
assert set(actual) == {d['name'] for d in details}
for d in details:
    assert actual[d['name']]['size'] == d['bytes']
    assert actual[d['name']]['digest'] == 'sha256:' + d['sha256']
subprocess.run(['gh', 'release', 'edit', tag, '--draft=false', '--prerelease', '--notes-file', 'release-notes.md'], check=True)
release = api(f'repos/{repo}/releases/tags/{tag}')
assert not release['draft'] and len(release['assets']) == 3
print(release['html_url'])
with open(os.environ['GITHUB_STEP_SUMMARY'], 'a') as stream:
    stream.write(notes + '\n\nRelease: ' + release['html_url'] + '\n')

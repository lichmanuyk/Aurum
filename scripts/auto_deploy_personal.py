"""Fast-forward the isolated personal checkout and redeploy the existing Docker project."""
import argparse
import base64
import fcntl
import os
import subprocess
import sys
import time
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
ENV = ROOT / '.env.personal'
COMPOSE = ['docker', 'compose', '--env-file', str(ENV), '-p', 'aurum-personal']


def run(*args, capture=False):
    result = subprocess.run(args, cwd=ROOT, check=True, text=True,
                            stdout=subprocess.PIPE if capture else None)
    return result.stdout.strip() if capture else None


def settings():
    return dict(line.split('=', 1) for line in ENV.read_text().splitlines()
                if '=' in line and not line.lstrip().startswith('#'))


def health():
    config = settings()
    credentials = base64.b64encode(
        (config['AURUM_BASIC_AUTH_USER'] + ':' + config['AURUM_BASIC_AUTH_PASSWORD']).encode()
    ).decode()
    request = Request('http://127.0.0.1:' + config['AURUM_WEB_PORT'] + '/api/health',
                      headers={'Authorization': 'Basic ' + credentials})
    for _ in range(30):
        try:
            with urlopen(request, timeout=5) as response:
                if response.status == 200:
                    return
        except Exception:
            time.sleep(2)
    raise RuntimeError('Personal app did not become healthy after deployment')


def deploy(force=False):
    if not ENV.is_symlink() or ENV.resolve() != (ROOT.parent / 'personal.env').resolve():
        raise RuntimeError('Deployment .env.personal must link to the protected personal configuration')
    config = settings()
    if (config.get('AURUM_WEB_PORT'), config.get('AURUM_POSTGRES_DB'), config.get('AURUM_BIND_ADDRESS')) != ('3003', 'aurum_personal', '127.0.0.1'):
        raise RuntimeError('Personal deployment config must use port 3003 and the aurum_personal database')
    if Path(run('git', 'rev-parse', '--show-toplevel', capture=True)) != ROOT:
        raise RuntimeError('Run only from the isolated personal worktree')
    run('git', 'fetch', '--quiet', 'origin', 'personal')
    current = run('git', 'rev-parse', 'HEAD', capture=True)
    target = run('git', 'rev-parse', 'FETCH_HEAD', capture=True)
    if current == target and not force:
        print('Personal deployment is current:', current[:12], flush=True)
        return
    failed = ROOT.parent / 'failed-target'
    if not force and failed.exists() and failed.read_text().strip() == target:
        print('Skipping previously failed commit:', target[:12], flush=True)
        return
    if run('git', 'status', '--porcelain', capture=True):
        raise RuntimeError('Deployment worktree has local changes')
    if subprocess.run(['git', 'merge-base', '--is-ancestor', current, target], cwd=ROOT).returncode:
        raise RuntimeError('personal did not fast-forward; refusing to replace deployed code')
    # The backup is taken from the currently running app before migrations or restarts.
    run(sys.executable, str(ROOT / 'scripts/backup_personal.py'))
    if current != target:
        run('git', 'switch', '--detach', target)
    try:
        run(*COMPOSE, 'up', '-d', '--build', '--wait', '--wait-timeout', '180')
        health()
    except Exception:
        if current != target:
            print('Deployment failed; rebuilding previous code', file=sys.stderr, flush=True)
            try:
                run('git', 'switch', '--detach', current)
                run(*COMPOSE, 'up', '-d', '--build', '--wait', '--wait-timeout', '180')
                health()
            finally:
                failed.write_text(target + '\n')
                subprocess.run(['/usr/bin/osascript', '-e',
                                'display notification "Auto-deploy failed; check Aurum logs" with title "Aurum"'],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        raise
    failed.unlink(missing_ok=True)
    print('Personal deployment updated:', current[:12], '->', target[:12], flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--force', action='store_true', help='rebuild even when the checkout is current')
    args = parser.parse_args()
    os.umask(0o077)
    lock = ROOT.parent / 'auto-deploy.lock'
    with lock.open('a') as file:
        try:
            fcntl.flock(file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another personal deployment is running', flush=True)
            return
        deploy(args.force)


if __name__ == '__main__':
    main()

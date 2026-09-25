"""Install a local launchd poller for the protected personal branch."""
import os
import plistlib
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKTREE = ROOT / '.deploy/personal'
LABEL = 'com.aurum.personal-auto-deploy'


def main():
    if sys.platform != 'darwin':
        raise RuntimeError('This installer is for the macOS host')
    if not (ROOT / '.env.personal').is_file():
        raise RuntimeError('The existing .env.personal is required')
    if not WORKTREE.exists():
        WORKTREE.parent.mkdir(mode=0o700, exist_ok=True)
        subprocess.run(['git', 'worktree', 'add', '--detach', str(WORKTREE), 'origin/personal'],
                       cwd=ROOT, check=True)
    if not (WORKTREE / 'scripts/auto_deploy_personal.py').is_file():
        raise RuntimeError('Update origin/personal before installing auto-deploy')
    config_link = WORKTREE / '.env.personal'
    if not config_link.exists():
        config_link.symlink_to(ROOT / '.env.personal')
    if config_link.resolve() != (ROOT / '.env.personal').resolve():
        raise RuntimeError('Deployment config points to another file')

    # First deployment catches the currently running instance up to personal.
    subprocess.run([sys.executable, str(WORKTREE / 'scripts/auto_deploy_personal.py'), '--force'], check=True)

    logs = Path.home() / 'Library/Logs/Aurum'
    logs.mkdir(parents=True, exist_ok=True)
    agents = Path.home() / 'Library/LaunchAgents'
    agents.mkdir(parents=True, exist_ok=True)
    plist = agents / (LABEL + '.plist')
    values = {
        'Label': LABEL,
        'ProgramArguments': [sys.executable, str(WORKTREE / 'scripts/auto_deploy_personal.py')],
        'EnvironmentVariables': {
            'PATH': '/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin',
            'GIT_TERMINAL_PROMPT': '0',
        },
        'RunAtLoad': True,
        'StartInterval': 300,
        'StandardOutPath': str(logs / 'auto-deploy.out.log'),
        'StandardErrorPath': str(logs / 'auto-deploy.err.log'),
    }
    with plist.open('wb') as file:
        plistlib.dump(values, file)
    domain = 'gui/' + str(os.getuid())
    subprocess.run(['launchctl', 'bootout', domain, str(plist)], stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL)
    subprocess.run(['launchctl', 'bootstrap', domain, str(plist)], check=True)
    print('Installed', LABEL, 'for personal; checks every 5 minutes while this Mac is on')


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""Audit and replace the app on an explicitly selected local simulator."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys
import time


BUNDLE = 'app.uniclipboard.harmony'
PROJECT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('target', help='local hdc simulator target, for example 127.0.0.1:5555')
    parser.add_argument('--hap', type=Path, default=PROJECT / 'entry/build/default/outputs/default/entry-default-release-emulator-signed.hap')
    args = parser.parse_args()
    match = re.fullmatch(r'127\.0\.0\.1:(\d{1,5})', args.target)
    if match is None or not 1 <= int(match.group(1)) <= 65535:
        parser.error('a local simulator target is required; this helper does not install test signatures on physical devices')
    contents = Path(os.environ.get('DEVECO_STUDIO_CONTENTS', '/Applications/DevEco-Studio.app/Contents'))
    hdc = contents / 'sdk/default/openharmony/toolchains/hdc'
    if not hdc.is_file():
        parser.error(f'hdc is unavailable: {hdc}')
    hap = args.hap.resolve()
    subprocess.run([sys.executable, str(PROJECT / 'scripts/audit-hap.py'), str(hap)], check=True)
    targets = subprocess.run([str(hdc), 'list', 'targets'], check=True, capture_output=True, text=True).stdout.splitlines()
    if args.target not in [target.strip() for target in targets]:
        parser.error('the selected simulator is not connected')

    def run(*command):
        result = subprocess.run([str(hdc), '-t', args.target, *command], check=True, capture_output=True, text=True, timeout=60)
        return result.stdout.strip()

    stopped = run('shell', 'aa', 'force-stop', BUNDLE)
    for _ in range(10):
        if not run('shell', 'pidof', BUNDLE):
            break
        time.sleep(0.2)
    else:
        raise SystemExit(f'App is still running; the native library was not replaced. Stop result: {stopped}')
    installed = run('install', '-r', str(hap))
    if 'install bundle successfully' not in installed.lower():
        raise SystemExit(f'Installation failed: {installed}')
    started = run('shell', 'aa', 'start', '-b', BUNDLE, '-a', 'EntryAbility')
    if 'start ability successfully' not in started:
        raise SystemExit(f'App start failed: {started}')
    time.sleep(2)
    pid = run('shell', 'pidof', BUNDLE)
    if not pid or not all(value.isdigit() for value in pid.split()):
        raise SystemExit('No app process after launch; inspect the simulator crash log')
    print(f'Installed on {args.target}; app process started (PID {pid}). Verify readiness in the app.')


if __name__ == '__main__':
    main()

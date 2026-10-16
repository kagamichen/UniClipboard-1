#!/usr/bin/env python3
"""Prepare a verified release HAR or an explicitly imported local build."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import tarfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
DECLARATIONS = 'package/src/main/cpp/types/libuc_ohos_napi/index.d.ts'
NATIVE = 'package/libs/arm64-v8a/libuc_ohos_napi.so'


def verify(data, lock):
    if len(data) != lock['size'] or hashlib.sha256(data).hexdigest() != lock['sha256']:
        raise ValueError('Engine artifact size or SHA-256 mismatch')


def member_bytes(archive, name):
    member = archive.getmember(name)
    if not member.isfile():
        raise ValueError('HAR member must be a regular file')
    return archive.extractfile(member).read()


def validate_archive(data, lock):
    verify(data, lock)
    with tarfile.open(fileobj=io.BytesIO(data)) as archive:
        package = json.loads(member_bytes(archive, 'package/oh-package.json5'))
        member_bytes(archive, 'package/Index.d.ets')
        if package['name'] != '@uniclipboard/engine' or 'v' + package['version'] != lock['release']:
            raise ValueError('Engine package name or version mismatch')
        if package['compatibleSdkVersion'] != lock['minimumApi']:
            raise ValueError('Engine minimum SDK mismatch')
        declarations = member_bytes(archive, DECLARATIONS)
        native = member_bytes(archive, NATIVE)
    if lock.get('development'):
        if lock.get('schemaVersion') != 1 or lock.get('sourceState') not in ['clean', 'modified']:
            raise ValueError('Invalid development build provenance')
        if not re.fullmatch(r'[0-9a-f]{40}', lock.get('commit', '')) or not re.fullmatch(r'[0-9a-f]{64}', lock.get('sourceFingerprint', '')):
            raise ValueError('Development build requires source identity')
        if lock.get('sdkApi', 0) < lock['minimumApi']:
            raise ValueError('Development build SDK is too old')
        if hashlib.sha256(declarations).hexdigest() != lock.get('declarationsSha256'):
            raise ValueError('Development declarations checksum mismatch')
        if hashlib.sha256(native).hexdigest() != lock.get('nativeSha256'):
            raise ValueError('Development native library checksum mismatch')
    return declarations


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.download')
    temporary.write_bytes(data)
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser()
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('--local-har', type=Path, help='Import a HAR with its sibling .build.json from the Engine build')
    modes.add_argument('--release', action='store_true', help='Restore the pinned official release')
    args = parser.parse_args()
    local_lock = ROOT / 'engine-lock.local.json'
    release_lock = json.loads((ROOT / 'engine-lock.json').read_text())
    target = ROOT / 'libs' / release_lock['artifact']
    if args.local_har:
        lock = json.loads(args.local_har.with_suffix('.build.json').read_text())
        if lock.get('development') is not True or lock['artifact'] != release_lock['artifact']:
            raise ValueError('Local import requires an Engine development manifest')
        if lock['minimumApi'] != release_lock['minimumApi']:
            raise ValueError('Update and verify the product SDK baseline before importing this HAR')
        data = args.local_har.read_bytes()
    else:
        lock = json.loads(local_lock.read_text()) if local_lock.exists() and not args.release else release_lock
        data = target.read_bytes() if target.exists() else None
        if args.release or data is None:
            if lock.get('development'):
                raise ValueError('Local HAR is missing; rebuild and import it again')
            url = f"https://github.com/UniClipboard/Engine/releases/download/{lock['release']}/{lock['artifact']}"
            with urllib.request.urlopen(url, timeout=120) as response:
                data = response.read(lock['size'] + 1)
    declarations = validate_archive(data, lock)
    atomic_write(target, data)
    atomic_write(ROOT / 'entry/src/main/cpp/types/libuc_ohos_napi/index.d.ts', declarations)
    if args.local_har:
        atomic_write(local_lock, (json.dumps(lock, indent=2) + '\n').encode())
    elif args.release:
        local_lock.unlink(missing_ok=True)
    mode = 'local development build' if lock.get('development') else 'official release'
    print(f"Engine {lock['release']} ({mode}): artifact and declarations verified")


if __name__ == '__main__':
    main()

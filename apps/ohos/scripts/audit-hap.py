#!/usr/bin/env python3
"""Audit a UniClipboard HAP before device installation or release handoff."""
import argparse
import hashlib
import json
from pathlib import Path
import struct
import zipfile


BUNDLE_NAME = 'app.uniclipboard.harmony'
REQUIRED_PERMISSIONS = {
    'ohos.permission.INTERNET',
    'ohos.permission.GET_NETWORK_INFO',
    'ohos.permission.READ_PASTEBOARD',
}
REQUIRED_ENTRIES = {
    'module.json',
    'resources.index',
    'ets/modules.abc',
    'libs/arm64-v8a/libuc_ohos_napi.so',
}


def fail(message):
    raise SystemExit(f'HAP audit failed: {message}')


def audit(path: Path, allow_debug: bool = False) -> dict:
    if not path.is_file():
        fail(f'file does not exist: {path}')
    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        missing = REQUIRED_ENTRIES - names
        if missing:
            fail(f'missing entries: {sorted(missing)}')
        if any(name.endswith(('.p12', '.pfx', '.pem', '.key')) for name in names):
            fail('private signing material is present in the HAP')
        try:
            module = json.loads(archive.read('module.json'))
        except (OSError, ValueError, KeyError) as error:
            fail(f'invalid module.json: {error}')
        app = module.get('app', {})
        entry = module.get('module', {})
        if app.get('bundleName') != BUNDLE_NAME:
            fail(f'unexpected bundle name: {app.get("bundleName")!r}')
        if entry.get('mainElement') != 'EntryAbility':
            fail('EntryAbility is not the main element')
        permissions = {item.get('name') for item in entry.get('requestPermissions', [])}
        if not REQUIRED_PERMISSIONS <= permissions:
            fail(f'missing permissions: {sorted(REQUIRED_PERMISSIONS - permissions)}')
        unexpected_permissions = permissions - REQUIRED_PERMISSIONS
        if unexpected_permissions:
            fail(f'unexpected permissions: {sorted(map(str, unexpected_permissions))}')
        if type(app.get('debug')) is not bool:
            fail('debug flag must be an explicit boolean')
        if not allow_debug and app.get('debug') is True:
            fail('debug HAP is not a release artifact')
        if not allow_debug and any(name.endswith('.map') for name in names):
            fail('source maps are present in a release HAP')
        native = archive.read('libs/arm64-v8a/libuc_ohos_napi.so')
        if len(native) < 20 or native[:4] != b'\x7fELF' or native[4] != 2:
            fail('native library is not a 64-bit ELF')
        machine = struct.unpack_from('<H', native, 18)[0]
        if machine != 183:
            fail(f'native library is not AArch64 (machine={machine})')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return {
        'path': str(path),
        'sha256': digest,
        'size': path.stat().st_size,
        'debug': app['debug'],
        'bundleName': app.get('bundleName'),
        'versionName': app.get('versionName'),
        'versionCode': app.get('versionCode'),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('hap', type=Path)
    parser.add_argument('--allow-debug', action='store_true')
    args = parser.parse_args()
    print(json.dumps(audit(args.hap, args.allow_debug), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()

import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest
import zipfile


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('audit_hap', ROOT / 'scripts/audit-hap.py')
audit_hap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit_hap)


class HapAuditTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / 'fixture.hap'
        self.module = {
            'app': {'bundleName': audit_hap.BUNDLE_NAME, 'debug': False},
            'module': {
                'mainElement': 'EntryAbility',
                'requestPermissions': [
                    {'name': name} for name in sorted(audit_hap.REQUIRED_PERMISSIONS)
                ],
            },
        }

    def write_hap(self):
        native = bytearray(64)
        native[:6] = b'\x7fELF\x02\x01'
        struct.pack_into('<H', native, 18, 183)
        with zipfile.ZipFile(self.path, 'w') as archive:
            archive.writestr('module.json', json.dumps(self.module))
            archive.writestr('resources.index', b'synthetic resource index')
            archive.writestr('ets/modules.abc', b'synthetic bytecode')
            archive.writestr('libs/arm64-v8a/libuc_ohos_napi.so', native)

    def test_release_with_exact_permission_set_passes(self):
        self.write_hap()
        self.assertIs(audit_hap.audit(self.path)['debug'], False)

    def test_debug_requires_explicit_override(self):
        self.module['app']['debug'] = True
        self.write_hap()
        with self.assertRaisesRegex(SystemExit, 'debug HAP'):
            audit_hap.audit(self.path)
        self.assertIs(audit_hap.audit(self.path, allow_debug=True)['debug'], True)

    def test_missing_debug_does_not_prove_release(self):
        del self.module['app']['debug']
        self.write_hap()
        for allow_debug in (False, True):
            with self.subTest(allow_debug=allow_debug):
                with self.assertRaisesRegex(SystemExit, 'debug flag'):
                    audit_hap.audit(self.path, allow_debug)

    def test_malformed_debug_is_rejected_even_with_override(self):
        for value in (None, 0, 1, 'false', 'true', [], {}):
            self.module['app']['debug'] = value
            self.write_hap()
            for allow_debug in (False, True):
                with self.subTest(value=value, allow_debug=allow_debug):
                    with self.assertRaisesRegex(SystemExit, 'debug flag'):
                        audit_hap.audit(self.path, allow_debug)

    def test_added_permission_requires_audit_policy_update(self):
        self.module['module']['requestPermissions'].append({'name': 'ohos.permission.LOCATION'})
        self.write_hap()
        with self.assertRaisesRegex(SystemExit, 'unexpected permissions'):
            audit_hap.audit(self.path)

    def test_missing_permission_is_rejected(self):
        self.module['module']['requestPermissions'].pop()
        self.write_hap()
        with self.assertRaisesRegex(SystemExit, 'missing permissions'):
            audit_hap.audit(self.path)

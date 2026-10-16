import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prepare_engine', ROOT / 'scripts/prepare-engine.py')
prepare_engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_engine)


def artifact(declarations=b'export interface OhEngine {}', native=b'synthetic native', **metadata):
    package = {'name': '@uniclipboard/engine', 'version': '1.1.0-test', 'compatibleSdkVersion': 24}
    package.update(metadata)
    members = {
        'package/oh-package.json5': json.dumps(package).encode(),
        'package/Index.d.ets': b'export default engine',
        prepare_engine.DECLARATIONS: declarations,
        prepare_engine.NATIVE: native,
    }
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w:gz') as archive:
        for name, data in members.items():
            member = tarfile.TarInfo(name)
            member.size = len(data)
            archive.addfile(member, io.BytesIO(data))
    data = buffer.getvalue()
    lock = {
        'release': 'v1.1.0-test', 'artifact': 'UniClipboardEngine.har', 'minimumApi': 24,
        'size': len(data), 'sha256': hashlib.sha256(data).hexdigest(),
        'schemaVersion': 1, 'development': True, 'sourceState': 'modified',
        'commit': 'a' * 40, 'sourceFingerprint': 'b' * 64, 'sdkApi': 24,
        'declarationsSha256': hashlib.sha256(declarations).hexdigest(),
        'nativeSha256': hashlib.sha256(native).hexdigest(),
    }
    return data, lock


class ArtifactVerificationTests(unittest.TestCase):
    def test_modified_artifact_is_rejected(self):
        original = b'verified bytes'
        lock = {'size': len(original), 'sha256': hashlib.sha256(original).hexdigest()}
        prepare_engine.verify(original, lock)
        with self.assertRaises(ValueError):
            prepare_engine.verify(b'modified bytes', lock)

    def test_truncated_artifact_is_rejected(self):
        original = b'verified bytes'
        lock = {'size': len(original), 'sha256': hashlib.sha256(original).hexdigest()}
        with self.assertRaises(ValueError):
            prepare_engine.verify(original[:-1], lock)

    def test_valid_archive_returns_its_own_declarations(self):
        data, lock = artifact()
        self.assertEqual(prepare_engine.validate_archive(data, lock), b'export interface OhEngine {}')

    def test_wrong_package_identity_and_sdk_are_rejected(self):
        for metadata in [{'name': '@other/engine'}, {'version': '0.0.1'}, {'compatibleSdkVersion': 22}]:
            with self.subTest(metadata=metadata):
                data, lock = artifact(**metadata)
                with self.assertRaises(ValueError):
                    prepare_engine.validate_archive(data, lock)

    def test_invalid_provenance_and_inner_checksums_are_rejected(self):
        data, lock = artifact()
        for key, value in [('schemaVersion', 2), ('sourceState', 'unknown'), ('commit', 'bad'),
                           ('sourceFingerprint', 'bad'), ('sdkApi', 22),
                           ('declarationsSha256', '0' * 64), ('nativeSha256', '0' * 64)]:
            with self.subTest(key=key), self.assertRaises(ValueError):
                prepare_engine.validate_archive(data, {**lock, key: value})


class ImportWorkflowTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.patch_root = patch.object(prepare_engine, 'ROOT', self.root)
        self.patch_root.start()
        self.addCleanup(self.patch_root.stop)
        self.release, lock = artifact(native=b'synthetic release')
        self.release_lock = {key: lock[key] for key in ['release', 'artifact', 'minimumApi', 'size', 'sha256']}
        (self.root / 'engine-lock.json').write_text(json.dumps(self.release_lock))
        self.local, self.local_lock = artifact(declarations=b'export interface LocalEngine {}')
        self.source = self.root / 'build/UniClipboardEngine.har'
        self.source.parent.mkdir()
        self.source.write_bytes(self.local)
        self.source.with_suffix('.build.json').write_text(json.dumps(self.local_lock))
        self.target = self.root / 'libs/UniClipboardEngine.har'
        self.selected_lock = self.root / 'engine-lock.local.json'
        self.declarations = self.root / 'entry/src/main/cpp/types/libuc_ohos_napi/index.d.ts'

    def run_prepare(self, *args):
        with patch('sys.argv', ['prepare-engine.py', *map(str, args)]):
            prepare_engine.main()

    def test_import_and_subsequent_default_use_same_local_artifact(self):
        with patch.object(prepare_engine.urllib.request, 'urlopen') as fetch:
            self.run_prepare('--local-har', self.source)
            self.run_prepare()
            fetch.assert_not_called()
        self.assertEqual(self.target.read_bytes(), self.local)
        self.assertEqual(json.loads(self.selected_lock.read_text()), self.local_lock)
        self.assertEqual(self.declarations.read_bytes(), b'export interface LocalEngine {}')

    def test_failed_import_preserves_current_selection(self):
        self.run_prepare('--local-har', self.source)
        previous = [path.read_bytes() for path in [self.target, self.selected_lock, self.declarations]]
        self.source.write_bytes(b'corrupt')
        with self.assertRaises(ValueError):
            self.run_prepare('--local-har', self.source)
        self.assertEqual(previous, [path.read_bytes() for path in [self.target, self.selected_lock, self.declarations]])

    def test_import_cannot_change_product_sdk_baseline(self):
        data, lock = artifact(compatibleSdkVersion=25)
        lock.update(minimumApi=25, sdkApi=25)
        self.source.write_bytes(data)
        self.source.with_suffix('.build.json').write_text(json.dumps(lock))
        with self.assertRaisesRegex(ValueError, 'SDK baseline'):
            self.run_prepare('--local-har', self.source)
        self.assertFalse(self.target.exists())

    def test_missing_local_artifact_does_not_download_release(self):
        self.run_prepare('--local-har', self.source)
        self.target.unlink()
        with patch.object(prepare_engine.urllib.request, 'urlopen') as fetch:
            with self.assertRaisesRegex(ValueError, 'Local HAR is missing'):
                self.run_prepare()
            fetch.assert_not_called()

    def test_restore_release_replaces_artifact_types_and_lock(self):
        self.run_prepare('--local-har', self.source)
        with patch.object(prepare_engine.urllib.request, 'urlopen', return_value=io.BytesIO(self.release)):
            self.run_prepare('--release')
        self.assertFalse(self.selected_lock.exists())
        self.assertEqual(self.target.read_bytes(), self.release)
        self.assertEqual(self.declarations.read_bytes(), b'export interface OhEngine {}')

    def test_failed_release_restore_preserves_local_selection(self):
        self.run_prepare('--local-har', self.source)
        with patch.object(prepare_engine.urllib.request, 'urlopen', return_value=io.BytesIO(b'corrupt')):
            with self.assertRaises(ValueError):
                self.run_prepare('--release')
        self.assertEqual(self.target.read_bytes(), self.local)
        self.assertTrue(self.selected_lock.exists())

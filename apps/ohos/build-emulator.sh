#!/usr/bin/env bash
set -euo pipefail
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
deveco_contents="${DEVECO_STUDIO_CONTENTS:-/Applications/DevEco-Studio.app/Contents}"
sdk_root="${DEVECO_SDK_HOME:-$deveco_contents/sdk}"
python3 "$project_root/scripts/prepare-engine.py"
python3 - "$sdk_root" "$project_root" <<'PY'
import json, pathlib, sys
sdk = pathlib.Path(sys.argv[1]) / 'default/sdk-pkg.json'
if not sdk.is_file():
    raise SystemExit('DevEco SDK metadata unavailable; set DEVECO_SDK_HOME')
actual = int(json.loads(sdk.read_text())['data']['apiVersion'])
project = pathlib.Path(sys.argv[2])
lock = project / 'engine-lock.local.json'
if not lock.exists():
    lock = project / 'engine-lock.json'
required = json.loads(lock.read_text())['minimumApi']
if actual < required:
    raise SystemExit(f'Build blocked: Engine requires API {required}; installed SDK is API {actual}. Install the matching DevEco SDK.')
PY
export PATH="$deveco_contents/tools/node/bin:$PATH"
export DEVECO_SDK_HOME="$sdk_root"
printf 'sdk.dir=%s\n' "$sdk_root" > "$project_root/local.properties"
cd "$project_root"
"$deveco_contents/tools/ohpm/bin/ohpm" install --all
build_mode="${OHOS_BUILD_MODE:-debug}"
if [[ "$build_mode" != "debug" && "$build_mode" != "release" ]]; then
  echo "OHOS_BUILD_MODE must be debug or release" >&2
  exit 2
fi
"$deveco_contents/tools/hvigor/bin/hvigorw" --mode module -p product=default -p module=entry@default -p buildMode="$build_mode" assembleHap --no-daemon
printf 'Unsigned HAP: %s\n' "$project_root/entry/build/default/outputs/default/entry-default-unsigned.hap"

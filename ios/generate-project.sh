#!/bin/sh
set -eu

xcodegen generate

python3 - <<'PY'
from pathlib import Path

project = Path('EnveFamily.xcodeproj/project.pbxproj')
contents = project.read_text()
old = 'SystemCapabilities = "[\\"com.apple.ApplicationGroups.iOS\\": [\\"enabled\\": 1]]";'
new = 'SystemCapabilities = { com.apple.ApplicationGroups.iOS = { enabled = 1; }; };'
if old in contents:
    if contents.count(old) != 2:
        raise SystemExit('Expected App Groups on both iOS targets.')
    project.write_text(contents.replace(old, new))
elif contents.count(new) != 2:
    raise SystemExit('App Groups capability is missing from the generated project.')
PY

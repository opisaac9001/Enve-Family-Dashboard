#!/bin/sh
set -eu

app_path=${1:?Pass the built EnveFamily.app path.}
extension_path="$app_path/PlugIns/EnveFamilyShare.appex"
group_id=$(/usr/libexec/PlistBuddy -c 'Print :EnveAppGroup' "$app_path/Info.plist")
case "$group_id" in
  group.[A-Za-z0-9.-]*) ;;
  *) echo 'The built app has no valid EnveAppGroup.' >&2; exit 1 ;;
esac

entitlements=$(mktemp /tmp/enve-family-entitlements.XXXXXX)
trap 'rm -f "$entitlements"' EXIT HUP INT TERM
cat > "$entitlements" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>com.apple.security.application-groups</key><array><string>$group_id</string></array>
</dict></plist>
EOF

codesign --force --sign - --entitlements "$entitlements" "$extension_path"
codesign --force --sign - --entitlements "$entitlements" "$app_path"

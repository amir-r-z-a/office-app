#!/bin/bash
# Makes the self-signed certificate the release workflow signs the Mac app with.
#
# Why: macOS remembers permissions (microphone, screen and system audio recording) per code
# signature. Without a signature that stays the same, every update looks like a new app and
# macOS asks again. A self-signed certificate is free and keeps the signature the same across
# updates. (macOS still says the app is from an unidentified developer the first time it opens.)
#
# Run it once on your Mac:   bash scripts/make-mac-signing-cert.sh
# Then add the two values it prints as repository secrets on GitHub.
set -euo pipefail

NAME="Office Self-Signed"
OUT="$HOME/office-signing"
mkdir -p "$OUT"
cd "$OUT"

if [ -f office-signing.p12 ]; then
  echo "A certificate already exists in $OUT. Delete that folder first if you really want a new one."
  echo "(A new certificate means everyone grants permissions once more.)"
  exit 1
fi

PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)

cat > cert.cnf <<CNF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = $NAME
[ext]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF

# macOS's own openssl (LibreSSL) writes a .p12 that the macOS keychain can import.
/usr/bin/openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -config cert.cnf -keyout key.pem -out cert.pem 2>/dev/null
/usr/bin/openssl pkcs12 -export -inkey key.pem -in cert.pem -name "$NAME" -out office-signing.p12 -passout "pass:$PASSWORD"
rm -f key.pem cert.cnf
echo "$PASSWORD" > password.txt
chmod 600 office-signing.p12 password.txt

base64 -i office-signing.p12 | tr -d '\n' > office-signing.p12.base64
pbcopy < office-signing.p12.base64 2>/dev/null && COPIED=" (already copied to your clipboard)" || COPIED=""

cat <<MSG

Done. Your certificate is in $OUT. Keep that folder private.

Now add two secrets on GitHub:
  https://github.com/amir-r-z-a/office-app/settings/secrets/actions  ->  New repository secret

  1. Name:  MAC_CERT_P12
     Value: the contents of $OUT/office-signing.p12.base64$COPIED

  2. Name:  MAC_CERT_PASSWORD
     Value: $PASSWORD

The next release is signed with it. After installing that release, grant permissions once more;
from then on updates keep them.
MSG

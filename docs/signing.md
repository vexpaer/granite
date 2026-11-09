# Android signing

Version tags build signed APKs using four GitHub Actions Secrets:
`ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`,
and `ANDROID_KEY_PASSWORD`. Keystore files and passwords are never committed.

This workspace keeps its release identity under the ignored `private/signing`
directory. Keep that directory in a secure personal backup: future Android
updates must use the same signing identity. The password recovery file is
Windows DPAPI protected and can be read only under the creating Windows user
profile; it is not a portable plaintext password file.

The project does not require Google Play or publish an AAB.

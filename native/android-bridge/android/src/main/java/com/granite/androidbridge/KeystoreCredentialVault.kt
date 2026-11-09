package com.granite.androidbridge

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class KeystoreCredentialVault(private val context: Context) {
    private val preferences = context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)
    private val keyAlias = "${context.packageName}.granite.credentials.v1"

    fun set(id: String, secret: String) {
        if (id.isBlank()) throw BridgeFailure("Credential id cannot be empty")
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey())
        val ciphertext = cipher.doFinal(secret.toByteArray(Charsets.UTF_8))
        val encoded = listOf(
            FORMAT_VERSION,
            cipher.iv.toBase64(),
            ciphertext.toBase64(),
        ).joinToString(":")
        if (!preferences.edit().putString(storageKey(id), encoded).commit()) {
            throw BridgeFailure("Android could not persist the credential")
        }
    }

    fun delete(id: String): Boolean {
        if (id.isBlank()) throw BridgeFailure("Credential id cannot be empty")
        if (!preferences.edit().remove(storageKey(id)).commit()) {
            throw BridgeFailure("Android could not delete the credential")
        }
        return true
    }

    fun resolve(id: String): String {
        if (id.isBlank()) throw BridgeFailure("Credential id cannot be empty")
        val encoded = preferences.getString(storageKey(id), null)
            ?: throw BridgeFailure("Credential is unavailable")
        val parsed = parse(encoded)
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE,
            getExistingKey(),
            GCMParameterSpec(GCM_TAG_BITS, parsed.iv),
        )
        val plaintext = cipher.doFinal(parsed.ciphertext)
        return try {
            String(plaintext, Charsets.UTF_8)
        } finally {
            plaintext.fill(0)
        }
    }

    private fun storageKey(id: String): String = "credential:${stableKey(id)}"

    private fun parse(encoded: String): ParsedCredentials {
        val parts = encoded.split(':')
        if (parts.size != 3 || parts[0] != FORMAT_VERSION) {
            throw BridgeFailure("Stored credential data is corrupt")
        }
        val iv = parts[1].base64Bytes()
        val ciphertext = parts[2].base64Bytes()
        if (iv.size != GCM_IV_BYTES || ciphertext.size < GCM_TAG_BYTES) {
            throw BridgeFailure("Stored credential data is corrupt")
        }
        return ParsedCredentials(iv, ciphertext)
    }

    private fun getOrCreateKey(): SecretKey {
        val keyStore = keyStore()
        val existing = keyStore.getKey(keyAlias, null)
        if (existing is SecretKey) return existing

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private fun getExistingKey(): SecretKey {
        val key = keyStore().getKey(keyAlias, null)
        return key as? SecretKey
            ?: throw BridgeFailure("Credential encryption key is unavailable")
    }

    private fun keyStore(): KeyStore {
        return KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    }

    companion object {
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val PREFERENCES_NAME = "granite.android-bridge.credentials"
        private const val FORMAT_VERSION = "v1"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
        private const val GCM_TAG_BYTES = GCM_TAG_BITS / 8
        private const val GCM_IV_BYTES = 12
    }
}

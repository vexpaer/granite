package com.granite.androidbridge

import android.content.Context
import android.net.Uri
import app.tauri.plugin.JSArray
import app.tauri.plugin.JSObject
import com.fasterxml.jackson.databind.JsonNode
import org.json.JSONObject
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.util.Base64

internal fun requiredString(node: JsonNode?, field: String): String {
    val value = node?.get(field)
    if (value == null || !value.isTextual || value.asText().isBlank()) {
        throw BridgeFailure("Missing required field: $field")
    }
    return value.asText()
}

internal fun optionalString(node: JsonNode?, field: String): String? {
    val value = node?.get(field) ?: return null
    if (value.isNull) return null
    if (!value.isTextual) throw BridgeFailure("Field $field must be a string")
    return value.asText()
}

internal fun requiredBoolean(node: JsonNode?, field: String): Boolean {
    val value = node?.get(field)
    if (value == null || !value.isBoolean) {
        throw BridgeFailure("Missing required boolean field: $field")
    }
    return value.asBoolean()
}

internal fun requiredLong(node: JsonNode?, field: String): Long {
    val value = node?.get(field)
    if (value == null || !value.isIntegralNumber || !value.canConvertToLong()) {
        throw BridgeFailure("Missing required integer field: $field")
    }
    return value.longValue()
}

internal fun requiredRoot(node: JsonNode?): JsonNode {
    val root = node?.get("root")
    if (root == null || !root.isObject) {
        throw BridgeFailure("Missing required library root")
    }
    return root
}

internal fun bytesFromNode(node: JsonNode?, field: String): ByteArray {
    return bytesFromJson(
        node?.get(field) ?: throw BridgeFailure("Missing required byte array: $field"),
        field,
    )
}

internal fun bytesFromJson(json: JsonNode, field: String): ByteArray {
    val value = json
    if (!value.isArray) throw BridgeFailure("Field $field must be a byte array")
    val bytes = ByteArray(value.size())
    for (index in 0 until value.size()) {
        val item = value[index]
        if (!item.isIntegralNumber) {
            throw BridgeFailure("Byte array contains a non-integer value")
        }
        val number = item.asInt()
        if (number !in 0..255) {
            throw BridgeFailure("Byte array value is outside 0..255")
        }
        bytes[index] = number.toByte()
    }
    return bytes
}

internal fun bytesToJsArray(bytes: ByteArray): JSArray {
    val array = JSArray()
    for (byte in bytes) {
        array.put(byte.toInt() and 0xff)
    }
    return array
}

internal fun sha256(bytes: ByteArray): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
    return digest.toHex()
}

internal fun ByteArray.toHex(): String {
    return joinToString(separator = "") { "%02x".format(it.toInt() and 0xff) }
}

internal fun ByteArray.toBase64(): String {
    return Base64.getEncoder().encodeToString(this)
}

internal fun String.base64Bytes(): ByteArray {
    return try {
        Base64.getDecoder().decode(this)
    } catch (exception: IllegalArgumentException) {
        throw BridgeFailure("Stored credential data is corrupt")
    }
}

internal fun stableKey(input: String): String {
    return MessageDigest.getInstance("SHA-256")
        .digest(input.toByteArray(StandardCharsets.UTF_8))
        .toHex()
}

internal fun JSObject.dynamicPut(field: String, value: Any?): JSObject {
    if (value is JSONObject) {
        put(field, value)
    } else {
        put(field, value)
    }
    return this
}

internal fun Context.openUriInputStream(uri: Uri): InputStream? {
    return if (uri.scheme == "file") {
        uri.path?.let { FileInputStream(File(it)) }
    } else {
        contentResolver.openInputStream(uri)
    }
}

internal fun Context.openUriOutputStream(uri: Uri, mode: String = "w"): OutputStream? {
    return if (uri.scheme == "file") {
        uri.path?.let { FileOutputStream(File(it), false) }
    } else {
        contentResolver.openOutputStream(uri, mode)
    }
}

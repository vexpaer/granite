package com.granite.androidbridge

import app.tauri.annotation.InvokeArg
import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.node.JsonNodeFactory

@InvokeArg
class HostCallRequest {
    lateinit var op: String
    var args: JsonNode = JsonNodeFactory.instance.objectNode()
}

@InvokeArg
class CredentialRequest {
    lateinit var id: String
    var secret: String? = null
}

@InvokeArg
class NotebookStateRequest {
    lateinit var state: JsonNode
}

class BridgeFailure(message: String) : Exception(message)

data class ScannedBook(
    val name: String,
    val relativePath: String,
    val size: Long,
    val format: String,
)

data class ImportedBook(
    val name: String,
    val relativePath: String,
    val sha256: String,
    val size: Long,
)

data class StoredShare(
    val id: String,
    val cacheFileName: String,
    val name: String,
    val size: Long,
    val sha256: String,
    val receivedAt: Long,
)

data class ParsedCredentials(
    val iv: ByteArray,
    val ciphertext: ByteArray,
)

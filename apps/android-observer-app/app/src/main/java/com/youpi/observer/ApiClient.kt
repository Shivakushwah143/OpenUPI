package com.youpi.observer

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKeys
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/** Why a pairing attempt failed. Strings are safe to show to the merchant. */
enum class PairFailureReason(val userMessage: String) {
    MISSING_INPUT("Enter the gateway URL and the enrollment token."),
    INVALID_TOKEN("Enrollment token is invalid, expired or already used. Generate a new pairing QR."),
    SERVER_ERROR("The gateway could not complete pairing. Try again shortly."),
    NETWORK("Cannot reach the gateway. Check the URL and the network connection."),
    BAD_RESPONSE("The gateway returned an incomplete pairing response.")
}

sealed class PairResult {
    data class Success(val deviceId: String, val receivingAccountId: String?) : PairResult()
    data class Failure(val reason: PairFailureReason) : PairResult()
}

class ApiClient(private val context: Context) {
    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    private val masterKeyAlias = MasterKeys.getOrCreate(MasterKeys.AES256_GCM_SPEC)
    private val prefs = EncryptedSharedPreferences.create(
        PREF_FILE,
        masterKeyAlias,
        context,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun isPaired(): Boolean {
        return !getDeviceId().isNullOrEmpty() && !getSigningKey().isNullOrEmpty()
    }

    fun getBaseUrl(): String {
        return prefs.getString(KEY_BASE_URL, DEFAULT_BASE_URL)?.takeIf { it.isNotBlank() } ?: DEFAULT_BASE_URL
    }

    /** Stable gateway-assigned device id, safe to display. Never the signing key. */
    fun getDeviceId(): String? {
        return prefs.getString(KEY_DEVICE_ID, null)?.trim()?.ifEmpty { null }
    }

    fun getReceivingAccountId(): String? {
        return prefs.getString(KEY_RECEIVING_ACCOUNT_ID, null)?.trim()?.ifEmpty { null }
    }

    /**
     * Redeems a single-use enrollment token.
     *
     * Security rules enforced here:
     *  - the token is only ever placed in the pairing request body: it is never
     *    persisted, logged, or echoed in an error;
     *  - the device id / signing key are only written after the gateway returns a
     *    complete response, in one synchronous commit;
     *  - failures expose a coarse reason, never a server body.
     */
    fun pair(baseUrl: String, enrollmentToken: String, deviceName: String): PairResult {
        val cleanUrl = baseUrl.trim().trimEnd('/')
        val token = enrollmentToken.trim()
        if (cleanUrl.isEmpty() || token.isEmpty()) {
            return PairResult.Failure(PairFailureReason.MISSING_INPUT)
        }

        val url = "$cleanUrl/api/v1/pollers/android/pair"
        val bodyJson = JSONObject().apply {
            put("enrollmentToken", token)
            put("deviceName", deviceName)
            put("deviceModel", android.os.Build.MODEL)
        }

        val request = Request.Builder()
            .url(url)
            .post(bodyJson.toString().toRequestBody(JSON_MEDIA_TYPE))
            .build()

        return try {
            client.newCall(request).execute().use { response ->
                if (response.code == 401 || response.code == 403) {
                    return PairResult.Failure(PairFailureReason.INVALID_TOKEN)
                }
                if (!response.isSuccessful) {
                    return PairResult.Failure(PairFailureReason.SERVER_ERROR)
                }

                val respBody = response.body?.string().orEmpty()
                val json = try {
                    JSONObject(respBody)
                } catch (e: Exception) {
                    return PairResult.Failure(PairFailureReason.BAD_RESPONSE)
                }

                if (!json.optBoolean("paired", false)) {
                    return PairResult.Failure(PairFailureReason.INVALID_TOKEN)
                }

                val deviceId = json.optNonBlank("deviceId")
                val signingKey = json.optNonBlank("signingKey")
                if (deviceId == null || signingKey == null) {
                    return PairResult.Failure(PairFailureReason.BAD_RESPONSE)
                }
                // The gateway pins the device to the receiving account whose QR
                // the merchant actually shows; JSON null is not a string.
                val receivingAccountId = json.optNonBlank("receivingAccountId")

                val editor = prefs.edit()
                    .putString(KEY_BASE_URL, cleanUrl)
                    .putString(KEY_DEVICE_ID, deviceId)
                    .putString(KEY_SIGNING_KEY, signingKey)
                if (receivingAccountId != null) {
                    editor.putString(KEY_RECEIVING_ACCOUNT_ID, receivingAccountId)
                } else {
                    editor.remove(KEY_RECEIVING_ACCOUNT_ID)
                }

                if (!editor.commit()) {
                    return PairResult.Failure(PairFailureReason.BAD_RESPONSE)
                }
                PairResult.Success(deviceId, receivingAccountId)
            }
        } catch (e: IOException) {
            logFailure("Pairing request", e)
            PairResult.Failure(PairFailureReason.NETWORK)
        } catch (e: Exception) {
            logFailure("Pairing request", e)
            PairResult.Failure(PairFailureReason.SERVER_ERROR)
        }
    }

    fun sendObservation(parsed: ParsedNotification): Boolean {
        if (!isPaired()) return false

        val deviceId = getDeviceId() ?: return false
        val signingKey = getSigningKey() ?: return false
        val baseUrl = getBaseUrl()

        val timestamp = System.currentTimeMillis().toString()
        val url = "$baseUrl/api/v1/pollers/android/events"

        val rawNotification = JSONObject().apply {
            put("title", parsed.rawTitle)
            put("text", parsed.rawText)
            put("package", parsed.packageName)
        }

        val bodyJson = JSONObject().apply {
            put("deviceId", deviceId)
            put("amountPaise", parsed.amountPaise)
            put("amount", parsed.amountRupees)
            put("observedAt", parsed.timestamp)
            put("bankReferenceNumber", parsed.bankReferenceNumber)
            put("senderVpa", parsed.senderVpa)
            put("rawNotification", rawNotification)
            val receivingAccountId = getReceivingAccountId()
            if (!receivingAccountId.isNullOrEmpty()) {
                put("receivingAccountId", receivingAccountId)
            }
        }

        val bodyString = bodyJson.toString()
        val sigPayload = "$bodyString:$timestamp"
        val signature = calculateHmac(sigPayload, signingKey)

        val request = Request.Builder()
            .url(url)
            .addHeader("X-Device-Id", deviceId)
            .addHeader("X-Timestamp", timestamp)
            .addHeader("X-Signature", signature)
            .post(bodyString.toRequestBody(JSON_MEDIA_TYPE))
            .build()

        return try {
            client.newCall(request).execute().use { res -> res.isSuccessful }
        } catch (e: Exception) {
            logFailure("Observation dispatch", e)
            false
        }
    }

    /**
     * Sends the signed liveness heartbeat (HMAC-SHA256 over "<rawBody>:<timestamp>").
     * Returns null when this phone is not paired, otherwise the coarse outcome so
     * the UI can distinguish "gateway rejects us" from "gateway unreachable".
     */
    fun sendHeartbeat(): HeartbeatOutcome? {
        if (!isPaired()) return null

        val deviceId = getDeviceId() ?: return null
        val signingKey = getSigningKey() ?: return null
        val baseUrl = getBaseUrl()
        val url = "$baseUrl/api/v1/pollers/android/heartbeat"

        val bodyJson = JSONObject().apply {
            put("deviceId", deviceId)
            put("timestamp", System.currentTimeMillis())
        }

        // Heartbeats are authenticated exactly like observations (audit P0-04):
        // HMAC-SHA256 over "<rawBody>:<timestamp>" inside a 60s window.
        val bodyString = bodyJson.toString()
        val timestamp = System.currentTimeMillis().toString()
        val signature = calculateHmac("$bodyString:$timestamp", signingKey)

        val request = Request.Builder()
            .url(url)
            .addHeader("X-Device-Id", deviceId)
            .addHeader("X-Timestamp", timestamp)
            .addHeader("X-Signature", signature)
            .post(bodyString.toRequestBody(JSON_MEDIA_TYPE))
            .build()

        return try {
            client.newCall(request).execute().use { res ->
                when {
                    res.isSuccessful -> HeartbeatOutcome.OK
                    res.code == 401 || res.code == 403 -> HeartbeatOutcome.UNAUTHORIZED
                    else -> HeartbeatOutcome.SERVER_ERROR
                }
            }
        } catch (e: IOException) {
            logFailure("Heartbeat", e)
            HeartbeatOutcome.NETWORK_ERROR
        } catch (e: Exception) {
            logFailure("Heartbeat", e)
            HeartbeatOutcome.SERVER_ERROR
        }
    }

    fun sendSms(sender: String, body: String, timestamp: Long): Boolean {
        if (!isPaired()) return false

        val deviceId = getDeviceId() ?: return false
        val signingKey = getSigningKey() ?: return false
        val baseUrl = getBaseUrl()

        val tsStr = timestamp.toString()
        val url = "$baseUrl/api/v1/observers/sms"

        val bodyJson = JSONObject().apply {
            put("deviceId", deviceId)
            put("sender", sender)
            put("body", body)
            put("timestamp", timestamp)
        }

        val bodyString = bodyJson.toString()
        val sigPayload = "$bodyString:$tsStr"
        val signature = calculateHmac(sigPayload, signingKey)

        val request = Request.Builder()
            .url(url)
            .addHeader("X-Device-Id", deviceId)
            .addHeader("X-Timestamp", tsStr)
            .addHeader("X-Signature", signature)
            .post(bodyString.toRequestBody(JSON_MEDIA_TYPE))
            .build()

        return try {
            client.newCall(request).execute().use { res -> res.isSuccessful }
        } catch (e: Exception) {
            logFailure("SMS dispatch", e)
            false
        }
    }

    private fun getSigningKey(): String? {
        return prefs.getString(KEY_SIGNING_KEY, null)?.trim()?.ifEmpty { null }
    }

    private fun calculateHmac(data: String, keyHex: String): String {
        val secret = SecretKeySpec(keyHex.toByteArray(Charsets.UTF_8), "HmacSHA256")
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(secret)
        val hmacData = mac.doFinal(data.toByteArray(Charsets.UTF_8))
        return hmacData.joinToString("") { "%02x".format(it) }
    }

    /**
     * Logs only the failure class. Request URLs, bodies, device ids and the
     * enrollment token are deliberately excluded.
     */
    private fun logFailure(action: String, e: Exception) {
        Log.w(TAG, "$action failed (${e.javaClass.simpleName})")
    }

    private fun JSONObject.optNonBlank(name: String): String? {
        if (!has(name) || isNull(name)) return null
        return optString(name).trim().ifEmpty { null }
    }

    companion object {
        private const val TAG = "YoupiApiClient"
        private const val PREF_FILE = "youpi_observer_secure_prefs"
        private const val KEY_BASE_URL = "base_url"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_SIGNING_KEY = "signing_key"
        private const val KEY_RECEIVING_ACCOUNT_ID = "receiving_account_id"
        private const val DEFAULT_BASE_URL = "http://10.0.2.2:6100"
        private val JSON_MEDIA_TYPE = "application/json".toMediaType()
    }
}

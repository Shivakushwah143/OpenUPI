package com.youpi.observer

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.service.notification.NotificationListenerService
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * Setup screen.
 *
 * Displays exactly one of NOT PAIRED / PAIRED / NOT LISTENING / ACTIVE / ERROR,
 * based on facts this phone can verify: persisted pairing state, the system's
 * notification-listener grant, and the most recent signed heartbeat outcome.
 *
 * The enrollment token is treated as a bearer credential: masked input, excluded
 * from autofill and instance-state saving, cleared from the field once redeemed,
 * and never persisted or logged.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var apiClient: ApiClient
    private lateinit var heartbeatScheduler: HeartbeatScheduler

    private lateinit var tvStatus: TextView
    private lateinit var tvStatusDetail: TextView
    private lateinit var tvDeviceId: TextView
    private lateinit var tvListenerStatus: TextView
    private lateinit var tvPermissionHelp: TextView
    private lateinit var tvSmsStatus: TextView
    private lateinit var tvNotificationStatus: TextView
    private lateinit var etBaseUrl: EditText
    private lateinit var etToken: EditText
    private lateinit var btnPair: Button
    private lateinit var btnPermission: Button
    private lateinit var btnRecheck: Button
    private lateinit var btnAppInfo: Button
    private lateinit var btnSms: Button
    private lateinit var btnNotifications: Button

    private val refreshHandler = Handler(Looper.getMainLooper())
    private val refreshTask = object : Runnable {
        override fun run() {
            renderStatus()
            refreshHandler.postDelayed(this, REFRESH_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        apiClient = ApiClient(this)
        heartbeatScheduler = HeartbeatScheduler(this)

        setContentView(buildLayout())
        renderStatus()
    }

    override fun onResume() {
        super.onResume()
        renderStatus()
        refreshHandler.post(refreshTask)
    }

    override fun onPause() {
        refreshHandler.removeCallbacks(refreshTask)
        super.onPause()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        renderStatus()
    }

    // ------------------------------------------------------------------ layout

    private fun buildLayout(): View {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
            // Nothing on this screen should be offered to an autofill service.
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }

        layout.addView(TextView(this).apply {
            text = "YOUPI Payment Observer"
            textSize = 22f
            setTypeface(null, Typeface.BOLD)
        })

        tvStatus = TextView(this).apply {
            text = "Status: Checking…"
            textSize = 18f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 24, 0, 8)
        }
        layout.addView(tvStatus)

        tvStatusDetail = TextView(this).apply {
            textSize = 13f
            setPadding(0, 0, 0, 8)
        }
        layout.addView(tvStatusDetail)

        tvDeviceId = TextView(this).apply {
            text = "Device ID: -"
            textSize = 12f
            setPadding(0, 0, 0, 16)
            setTextIsSelectable(true)
        }
        layout.addView(tvDeviceId)

        layout.addView(sectionTitle("Permissions"))

        tvListenerStatus = TextView(this).apply {
            textSize = 14f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 0, 0, 8)
        }
        layout.addView(tvListenerStatus)

        tvPermissionHelp = TextView(this).apply {
            textSize = 13f
            setPadding(0, 0, 0, 12)
        }
        layout.addView(tvPermissionHelp)

        btnPermission = Button(this).apply {
            setOnClickListener { openNotificationAccessSettings() }
        }
        layout.addView(btnPermission)

        btnRecheck = Button(this).apply {
            text = "Re-check Access"
            setOnClickListener {
                requestListenerRebind()
                renderStatus()
                Toast.makeText(this@MainActivity, "Access re-checked.", Toast.LENGTH_SHORT).show()
            }
        }
        layout.addView(btnRecheck)

        btnAppInfo = Button(this).apply {
            text = "Open App Info (Allow Restricted Settings)"
            setOnClickListener { openAppInfo() }
        }
        layout.addView(btnAppInfo)

        tvSmsStatus = TextView(this).apply {
            textSize = 13f
            setPadding(0, 16, 0, 4)
        }
        layout.addView(tvSmsStatus)

        btnSms = Button(this).apply {
            text = "Grant SMS Access"
            setOnClickListener {
                ActivityCompat.requestPermissions(
                    this@MainActivity,
                    arrayOf(Manifest.permission.RECEIVE_SMS),
                    REQUEST_SMS
                )
            }
        }
        layout.addView(btnSms)

        tvNotificationStatus = TextView(this).apply {
            textSize = 13f
            setPadding(0, 12, 0, 4)
        }
        layout.addView(tvNotificationStatus)

        btnNotifications = Button(this).apply {
            text = "Allow Notifications"
            setOnClickListener {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    ActivityCompat.requestPermissions(
                        this@MainActivity,
                        arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                        REQUEST_NOTIFICATIONS
                    )
                }
            }
        }
        layout.addView(btnNotifications)

        layout.addView(sectionTitle("Pairing"))

        layout.addView(TextView(this).apply {
            text = "Enrollment tokens are single-use and expire after 10 minutes. " +
                "The token is never stored on this phone."
            textSize = 12f
            setPadding(0, 0, 0, 8)
        })

        etBaseUrl = EditText(this).apply {
            hint = "Gateway URL (e.g. https://pay.example.com)"
            setText(apiClient.getBaseUrl())
            isSaveEnabled = true
        }
        layout.addView(etBaseUrl)

        etToken = EditText(this).apply {
            hint = "Enrollment token (single-use)"
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            // Never saved to the activity Bundle, autofill, or clipboard suggestions.
            isSaveEnabled = false
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            setSingleLine(true)
        }
        layout.addView(etToken)

        btnPair = Button(this).apply {
            text = PAIR_BUTTON_LABEL
            setOnClickListener { performPairing() }
        }
        layout.addView(btnPair)

        return ScrollView(this).apply {
            isFillViewport = true
            addView(layout)
        }
    }

    private fun sectionTitle(text: String): TextView {
        return TextView(this).apply {
            this.text = text
            textSize = 16f
            setTypeface(null, Typeface.BOLD)
            setPadding(0, 32, 0, 8)
        }
    }

    // ------------------------------------------------------------------ status

    private fun renderStatus() {
        if (isFinishing || isDestroyed) return

        val paired = apiClient.isPaired()
        val listenerGranted = hasNotificationListenerAccess()
        val smsGranted = hasPermission(Manifest.permission.RECEIVE_SMS)
        val status = ObserverStateResolver.resolve(
            paired = paired,
            listenerEnabled = listenerGranted,
            heartbeat = ObserverRuntime.lastHeartbeat
        )

        tvStatus.text = "Status: ${status.state.label}"
        tvStatus.setTextColor(colorFor(status.state))
        tvStatusDetail.text = status.detail + heartbeatSuffix(paired)

        val deviceId = apiClient.getDeviceId()
        tvDeviceId.text = "Device ID: ${deviceId ?: "-"}"
        tvDeviceId.visibility = if (paired) View.VISIBLE else View.GONE

        tvListenerStatus.text = "Notification access: ${if (listenerGranted) "GRANTED" else "NOT GRANTED"}"
        tvListenerStatus.setTextColor(if (listenerGranted) COLOR_OK else COLOR_ERROR)

        btnPermission.text = if (listenerGranted) {
            "✓ Notification Access Granted"
        } else {
            "Open Notification Access"
        }
        btnPermission.isEnabled = !listenerGranted

        // Android 13+ hides the notification-access toggle for apps installed from
        // an unknown source until the user allows restricted settings once. There
        // is no public API to detect or request that: present the exact steps.
        tvPermissionHelp.text = permissionInstructions(listenerGranted)
        tvPermissionHelp.visibility = if (listenerGranted) View.GONE else View.VISIBLE
        btnAppInfo.visibility = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !listenerGranted) {
            View.VISIBLE
        } else {
            View.GONE
        }

        tvSmsStatus.text = "SMS access (optional, bank SMS path): ${if (smsGranted) "GRANTED" else "NOT GRANTED"}"
        tvSmsStatus.setTextColor(if (smsGranted) COLOR_OK else COLOR_WARNING)
        btnSms.text = if (smsGranted) "✓ SMS Access Granted" else "Grant SMS Access"
        btnSms.isEnabled = !smsGranted

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            val notificationsGranted = hasPermission(Manifest.permission.POST_NOTIFICATIONS)
            tvNotificationStatus.visibility = View.VISIBLE
            btnNotifications.visibility = View.VISIBLE
            tvNotificationStatus.text =
                "Service notification: ${if (notificationsGranted) "GRANTED" else "NOT GRANTED"}"
            tvNotificationStatus.setTextColor(if (notificationsGranted) COLOR_OK else COLOR_WARNING)
            btnNotifications.text =
                if (notificationsGranted) "✓ Notifications Allowed" else "Allow Notifications"
            btnNotifications.isEnabled = !notificationsGranted
        } else {
            tvNotificationStatus.visibility = View.GONE
            btnNotifications.visibility = View.GONE
        }

        if (paired) {
            heartbeatScheduler.start()
        } else {
            heartbeatScheduler.stop()
            if (ObserverRuntime.lastHeartbeat != HeartbeatOutcome.PENDING) {
                ObserverRuntime.reset()
            }
        }
    }

    private fun heartbeatSuffix(paired: Boolean): String {
        if (!paired) return ""
        val at = ObserverRuntime.lastHeartbeatAtMillis
        if (at <= 0L) return ""
        val seconds = ((System.currentTimeMillis() - at) / 1000L).coerceAtLeast(0L)
        val ago = if (seconds < 90L) "${seconds}s ago" else "${seconds / 60L}m ago"
        return " Last heartbeat: $ago."
    }

    private fun permissionInstructions(listenerGranted: Boolean): String {
        if (listenerGranted) return ""
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            "Android 13+ blocks notification access for apps installed from a browser, chat app " +
                "or file manager. To allow it once:\n\n" +
                "1. Tap \"Open App Info\" → menu (⋮, top-right) → \"Allow restricted settings\" → Allow.\n" +
                "2. Tap \"Open Notification Access\" → enable \"YOUPI Payment Observer Service\".\n" +
                "3. Return here and tap \"Re-check Access\".\n\n" +
                "If the notification-access toggle is not greyed out, step 1 can be skipped. " +
                "Installing from Google Play or with adb normally avoids this restriction."
        } else {
            "Tap \"Open Notification Access\", enable \"YOUPI Payment Observer Service\", then tap \"Re-check Access\"."
        }
    }

    // --------------------------------------------------------------- pairing

    private fun performPairing() {
        val url = etBaseUrl.text.toString().trim()
        val token = etToken.text.toString().trim()

        if (url.isEmpty() || token.isEmpty()) {
            Toast.makeText(this, PairFailureReason.MISSING_INPUT.userMessage, Toast.LENGTH_SHORT).show()
            return
        }

        btnPair.isEnabled = false
        btnPair.text = "Pairing…"

        Thread {
            val result = apiClient.pair(url, token, Build.MODEL)
            runOnUiThread {
                if (isFinishing || isDestroyed) return@runOnUiThread

                btnPair.isEnabled = true
                btnPair.text = PAIR_BUTTON_LABEL

                when (result) {
                    is PairResult.Success -> {
                        // Redeemed: the token has no further use. Remove it from the
                        // views immediately instead of leaving a live credential on screen.
                        etToken.setText("")
                        etToken.clearFocus()
                        ObserverRuntime.reset()
                        val shortId = result.deviceId.take(8)
                        Toast.makeText(
                            this,
                            "Paired successfully. Device ID $shortId…",
                            Toast.LENGTH_LONG
                        ).show()
                        renderStatus()
                    }
                    is PairResult.Failure -> {
                        if (result.reason == PairFailureReason.INVALID_TOKEN) {
                            // Expired/used tokens are useless and sensitive: clear them.
                            etToken.setText("")
                        }
                        Toast.makeText(this, result.reason.userMessage, Toast.LENGTH_LONG).show()
                        renderStatus()
                    }
                }
            }
        }.start()
    }

    // ------------------------------------------------------------- intents

    private fun openNotificationAccessSettings() {
        val component = ComponentName(this, PaymentNotificationListenerService::class.java)
        val intent = Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)
            .putExtra(NOTIFICATION_LISTENER_COMPONENT_EXTRA, component.flattenToString())
        try {
            startActivity(intent)
        } catch (e: Exception) {
            // OEMs that ignore the component hint still accept the plain settings intent.
            startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS))
        }
    }

    private fun requestListenerRebind() {
        try {
            NotificationListenerService.requestRebind(
                ComponentName(this, PaymentNotificationListenerService::class.java)
            )
        } catch (e: Exception) {
            // Rebinding is a hint; the system re-binds on its own when access is granted.
        }
    }

    private fun openAppInfo() {
        startActivity(
            Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", packageName, null)
            )
        )
    }

    // -------------------------------------------------------------- helpers

    private fun hasNotificationListenerAccess(): Boolean {
        return try {
            NotificationManagerCompat.getEnabledListenerPackages(this).contains(packageName)
        } catch (e: Exception) {
            false
        }
    }

    private fun hasPermission(permission: String): Boolean {
        return ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
    }

    private fun colorFor(state: ObserverState): Int {
        return when (state) {
            ObserverState.ACTIVE -> COLOR_OK
            ObserverState.PAIRED_NOT_LISTENING -> COLOR_WARNING
            ObserverState.NOT_PAIRED, ObserverState.ERROR -> COLOR_ERROR
        }
    }

    companion object {
        private const val PAIR_BUTTON_LABEL = "Pair with Merchant Gateway"
        private const val REFRESH_INTERVAL_MS = 2_000L
        private const val REQUEST_SMS = 1001
        private const val REQUEST_NOTIFICATIONS = 1002

        // Settings.EXTRA_NOTIFICATION_LISTENER_COMPONENT_NAME (API 30), inlined for older devices.
        private const val NOTIFICATION_LISTENER_COMPONENT_EXTRA =
            "android.provider.extra.NOTIFICATION_LISTENER_COMPONENT_NAME"

        private val COLOR_OK = Color.parseColor("#047857")
        private val COLOR_WARNING = Color.parseColor("#b45309")
        private val COLOR_ERROR = Color.parseColor("#b91c1c")
    }
}

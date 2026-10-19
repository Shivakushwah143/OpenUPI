# Android Payment Observer Mobile App — Engineering & Deployment Guide

## 1. Overview & Architectural Role

The **YOUPI Android Payment Observer** is a native Android Kotlin application designed to run on a dedicated merchant phone receiving UPI incoming payments via banking and UPI applications (PhonePe, Google Pay, Paytm, BHIM, HDFC, ICICI, SBI, Axis, etc.).

### Critical Architectural Boundaries
1. **The Mobile App Is An Observer, NOT a Decision-Maker:**
   - The app's job is strictly:
     $$\text{Notification Arrived} \to \text{Extract Amount \& UTR} \to \text{Sign Payload} \to \text{Dispatch to Backend}$$
   - The mobile application **never** determines whether a payment succeeded. It reports:
     *"I observed a status bar notification representing an incoming credit of ₹200.00."*
   - The central self-hosted backend decides attribution based on the active queue slot, expected amount, and server timestamps.
2. **Cryptographic Device Enrollment:**
   - The app does not contain hardcoded API keys or master secrets.
   - It pairs with the merchant's gateway via an ephemeral enrollment token (scanned via QR code in the Merchant Admin).
   - Upon pairing, the gateway assigns a permanent `deviceId` and unique 256-bit `signingKey` stored in Android's `EncryptedSharedPreferences` (backed by the hardware Android Keystore).
   - Every observation submission is signed using `HMAC-SHA256(signingKey, body + ":" + timestamp)` with headers `X-Device-Id`, `X-Timestamp`, and `X-Signature`. Replay attacks are rejected if timestamp drift exceeds 60 seconds.

---

## 2. Directory Structure & Source Code Layout

```
apps/android-observer-app/
├── build.gradle.kts                 # Root Gradle build script
├── settings.gradle.kts              # Gradle project settings
├── driver.js                        # Headless Node.js Driver / Simulator for automated CI/CD testing
├── simulate-notification.js         # Interactive CLI simulator for pushing test notifications
├── app/
│   ├── build.gradle.kts             # App-level dependencies (OkHttp, Security Crypto, AndroidX)
│   └── src/
│       └── main/
│           ├── AndroidManifest.xml  # Manifest with permissions and service registrations
│           ├── res/
│           │   └── xml/
│           │       └── network_security_config.xml
│           └── java/com/youpi/observer/
│               ├── MainActivity.kt                      # Setup, pairing UI & permission prompt
│               ├── PaymentNotificationListenerService.kt # Core NotificationListenerService
│               ├── NotificationParser.kt                # Regex parser for PhonePe, GPay, Paytm, Bank SMS
│               ├── ApiClient.kt                         # OkHttp client with HMAC-SHA256 signing
│               ├── ForegroundService.kt                 # Sticky foreground service preventing OS kill
│               ├── HeartbeatWorker.kt                   # 60-second liveness heartbeat scheduler
│               └── BootReceiver.kt                      # Auto-restart upon device boot
```

---

## 3. How to Build the APK

### Prerequisites
- JDK 17+ (e.g. OpenJDK 17)
- Android SDK (API Level 34)

### Building via Gradle CLI
From the `apps/android-observer-app` directory:

```bash
# Debug Build (for testing & development):
./gradlew assembleDebug

# Output APK located at:
# app/build/outputs/apk/debug/app-debug.apk

# Production Release Build:
./gradlew assembleRelease
```

---

## 4. Installation & Device Setup

### Step 1: Install APK onto Android Device
Connect your Android phone via USB with USB Debugging enabled:

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
```
*(Or transfer `app-debug.apk` directly to your phone via USB/WhatsApp/Drive and install).*

### Step 2: Grant Notification Listener Permission
1. Open the app **YOUPI Observer**.
2. Tap **Open Notification Access**.
3. Android System Settings will open. Toggle **YOUPI Payment Observer Service** (the observer app) to **Allowed**.
4. Confirm the system warning dialog, return to the app and tap **Re-check Access**.

**Android 13+ (Restricted Settings).** Notification access is a protected setting. If the APK was installed from a browser, chat app or file manager, Android shows the toggle greyed out with *"Restricted setting"*. This is a platform security control and must be allowed by the device owner once:

1. In the app tap **Open App Info** (or Settings → Apps → YOUPI SMS Gateway).
2. Open the top-right ⋮ menu → **Allow restricted settings** → **Allow**.
3. Return to the app, tap **Open Notification Access**, enable **YOUPI Payment Observer Service**, then **Re-check Access**.

The app shows these steps inline whenever access is missing. Installing through Google Play or `adb install` normally skips this step, but behavior is OEM-dependent, so verify on the target phone. There is no public API to detect or auto-grant restricted settings, and the app never attempts to bypass it.

### Step 3: Exempt from Battery Optimization (Crucial for 24/7 Uptime)
To ensure Android OEMs (Xiaomi MIUI, Samsung OneUI, OnePlus OxygenOS, Realme/Oppo ColorOS) do not put the observer to sleep:
1. Open phone **Settings** > **Apps** > **YOUPI Observer**.
2. Tap **Battery** > Select **Unrestricted** (or "Don't optimize").
3. Enable **Autostart** / **Allow background activity**.

### Step 4: Pair with Gateway
1. Open your Merchant Admin (`http://localhost:6001`).
2. Go to **Observers & Pairing** tab -> Click **+ Pair Android Device**.
3. In the mobile app, enter the Gateway URL (e.g. `http://192.168.1.50:6100`) and the Enrollment Token.
4. Tap **Pair with Merchant Gateway**.
5. The status badge changes to **ACTIVE** with a green indicator once the listener is enabled and a signed heartbeat is acknowledged. The app reports exactly one of:
   - **NOT PAIRED** — no device credential stored.
   - **PAIRED / NOT LISTENING** — paired, but notification access is off (no payments can be observed).
   - **ACTIVE** — paired, listening, gateway reachable.
   - **ERROR** — gateway unreachable or the device credential was rejected (re-pair required).

The device id assigned by the gateway is shown under the status once pairing succeeds.

### Step 5: Enrollment token handling
- Pairing challenges are single-use, 256-bit and expire after 10 minutes; only their SHA-256 hash is stored server-side.
- The app treats the token as a bearer credential: masked input, excluded from autofill and activity-state saving, cleared from the field after redemption (or when the gateway reports it invalid), and never persisted or logged.
- If a pairing QR/token may have been exposed, revoke every outstanding challenge for the tenant:

```bash
curl -X POST https://<gateway>/api/v1/admin/sms-gateway/pairing-tokens/revoke \
  -H "X-Admin-Key: $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"merchantId":"<merchant-id>"}'
```

The Merchant Admin pairing panel exposes the same action (**Revoke Outstanding Tokens**). Redemption and revocation are written to `audit_logs` (`SMS_GATEWAY_PAIRING_TOKEN_REDEEMED`, `SMS_GATEWAY_PAIRING_TOKENS_REVOKED`) without the token value.

---

## 5. Testing with ADB Notifications (Simulation on Real Phone)

You can simulate real incoming UPI notifications directly on a connected physical phone without spending real money:

```bash
# Simulate PhonePe UPI Payment Received Notification:
adb shell cmd notification post -S bigtext -t "PhonePe" "Payment Received" "Payment of Rs 200.00 received from customer@paytm on PhonePe. UTR: 998877665544"

# Simulate Google Pay Payment Received Notification:
adb shell cmd notification post -S bigtext -t "Google Pay" "Payment Received" "Rs 450.00 received from payer@upi via GPay. Ref: UTR12345678"

# Simulate Paytm UPI Notification:
adb shell cmd notification post -S bigtext -t "Paytm" "Money Received" "Received Rs 1,200 from 9876543210@paytm. UPI Ref: 5544332211"
```

The app's `PaymentNotificationListenerService` will instantly catch the notification, extract the amount and UTR, compute the HMAC-SHA256 signature, and transmit the observation to your backend.

---

## 6. Testing via Terminal Simulator (Without Phone)

If developing locally without a physical Android phone connected:

```bash
node apps/android-observer-app/simulate-notification.js
```

This simulator:
1. Pairs with your local gateway API.
2. Emits a liveness heartbeat.
3. Transmits an authentic signed PhonePe notification observation.
4. Outputs the response status and attribution result in color on the terminal.

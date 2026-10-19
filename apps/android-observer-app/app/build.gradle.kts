plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing is supplied at build time (never committed):
//   -PobserverStoreFile=... -PobserverStorePassword=... -PobserverKeyAlias=... -PobserverKeyPassword=...
// or the OBSERVER_KEYSTORE_* environment variables. Without them a release build
// falls back to the local debug key so a controlled test build is always installable.
val observerStoreFile = (project.findProperty("observerStoreFile") ?: System.getenv("OBSERVER_KEYSTORE_FILE"))?.toString()
val observerStorePassword = (project.findProperty("observerStorePassword") ?: System.getenv("OBSERVER_KEYSTORE_PASSWORD"))?.toString()
val observerKeyAlias = (project.findProperty("observerKeyAlias") ?: System.getenv("OBSERVER_KEY_ALIAS"))?.toString()
val observerKeyPassword = (project.findProperty("observerKeyPassword") ?: System.getenv("OBSERVER_KEY_PASSWORD"))?.toString()

android {
    namespace = "com.youpi.observer"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.youpi.observer"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0.0"
    }

    signingConfigs {
        if (!observerStoreFile.isNullOrBlank()) {
            create("observerRelease") {
                storeFile = file(observerStoreFile)
                storePassword = observerStorePassword
                keyAlias = observerKeyAlias
                keyPassword = observerKeyPassword
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("observerRelease") ?: signingConfigs.getByName("debug")
            if (signingConfigs.findByName("observerRelease") == null) {
                logger.warn("[observer] No release keystore supplied: APK will be signed with the DEBUG key (test use only).")
            }
        }
    }
    // NOTE: the legacy Java copies of the observer classes were removed. They
    // declared the same fully-qualified names as the Kotlin implementation, which
    // made `assembleRelease` fail with "Duplicate class", and their ApiClient
    // predated the signed-heartbeat requirement.
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // ZXing core, bundled locally: the (Java) QR pairing activity decodes camera
    // frames with com.google.zxing.
    implementation(files("libs/core-3.5.3.jar"))
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("com.google.android.material:material:1.11.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    // Local JVM tests for the pure observer-state resolver (no device required).
    testImplementation("junit:junit:4.13.2")
}

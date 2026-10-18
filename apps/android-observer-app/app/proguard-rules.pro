# The observer is a small, self-contained app with no reflection-based libraries
# beyond OkHttp/AndroidX, which ship their own consumer rules. Keep the manifest
# entry points (activity, services, receivers) so release shrinking cannot break
# notification/SMS observation.
-keep class com.youpi.observer.MainActivity { *; }
-keep class com.youpi.observer.PaymentNotificationListenerService { *; }
-keep class com.youpi.observer.ForegroundService { *; }
-keep class com.youpi.observer.SmsReceiver { *; }
-keep class com.youpi.observer.BootReceiver { *; }

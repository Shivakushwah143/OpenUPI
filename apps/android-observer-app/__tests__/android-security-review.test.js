import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Static regression guards for the security review items that cannot be
// exercised on a JVM without a device (UI input handling and logcat output).
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAVA = path.join(ROOT, 'app/src/main/java/com/youpi/observer');
const read = rel => fs.readFileSync(path.join(JAVA, rel), 'utf8');
const logLines = source => source
  .split('\n')
  .filter(line => /\bLog\.[vdiew]\(/.test(line));

describe('Android observer security review', () => {
  test('enrollment token is masked, excluded from save/autofill, cleared and never persisted', () => {
    const activity = read('MainActivity.kt');
    const api = read('ApiClient.kt');

    assert.match(activity, /TYPE_TEXT_VARIATION_PASSWORD/);
    assert.match(activity, /isSaveEnabled = false/);
    assert.match(activity, /IMPORTANT_FOR_AUTOFILL_NO/);
    // Cleared from the field on successful redemption.
    assert.match(activity, /etToken\.setText\(""\)/);

    // Only place a token may appear: the pairing request body.
    assert.equal((api.match(/put\("enrollmentToken"/g) || []).length, 1);
    assert.doesNotMatch(api, /putString\([^)]*token/i);
    assert.doesNotMatch(api, /printStackTrace\(/);
  });

  test('no payment notification contents, amounts, UTRs or VPAs reach logcat', () => {
    const sensitive = /rawText|rawTitle|amountRupees|amountPaise|bankReferenceNumber|senderVpa|\$title|\$text/;
    for (const file of ['PaymentNotificationListenerService.kt', 'SmsReceiver.kt', 'ApiClient.kt']) {
      for (const line of logLines(read(file))) {
        assert.doesNotMatch(line, sensitive, `${file} logs sensitive payment data: ${line.trim()}`);
      }
    }
    // SMS logging keeps only the message length.
    const smsLogs = logLines(read('SmsReceiver.kt')).join('\n');
    assert.match(smsLogs, /length=/);
    assert.doesNotMatch(smsLogs, /\$\{body\}/);
  });

  test('the setup screen can only report the four required states', () => {
    const state = read('ObserverState.kt');
    assert.match(state, /NOT_PAIRED\("NOT PAIRED"\)/);
    assert.match(state, /PAIRED_NOT_LISTENING\("PAIRED \/ NOT LISTENING"\)/);
    assert.match(state, /ACTIVE\("ACTIVE"\)/);
    assert.match(state, /ERROR\("ERROR"\)/);
    // ACTIVE requires the listener grant; it is resolved after that check.
    const resolver = state.slice(state.indexOf('fun resolve'));
    assert.ok(
      resolver.indexOf('if (!listenerEnabled)') < resolver.indexOf('ObserverState.ACTIVE'),
      'listener state must be evaluated before ACTIVE'
    );
  });

  test('device id is read from the persisted pairing response, not hardcoded to a dash', () => {
    const activity = read('MainActivity.kt');
    const api = read('ApiClient.kt');
    assert.match(api, /fun getDeviceId\(\)/);
    assert.match(activity, /apiClient\.getDeviceId\(\)/);
    // The placeholder is only the unpaired fallback.
    assert.match(activity, /Device ID: \$\{deviceId \?: "-"\}/);
  });
});

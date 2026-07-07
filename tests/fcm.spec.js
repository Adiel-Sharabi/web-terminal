// @ts-check
// Unit tests for the pure FCM helpers (lib/fcm.js) — no server, no network.
// Message shape per kind, JWT structure + signature, client token caching with a
// fake clock, and error-code surfacing for token pruning.
const { test, expect } = require('@playwright/test');
const crypto = require('crypto');
const fcm = require('../lib/fcm');

test.describe('fcm.buildFcmMessage', () => {
  test('data payload is content-free and all-strings', () => {
    const m = fcm.buildFcmMessage('approval', {
      serverName: 'Home', sessionId: 'abc-123', ts: 1720000000000,
      deepLink: 'https://h/app/abc-123', token: 'TOK',
    });
    expect(m.message.token).toBe('TOK');
    // Exactly these five keys — no sessionName, no reason, no content.
    expect(Object.keys(m.message.data).sort()).toEqual(['deepLink', 'kind', 'serverName', 'sessionId', 'ts']);
    for (const v of Object.values(m.message.data)) expect(typeof v).toBe('string');
    expect(m.message.data.kind).toBe('approval');
    expect(m.message.data.serverName).toBe('Home');
    expect(m.message.data.sessionId).toBe('abc-123');
    expect(m.message.data.ts).toBe('1720000000000'); // String(ts) — FCM requires strings
    expect(m.message.data.deepLink).toBe('https://h/app/abc-123');
  });

  test('android block: priority + collapse_key + ttl per kind', () => {
    const approval = fcm.buildFcmMessage('approval', { sessionId: 's1' });
    expect(approval.message.android.priority).toBe('high');
    expect(approval.message.android.collapse_key).toBe('session-s1');
    expect(approval.message.android.ttl).toBe('300s');

    expect(fcm.buildFcmMessage('apierror', { sessionId: 's' }).message.android.priority).toBe('high');
    expect(fcm.buildFcmMessage('apierror', { sessionId: 's' }).message.android.ttl).toBe('600s');
    expect(fcm.buildFcmMessage('clear', { sessionId: 's' }).message.android.priority).toBe('high');
    expect(fcm.buildFcmMessage('clear', { sessionId: 's' }).message.android.ttl).toBe('60s');
    // #25: idle is now high-priority too, so an 'all'-level "finished" push
    // wakes the phone through Android Doze instead of being deferred/dropped.
    // Delivery priority is independent of display — idle still renders on the
    // silent, low-importance channel. Its long (non-urgent) TTL is kept.
    const idle = fcm.buildFcmMessage('idle', { sessionId: 's' });
    expect(idle.message.android.priority).toBe('high');
    expect(idle.message.android.ttl).toBe('3600s');
  });

  test('#25: an all-level idle/finished push is BOTH gated-in and high-priority', () => {
    const np = require('../lib/notify-push');
    // The level gate lets idle through only at 'all' (not 'important'/'off')…
    expect(np.shouldPush('idle', 'all')).toBe(true);
    expect(np.shouldPush('idle', 'important')).toBe(false);
    // …and once built, its FCM message is high-priority so it actually wakes the
    // phone through Doze (the missing half that broke mobile delivery).
    expect(fcm.buildFcmMessage('idle', { sessionId: 's' }).message.android.priority)
      .toBe('high');
  });

  test('missing fields coerce to empty strings (never "undefined")', () => {
    const m = fcm.buildFcmMessage('idle', { sessionId: 'x' });
    expect(m.message.data.serverName).toBe('');
    expect(m.message.data.deepLink).toBe('');
    expect(m.message.data.ts).toBe('');
    expect(m.message.android.collapse_key).toBe('session-x');
  });
});

test.describe('fcm.buildJwt', () => {
  test('produces a verifiable RS256 service-account JWT', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const nowMs = 1720000000000;
    const jwt = fcm.buildJwt({ clientEmail: 'svc@proj.iam.gserviceaccount.com', privateKey, nowMs });
    const [h, p, s] = jwt.split('.');
    expect(s).toBeTruthy();

    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims.iss).toBe('svc@proj.iam.gserviceaccount.com');
    expect(claims.aud).toBe('https://oauth2.googleapis.com/token');
    expect(claims.scope).toBe('https://www.googleapis.com/auth/firebase.messaging');
    expect(claims.iat).toBe(Math.floor(nowMs / 1000));
    expect(claims.exp).toBe(claims.iat + 3600);

    // The signature verifies against the matching public key.
    const v = crypto.createVerify('RSA-SHA256');
    v.update(`${h}.${p}`);
    v.end();
    expect(v.verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
  });
});

test.describe('fcm.createFcmClient', () => {
  function fakeServiceAccount() {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    return {
      project_id: 'proj-1',
      client_email: 'svc@proj-1.iam.gserviceaccount.com',
      private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
  }

  test('exchanges a token on first send, reuses it, re-exchanges after expiry', async () => {
    const sa = fakeServiceAccount();
    let clock = 1720000000000;
    const now = () => clock;
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, opts });
      if (url.includes('oauth2.googleapis.com/token')) {
        const n = calls.filter(c => c.url.includes('/token')).length;
        return { status: 200, json: async () => ({ access_token: 'AT-' + n, expires_in: 3600 }) };
      }
      return { status: 200, json: async () => ({ name: 'projects/proj-1/messages/1' }) };
    };
    const client = fcm.createFcmClient({ serviceAccount: sa, fetchImpl, now });
    const msg = fcm.buildFcmMessage('approval', { sessionId: 's', token: 'DEV' });

    const r1 = await client.send(msg);
    expect(r1.ok).toBe(true);
    const sendCall = calls.find(c => c.url.includes('/messages:send'));
    expect(sendCall.url).toBe('https://fcm.googleapis.com/v1/projects/proj-1/messages:send');
    expect(sendCall.opts.headers.Authorization).toBe('Bearer AT-1');
    expect(calls.filter(c => c.url.includes('/token')).length).toBe(1);

    // 2nd send within validity reuses the cached token (no new exchange).
    await client.send(msg);
    expect(calls.filter(c => c.url.includes('/token')).length).toBe(1);

    // Advance past (expiry - 5min skew): token valid < iat+3300s → re-exchange.
    clock += 3301 * 1000;
    const r3 = await client.send(msg);
    expect(r3.ok).toBe(true);
    expect(calls.filter(c => c.url.includes('/token')).length).toBe(2);
    // The re-issued token is now the Bearer on the newest send.
    const lastSend = calls.filter(c => c.url.includes('/messages:send')).pop();
    expect(lastSend.opts.headers.Authorization).toBe('Bearer AT-2');
  });

  test('surfaces FCM errorCode (UNREGISTERED) from error.details for pruning', async () => {
    const sa = fakeServiceAccount();
    const fetchImpl = async (url) => {
      if (url.includes('/token')) return { status: 200, json: async () => ({ access_token: 'AT', expires_in: 3600 }) };
      return {
        status: 404,
        json: async () => ({
          error: {
            code: 404, status: 'NOT_FOUND', message: 'Requested entity was not found.',
            details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }],
          },
        }),
      };
    };
    const client = fcm.createFcmClient({ serviceAccount: sa, fetchImpl, now: () => 1720000000000 });
    const r = await client.send(fcm.buildFcmMessage('approval', { sessionId: 's', token: 'DEAD' }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(404);
    expect(r.errorCode).toBe('UNREGISTERED');
  });

  test('falls back to error.status (INVALID_ARGUMENT) when no FcmError detail', async () => {
    const sa = fakeServiceAccount();
    const fetchImpl = async (url) => {
      if (url.includes('/token')) return { status: 200, json: async () => ({ access_token: 'AT', expires_in: 3600 }) };
      return { status: 400, json: async () => ({ error: { code: 400, status: 'INVALID_ARGUMENT', message: 'bad token' } }) };
    };
    const client = fcm.createFcmClient({ serviceAccount: sa, fetchImpl, now: () => 1720000000000 });
    const r = await client.send(fcm.buildFcmMessage('approval', { sessionId: 's', token: 'BAD' }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(400);
    expect(r.errorCode).toBe('INVALID_ARGUMENT');
  });

  test('a failed token exchange is reported, not thrown', async () => {
    const sa = fakeServiceAccount();
    const fetchImpl = async () => ({ status: 401, json: async () => ({ error: 'invalid_grant', error_description: 'bad jwt' }) });
    const client = fcm.createFcmClient({ serviceAccount: sa, fetchImpl, now: () => 1720000000000 });
    const r = await client.send(fcm.buildFcmMessage('approval', { sessionId: 's', token: 'X' }));
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toContain('token exchange failed');
  });
});

test.describe('fcm.resolvePushProvider (env > config > ntfy default)', () => {
  test('back-compat default is ntfy when nothing is set', () => {
    expect(fcm.resolvePushProvider({})).toBe('ntfy');
    expect(fcm.resolvePushProvider({ env: undefined, configProvider: undefined })).toBe('ntfy');
  });
  test('a valid env value wins over config', () => {
    expect(fcm.resolvePushProvider({ env: 'fcm', configProvider: 'both' })).toBe('fcm');
    expect(fcm.resolvePushProvider({ env: 'both', configProvider: 'ntfy' })).toBe('both');
  });
  test('config is used when env is absent/invalid', () => {
    expect(fcm.resolvePushProvider({ configProvider: 'both' })).toBe('both');
    expect(fcm.resolvePushProvider({ env: 'loud', configProvider: 'fcm' })).toBe('fcm');
  });
  test('an invalid value never silently disables ntfy (falls through to default)', () => {
    expect(fcm.resolvePushProvider({ env: 'nope', configProvider: 'bogus' })).toBe('ntfy');
    expect(fcm.resolvePushProvider({ env: '', configProvider: null })).toBe('ntfy');
  });
  test('providerSendsNtfy / providerSendsFcm partition the transports', () => {
    expect(fcm.providerSendsNtfy('ntfy')).toBe(true);
    expect(fcm.providerSendsNtfy('both')).toBe(true);
    expect(fcm.providerSendsNtfy('fcm')).toBe(false);
    expect(fcm.providerSendsFcm('fcm')).toBe(true);
    expect(fcm.providerSendsFcm('both')).toBe(true);
    expect(fcm.providerSendsFcm('ntfy')).toBe(false);
  });
});

test.describe('fcm.normalizeDeviceRegistration', () => {
  test('rejects a missing / empty / whitespace-only / non-string token', () => {
    expect(fcm.normalizeDeviceRegistration({}).ok).toBe(false);
    expect(fcm.normalizeDeviceRegistration({ fcmToken: '' }).ok).toBe(false);
    expect(fcm.normalizeDeviceRegistration({ fcmToken: '   ' }).ok).toBe(false);
    expect(fcm.normalizeDeviceRegistration({ fcmToken: 123 }).ok).toBe(false);
  });
  test('4096 is the max length (boundary)', () => {
    expect(fcm.normalizeDeviceRegistration({ fcmToken: 'a'.repeat(4096) }).ok).toBe(true);
    expect(fcm.normalizeDeviceRegistration({ fcmToken: 'a'.repeat(4097) }).ok).toBe(false);
  });
  test('trims the token, defaults name to "" and platform to android', () => {
    const v = fcm.normalizeDeviceRegistration({ fcmToken: '  tok  ' });
    expect(v.ok).toBe(true);
    expect(v.device.token).toBe('tok');
    expect(v.device.platform).toBe('android');
    expect(v.device.deviceName).toBe('');
  });
  test('whitelists platform; unknown → android', () => {
    expect(fcm.normalizeDeviceRegistration({ fcmToken: 't', platform: 'ios' }).device.platform).toBe('ios');
    expect(fcm.normalizeDeviceRegistration({ fcmToken: 't', platform: 'other' }).device.platform).toBe('other');
    expect(fcm.normalizeDeviceRegistration({ fcmToken: 't', platform: 'windows' }).device.platform).toBe('android');
  });
  test('sanitizes deviceName (strips control chars, caps at 100)', () => {
    const v = fcm.normalizeDeviceRegistration({ fcmToken: 't', deviceName: 'My\x00Phone\x1f!' });
    expect(v.device.deviceName).toBe('MyPhone!');
    expect(fcm.normalizeDeviceRegistration({ fcmToken: 't', deviceName: 'x'.repeat(250) }).device.deviceName.length).toBe(100);
  });
});

test.describe('fcm.truncateToken', () => {
  test('long tokens show first 12 chars + ellipsis; short/empty unchanged', () => {
    expect(fcm.truncateToken('abcdefghijklmnopqrstuvwxyz')).toBe('abcdefghijkl…');
    expect(fcm.truncateToken('short')).toBe('short');
    expect(fcm.truncateToken('')).toBe('');
    expect(fcm.truncateToken(null)).toBe('');
  });
});

test.describe('fcm.shouldPruneOnError', () => {
  test('prunes only on UNREGISTERED / INVALID_ARGUMENT', () => {
    expect(fcm.shouldPruneOnError('UNREGISTERED')).toBe(true);
    expect(fcm.shouldPruneOnError('INVALID_ARGUMENT')).toBe(true);
    expect(fcm.shouldPruneOnError('INTERNAL')).toBe(false);
    expect(fcm.shouldPruneOnError('QUOTA_EXCEEDED')).toBe(false);
    expect(fcm.shouldPruneOnError(null)).toBe(false);
    expect(fcm.shouldPruneOnError(undefined)).toBe(false);
  });
});

test.describe('fcm.canRegisterDevice (registry cap)', () => {
  test('under the cap: a NEW token is allowed', () => {
    expect(fcm.canRegisterDevice(0, false)).toBe(true);
    expect(fcm.canRegisterDevice(fcm.MAX_DEVICES - 1, false)).toBe(true); // last free slot
  });
  test('at/over the cap: a NEW token is refused', () => {
    expect(fcm.canRegisterDevice(fcm.MAX_DEVICES, false)).toBe(false);
    expect(fcm.canRegisterDevice(fcm.MAX_DEVICES + 5, false)).toBe(false);
  });
  test('at/over the cap: an EXISTING token (upsert) is still allowed', () => {
    expect(fcm.canRegisterDevice(fcm.MAX_DEVICES, true)).toBe(true);
    expect(fcm.canRegisterDevice(fcm.MAX_DEVICES + 100, true)).toBe(true);
  });
  test('honors a custom max (boundary at max)', () => {
    expect(fcm.canRegisterDevice(2, false, 3)).toBe(true);
    expect(fcm.canRegisterDevice(3, false, 3)).toBe(false);
    expect(fcm.canRegisterDevice(3, true, 3)).toBe(true); // existing upsert always OK
  });
});

test.describe('fcm.shouldRetryClientBuild (client-build negative cache)', () => {
  test('the first attempt (no prior failure) is allowed', () => {
    expect(fcm.shouldRetryClientBuild(0, 1000)).toBe(true);
  });
  test('within the backoff window, a retry is suppressed', () => {
    const until = 1000 + fcm.CLIENT_BUILD_BACKOFF_MS;
    expect(fcm.shouldRetryClientBuild(until, 1000)).toBe(false);
    expect(fcm.shouldRetryClientBuild(until, until - 1)).toBe(false);
  });
  test('at/after the backoff deadline, a retry is allowed again', () => {
    const until = 1000 + fcm.CLIENT_BUILD_BACKOFF_MS;
    expect(fcm.shouldRetryClientBuild(until, until)).toBe(true);
    expect(fcm.shouldRetryClientBuild(until, until + 1)).toBe(true);
  });
  test('the backoff mirrors the 60s token-exchange backoff', () => {
    expect(fcm.CLIENT_BUILD_BACKOFF_MS).toBe(60 * 1000);
  });
});

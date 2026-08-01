import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    ACCELERATOR_VERSION,
    createServiceWorkerSource,
    isCacheableResponseMetadata,
    isSafeStaticPath,
} from '../server/worker-template.js';

test('allows only same-origin SillyTavern program resources', () => {
    for (const path of [
        '/script.js',
        '/style.css',
        '/scripts/templates/settings.html',
        '/scripts/extensions/regex/index.js',
        '/css/mobile-styles.css',
        '/lib/jquery-3.5.1.min.js',
        '/locales/zh-cn.json',
        '/img/logo.png',
        '/webfonts/NotoSans/stylesheet.css',
        '/sounds/message.mp3',
    ]) assert.equal(isSafeStaticPath(path), true, path);
});

test('rejects navigation, API, user data, and all third-party extension assets', () => {
    for (const path of [
        '/',
        '/login',
        '/api/settings/get',
        '/api/characters/all',
        '/characters/Alice.png',
        '/backgrounds/room.jpg',
        '/thumbnail?type=avatar',
        '/css/user.css',
        '/user/avatar.png',
        '/scripts/extensions/third-party/example/index.js',
        'script.js',
        '',
    ]) assert.equal(isSafeStaticPath(path), false, path);
});

test('only status 200 responses without authentication challenges are cacheable', () => {
    assert.equal(isCacheableResponseMetadata({ status: 200, type: 'basic' }), true);
    assert.equal(isCacheableResponseMetadata({ status: 401, type: 'basic' }), false);
    assert.equal(isCacheableResponseMetadata({ status: 403, type: 'basic' }), false);
    assert.equal(isCacheableResponseMetadata({ status: 200, type: 'basic', headers: { 'WWW-Authenticate': 'Basic' } }), false);
    assert.equal(isCacheableResponseMetadata({ status: 200, type: 'basic', headers: { 'Proxy-Authenticate': 'Basic' } }), false);
    assert.equal(isCacheableResponseMetadata({ status: 200, type: 'basic', redirected: true }), false);
    assert.equal(isCacheableResponseMetadata({ status: 200, type: 'opaque' }), false);
});

test('worker never intercepts navigation and sends credentials for static fetches', () => {
    const source = createServiceWorkerSource();
    assert.doesNotThrow(() => new Function(source));
    assert.match(source, new RegExp(`Cloud Lounge Accelerator ${ACCELERATOR_VERSION.replaceAll('.', '\\.')}`));
    assert.match(source, /if \(event\.request\.mode === 'navigate'\) return;/);
    assert.doesNotMatch(source, /handleNavigation/);
    assert.doesNotMatch(source, /respondWith\(handleNavigation/);
    assert.match(source, /credentials: 'same-origin'/);
    assert.match(source, /response\.status === 200/);
    assert.match(source, /!response\.redirected/);
    assert.match(source, /response\.headers\.has\('www-authenticate'\)/);
    assert.match(source, /response\.headers\.has\('proxy-authenticate'\)/);
});

test('1Panel example does not publish authentication failures to shared caches', async () => {
    const source = await readFile(new URL('../1panel/nginx-static.conf.example', import.meta.url), 'utf8');
    assert.match(source, /Cache-Control "private,/);
    assert.match(source, /Vary "Authorization, Cookie"/);
    assert.doesNotMatch(source, /Cache-Control "public,/);
    assert.doesNotMatch(source, /add_header Cache-Control .* always/);
});

test('worker clears caches after extension changes and version signatures', () => {
    const source = createServiceWorkerSource();
    assert.match(source, /isExtensionMutation/);
    assert.match(source, /VERSION_SIGNATURE/);
    assert.match(source, /acceptVersionSignature/);
    assert.match(source, /await clearResourceCaches\(\)/);
    assert.match(source, /LEGACY_CACHE_PREFIX/);
    assert.match(source, /Math\.min\(3, queue\.length\)/);
    assert.doesNotMatch(source, /allowThirdPartyAssets/);
    assert.doesNotMatch(source, /importScripts\s*\(/);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ACCELERATOR_VERSION,
    createServiceWorkerSource,
    isSafeStaticPath,
} from '../server/worker-template.js';

test('allows only SillyTavern program resources', () => {
    const allowed = [
        '/script.js',
        '/style.css',
        '/scripts/templates/settings.html',
        '/scripts/extensions/quick-reply/index.js',
        '/css/mobile-styles.css',
        '/lib/jquery-3.5.1.min.js',
        '/locales/zh-cn.json',
        '/img/logo.png',
        '/webfonts/NotoSans/stylesheet.css',
        '/sounds/message.mp3',
    ];
    for (const path of allowed) assert.equal(isSafeStaticPath(path), true, path);
    assert.equal(isSafeStaticPath('/scripts/extensions/third-party/example/index.js'), false);
    assert.equal(isSafeStaticPath('/scripts/extensions/third-party/example/index.js', { allowThirdParty: true }), true);
});

test('rejects private, dynamic, and navigation paths', () => {
    const rejected = [
        '/',
        '/login',
        '/csrf-token',
        '/api/settings/get',
        '/api/characters/all',
        '/characters/Alice.png',
        '/backgrounds/room.jpg',
        '/thumbnail?type=avatar',
        '/css/user.css',
        '/user/avatar.png',
        'script.js',
        '',
    ];
    for (const path of rejected) assert.equal(isSafeStaticPath(path), false, path);
});

test('builds a standalone worker with the current version and safety handlers', () => {
    const source = createServiceWorkerSource();
    assert.match(source, new RegExp(`Cloud Lounge Accelerator ${ACCELERATOR_VERSION.replaceAll('.', '\\.')}`));
    assert.match(source, /event\.request\.mode === 'navigate'/);
    assert.match(source, /response\.headers\.get\('etag'\)/);
    assert.match(source, /isExtensionMutation/);
    assert.match(source, /allowThirdPartyAssets/);
    assert.match(source, /request\.headers\.has\('range'\)/);
    assert.match(source, /MAX_RESOURCE_BYTES = 16 \* 1024 \* 1024/);
    assert.match(source, /fetchAndCache\(request, 'force-cache'\)/);
    assert.match(source, /async function cacheFirst/);
    assert.match(source, /writesSinceTrim >= 50/);
    assert.doesNotMatch(source, /staleWhileRevalidate/);
    assert.match(source, /STATIC_EXACT_PATHS/);
    assert.doesNotMatch(source, /importScripts\s*\(/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { detectRenderProfile } from '../utils/device-profile.js';

test('streaming device profiles still distinguish iPad, Android and desktop', () => {
    assert.equal(detectRenderProfile({ userAgent: 'iPhone', maxTouchPoints: 5 }), 'webkit');
    assert.equal(detectRenderProfile({ platform: 'MacIntel', maxTouchPoints: 5 }), 'webkit');
    assert.equal(detectRenderProfile({ userAgent: 'Android', maxTouchPoints: 5 }), 'balanced');
    assert.equal(detectRenderProfile({ userAgent: 'Macintosh', maxTouchPoints: 0 }), 'desktop');
});

test('native drawer and popup effects and chat code visibility are left to their owners', async () => {
    const styles = await readFile(new URL('../style.css', import.meta.url), 'utf8');
    assert.doesNotMatch(styles, /cla-fast-ui|cla-ui-opening|cla-ui-closing|cla-code-collapsed|--popup-animation-speed/);
});

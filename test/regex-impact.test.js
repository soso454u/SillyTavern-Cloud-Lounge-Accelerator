import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    createRegexSnapshot,
    diffRegexSnapshots,
    extractRegexAnchor,
    planRegexRefresh,
} from '../modules/regex-impact.js';

function compileRegex(source) {
    const value = String(source || '');
    const match = value.match(/^\/([\s\S]*)\/([dgimsuvy]*)$/);
    return match ? new RegExp(match[1], match[2]) : new RegExp(value, 'g');
}

function script(id, findRegex, replaceString, overrides = {}) {
    return {
        id,
        scriptName: id,
        findRegex,
        replaceString,
        trimStrings: [],
        placement: [2],
        disabled: false,
        markdownOnly: true,
        promptOnly: false,
        runOnEdit: true,
        substituteRegex: 0,
        minDepth: null,
        maxDepth: null,
        ...overrides,
    };
}

function snapshot(scripts) {
    return createRegexSnapshot([{ type: 0, scripts, scopeActive: true }]);
}

const choices = script('choices', '/<choices>[\\s\\S]*?<\\/choices>/g', '<!DOCTYPE html><html>choices</html>');
const status = script('status', '/<status>[\\s\\S]*?<\\/status>/g', '<section>status-v1</section>');
const messages = [
    { id: 10, text: '<choices>one</choices>', placement: 2 },
    { id: 11, text: '<status>healthy</status>', placement: 2 },
    { id: 12, text: 'plain text', placement: 2 },
];

test('changing a status regex leaves an unrelated heavy HTML message untouched', () => {
    const before = snapshot([choices, status]);
    const after = snapshot([choices, { ...status, replaceString: '<section>status-v2</section>' }]);
    const plan = planRegexRefresh({ before, after, messages, compileRegex });
    assert.equal(plan.mode, 'matched');
    assert.deepEqual(plan.targetIds, [11]);
});

test('changing the heavy HTML regex refreshes only messages containing its source marker', () => {
    const before = snapshot([choices, status]);
    const after = snapshot([{ ...choices, replaceString: '<!DOCTYPE html><html>new choices</html>' }, status]);
    const plan = planRegexRefresh({ before, after, messages, compileRegex });
    assert.equal(plan.mode, 'matched');
    assert.deepEqual(plan.targetIds, [10]);
});

test('name-only and prompt-only changes do not refresh displayed messages', () => {
    const renamed = planRegexRefresh({
        before: snapshot([status]),
        after: snapshot([{ ...status, scriptName: 'renamed' }]),
        messages,
        compileRegex,
    });
    assert.equal(renamed.mode, 'none');

    const prompt = script('prompt', '/secret/g', 'changed', { markdownOnly: false, promptOnly: true });
    const promptPlan = planRegexRefresh({
        before: snapshot([prompt]),
        after: snapshot([{ ...prompt, replaceString: 'changed-again' }]),
        messages,
        compileRegex,
    });
    assert.equal(promptPlan.mode, 'none');
});

test('reordering scripts and changing unsafe display fields request a safe displayed-message refresh', () => {
    const before = snapshot([choices, status]);
    const reordered = snapshot([status, choices]);
    assert.equal(diffRegexSnapshots(before, reordered).reordered, true);
    assert.equal(planRegexRefresh({ before, after: reordered, messages, compileRegex }).mode, 'all');

    const placementChanged = snapshot([choices, { ...status, placement: [1, 2] }]);
    assert.equal(planRegexRefresh({ before, after: placementChanged, messages, compileRegex }).mode, 'all');

    const depthChanged = snapshot([choices, { ...status, minDepth: 0 }]);
    assert.equal(planRegexRefresh({ before, after: depthChanged, messages, compileRegex }).mode, 'all');
});

test('broad, empty-matching, macro-substituted, and invalid patterns fall back safely', () => {
    const variants = [
        { ...status, findRegex: '/[\\s\\S]*/g' },
        { ...status, findRegex: '/(?:)/g' },
        { ...status, substituteRegex: 1 },
        { ...status, findRegex: '/([/g' },
    ];
    for (const variant of variants) {
        const plan = planRegexRefresh({
            before: snapshot([status]),
            after: snapshot([variant]),
            messages,
            compileRegex,
        });
        assert.equal(plan.mode, 'all');
    }
});

test('tracks a preceding producer when one regex creates another regex marker', () => {
    const producer = script('producer', '/<panel>[\\s\\S]*?<\\/panel>/g', '<status>$&</status>');
    const before = snapshot([producer, status]);
    const after = snapshot([producer, { ...status, replaceString: '<section>status-v3</section>' }]);
    const plan = planRegexRefresh({
        before,
        after,
        messages: [{ id: 20, text: '<panel>generated status</panel>', placement: 2 }],
        compileRegex,
    });
    assert.equal(plan.mode, 'matched');
    assert.deepEqual(plan.targetIds, [20]);
});

test('extracts stable literal anchors without treating wildcard-only regexes as precise', () => {
    assert.equal(extractRegexAnchor('/<status>[\\s\\S]*?<\\/status>/g'), 'status');
    assert.equal(extractRegexAnchor('/[\\s\\S]*/g'), '');
});

test('the UI adapter never calls full chat reload and refreshed targets emit the official update event', async () => {
    const [adapterSource, refreshSource] = await Promise.all([
        readFile(new URL('../modules/regex-ui-adapter.js', import.meta.url), 'utf8'),
        readFile(new URL('../modules/regex-refresh.js', import.meta.url), 'utf8'),
    ]);
    assert.match(adapterSource, /saveScriptsByType/);
    assert.doesNotMatch(adapterSource, /reloadCurrentChat/);
    assert.match(refreshSource, /MESSAGE_UPDATED/);
    assert.match(refreshSource, /Promise\.allSettled/);
    assert.doesNotMatch(refreshSource, /if \(failed > 0\) await this\.reloadCurrentChat/);
});

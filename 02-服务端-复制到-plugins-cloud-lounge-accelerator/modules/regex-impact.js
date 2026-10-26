const DISPLAY_PLACEMENTS = new Set([1, 2]);
const NON_VISUAL_FIELDS = new Set(['scriptName', 'runOnEdit']);
const PRECISE_FIELDS = new Set(['disabled', 'findRegex', 'replaceString']);
const SNAPSHOT_FIELDS = Object.freeze([
    'scriptName',
    'disabled',
    'findRegex',
    'replaceString',
    'trimStrings',
    'placement',
    'markdownOnly',
    'promptOnly',
    'runOnEdit',
    'substituteRegex',
    'minDepth',
    'maxDepth',
]);

function normalizeNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function normalizeScript(script, type, position, scopeActive) {
    return {
        id: String(script?.id || `missing-${String(type)}-${position}`),
        type,
        position,
        scopeActive: Boolean(scopeActive),
        scriptName: String(script?.scriptName || ''),
        disabled: Boolean(script?.disabled),
        findRegex: String(script?.findRegex || ''),
        replaceString: String(script?.replaceString || ''),
        trimStrings: Array.isArray(script?.trimStrings) ? script.trimStrings.map(String) : [],
        placement: Array.isArray(script?.placement) ? script.placement.map(Number).filter(Number.isFinite) : [],
        markdownOnly: Boolean(script?.markdownOnly),
        promptOnly: Boolean(script?.promptOnly),
        runOnEdit: Boolean(script?.runOnEdit),
        substituteRegex: normalizeNumber(script?.substituteRegex) ?? 0,
        minDepth: normalizeNumber(script?.minDepth),
        maxDepth: normalizeNumber(script?.maxDepth),
    };
}

function valuesEqual(left, right) {
    return Array.isArray(left) || Array.isArray(right)
        ? JSON.stringify(left) === JSON.stringify(right)
        : left === right;
}

export function createRegexSnapshot(groups = []) {
    const entries = new Map();
    const orders = new Map();
    const scopes = new Map();
    const sequence = [];
    for (const group of Array.isArray(groups) ? groups : []) {
        const type = group?.type;
        const scopeActive = group?.scopeActive !== false;
        const order = [];
        const scripts = Array.isArray(group?.scripts) ? group.scripts : [];
        scripts.forEach((script, position) => {
            const normalized = normalizeScript(script, type, position, scopeActive);
            const key = `${String(type)}:${normalized.id}`;
            entries.set(key, normalized);
            order.push(key);
            sequence.push(key);
        });
        orders.set(type, order);
        scopes.set(type, scopeActive);
    }
    return { entries, orders, scopes, sequence };
}

export function diffRegexSnapshots(before, after) {
    if (!before?.entries || !after?.entries) {
        return { changes: [], reordered: true, scopeChanged: true, moved: true };
    }
    const changes = [];
    const keys = new Set([...before.entries.keys(), ...after.entries.keys()]);
    for (const key of keys) {
        const previous = before.entries.get(key) || null;
        const next = after.entries.get(key) || null;
        if (!previous) {
            changes.push({ key, kind: 'added', before: null, after: next, changedFields: [] });
            continue;
        }
        if (!next) {
            changes.push({ key, kind: 'removed', before: previous, after: null, changedFields: [] });
            continue;
        }
        const changedFields = SNAPSHOT_FIELDS.filter(field => !valuesEqual(previous[field], next[field]));
        if (changedFields.length) changes.push({ key, kind: 'changed', before: previous, after: next, changedFields });
    }

    const types = new Set([...before.orders.keys(), ...after.orders.keys()]);
    let reordered = false;
    let scopeChanged = false;
    for (const type of types) {
        if (before.scopes.get(type) !== after.scopes.get(type)) scopeChanged = true;
        const previousOrder = before.orders.get(type) || [];
        const nextOrder = after.orders.get(type) || [];
        const shared = new Set(previousOrder.filter(key => nextOrder.includes(key)));
        const previousShared = previousOrder.filter(key => shared.has(key));
        const nextShared = nextOrder.filter(key => shared.has(key));
        if (!valuesEqual(previousShared, nextShared)) reordered = true;
    }

    const beforeTypes = new Map([...before.entries.values()].map(script => [script.id, script.type]));
    const moved = [...after.entries.values()].some(script => beforeTypes.has(script.id) && beforeTypes.get(script.id) !== script.type);
    return { changes, reordered, scopeChanged, moved };
}

function isDisplayScript(script) {
    if (!script || !script.scopeActive || script.disabled || !script.markdownOnly) return false;
    return script.placement.some(value => DISPLAY_PLACEMENTS.has(Number(value)));
}

function getRegexBody(source) {
    const value = String(source || '');
    if (!value.startsWith('/')) return value;
    for (let index = value.length - 1; index > 0; index -= 1) {
        if (value[index] !== '/' || value[index - 1] === '\\') continue;
        if (/^[a-z]*$/i.test(value.slice(index + 1))) return value.slice(1, index);
    }
    return value;
}

export function extractRegexAnchor(source) {
    const body = getRegexBody(source)
        .replace(/\[(?:\\.|[^\]])*\]/g, ' ')
        .replace(/\\[pP]\{[^}]+\}/g, ' ')
        .replace(/\\[dDsSwWbB]/g, ' ')
        .replace(/\\(.)/g, '$1')
        .replace(/\(\?[:=!<][^)]*/g, ' ')
        .replace(/[.^$*+?{}()|]/g, ' ');
    const candidates = body.match(/[\p{L}\p{N}_:-]{3,}/gu) || [];
    return candidates.sort((left, right) => right.length - left.length)[0] || '';
}

function compileMatcher(script, compileRegex) {
    if (!script?.findRegex || Number(script.substituteRegex) !== 0) return { unsafe: true };
    const anchor = extractRegexAnchor(script.findRegex);
    if (!anchor) return { unsafe: true };
    try {
        const regex = compileRegex(script.findRegex);
        if (!(regex instanceof RegExp)) return { unsafe: true };
        regex.lastIndex = 0;
        if (regex.test('')) return { unsafe: true };
        regex.lastIndex = 0;
        return {
            unsafe: false,
            anchor,
            regex,
            placements: new Set(script.placement.map(Number).filter(value => DISPLAY_PLACEMENTS.has(value))),
        };
    } catch {
        return { unsafe: true };
    }
}

function scriptChangedOnlyIn(change, allowedFields) {
    return change.kind === 'changed'
        && change.changedFields.every(field => allowedFields.has(field));
}

function appendMatcher(matchers, script, compileRegex) {
    const matcher = compileMatcher(script, compileRegex);
    if (matcher.unsafe) return false;
    const key = `${script.findRegex}\u0000${[...matcher.placements].join(',')}`;
    if (!matchers.has(key)) matchers.set(key, matcher);
    return true;
}

function addProducerMatchers(matchers, script, snapshot, compileRegex) {
    const anchor = extractRegexAnchor(script.findRegex);
    if (!anchor) return false;
    const key = `${String(script.type)}:${script.id}`;
    const index = snapshot.sequence.indexOf(key);
    if (index <= 0) return true;
    const needle = anchor.toLocaleLowerCase();
    for (const predecessorKey of snapshot.sequence.slice(0, index)) {
        const predecessor = snapshot.entries.get(predecessorKey);
        if (!isDisplayScript(predecessor)) continue;
        if (!String(predecessor.replaceString).toLocaleLowerCase().includes(needle)) continue;
        if (!appendMatcher(matchers, predecessor, compileRegex)) return false;
    }
    return true;
}

export function planRegexRefresh({ before, after, messages = [], compileRegex }) {
    const difference = diffRegexSnapshots(before, after);
    if (difference.reordered || difference.scopeChanged || difference.moved || difference.changes.length > 8) {
        return { mode: 'all', targetIds: [], reason: 'structural-change', difference };
    }

    const matchers = new Map();
    for (const change of difference.changes) {
        if (scriptChangedOnlyIn(change, NON_VISUAL_FIELDS)) continue;
        const previousVisual = isDisplayScript(change.before);
        const nextVisual = isDisplayScript(change.after);
        if (!previousVisual && !nextVisual) continue;
        if (change.kind === 'changed' && !change.changedFields.every(field => PRECISE_FIELDS.has(field) || NON_VISUAL_FIELDS.has(field))) {
            return { mode: 'all', targetIds: [], reason: 'unsafe-field', difference };
        }
        for (const [script, snapshot] of [[change.before, before], [change.after, after]]) {
            if (!isDisplayScript(script)) continue;
            if (!appendMatcher(matchers, script, compileRegex) || !addProducerMatchers(matchers, script, snapshot, compileRegex)) {
                return { mode: 'all', targetIds: [], reason: 'unsafe-pattern', difference };
            }
        }
    }

    if (!matchers.size) return { mode: 'none', targetIds: [], reason: 'non-visual', difference };
    const targetIds = [];
    for (const message of Array.isArray(messages) ? messages : []) {
        const placement = Number(message?.placement);
        const text = String(message?.text || '');
        const affected = [...matchers.values()].some(matcher => {
            if (!matcher.placements.has(placement)) return false;
            matcher.regex.lastIndex = 0;
            const matched = matcher.regex.test(text);
            matcher.regex.lastIndex = 0;
            return matched;
        });
        if (affected) targetIds.push(Number(message.id));
    }
    return { mode: 'matched', targetIds: targetIds.filter(Number.isInteger), reason: 'matched-source', difference };
}

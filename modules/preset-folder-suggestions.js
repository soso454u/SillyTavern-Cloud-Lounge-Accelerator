import { findPresetSections } from './preset-section-boundaries.js';

// Evidence is evaluated only when the user asks for a preview. No requests,
// tokenizer, macro expansion, native mutation or automatic assignment occurs.
const FEATURES = [
    { type: 'style', path: ['文风'], tests: [/叙事风格|文学语言|文风|narrative style|literary (?:style|language)/iu, /句式|修辞|文字节奏|意象|prose|sentence (?:rhythm|structure)|imagery/iu, /语言风格|审美|描写风格|writing style|aesthetic/iu] },
    { type: 'adult', path: ['NSFW'], tests: [/亲密场景|性行为|床戏|性交|色情描写|sexual (?:scene|content|activity)|erotic scene/iu, /性器官|生殖器|genitals?|sexual anatomy/iu, /前戏|性唤起|BDSM|foreplay|arousal|sexual (?:acts?|positions?)/iu] },
    { type: 'tone', path: ['基调'], tests: [/整体氛围|世界氛围|情感基调|overall (?:tone|atmosphere)/iu, /喜剧|悲剧|温暖|压抑|comedy|tragedy|emotional intensity/iu, /关系氛围|情感强度|relationship tone|mood/iu] },
    { type: 'plot', path: ['剧情规则'], tests: [/情节推进|角色行动|世界运行|plot progression|character actions?/iu, /状态延续|因果|时间线|continuity|causality|timeline/iu, /剧情|世界规则|story rules?|world rules?/iu] },
    { type: 'format', path: ['输出与格式'], tests: [/输出格式|格式约束|output format|formatting rules?/iu, /标签|状态栏|JSON|XML|HTML|status (?:bar|panel)|tags?/iu, /必须输出|输出结构|内容结构|必须包含|must (?:output|include)|response structure/iu] },
];
export function semanticSuggestion(prompt) {
    const content = typeof prompt.content === 'string' ? prompt.content : '';
    const scored = FEATURES.map(feature => ({ ...feature, score: feature.tests.filter(test => test.test(content)).length })).sort((a, b) => b.score - a.score);
    if (scored[0].score < 2) return null;
    const style = scored.find(item => item.type === 'style'), adult = scored.find(item => item.type === 'adult');
    if (style.score >= 2 && adult.score >= 2) return { path: ['文风', '成人文风'], reason: '正文同时有文体与亲密描写特征，需要确认；可保留在文风子文件夹', confidence: '混合内容' };
    if (scored[0].score - scored[1].score < 1) return null;
    return { path: scored[0].path, reason: `正文命中 ${scored[0].score} 类功能线索；仅为本地规则建议，请审核`, confidence: '待审核' };
}
export function folderSuggestions(entries, state, kind = 'content') {
    const result = [], sections = findPresetSections(entries);
    for (let index = 0; index < entries.length; index++) {
        const prompt = entries[index];
        if (Object.hasOwn(state.assignments, prompt.identifier)) continue;
        const context = sections.filter(section => section.start <= index && section.end >= index);
        if (kind === 'boundaries') {
            if (context.length) result.push({ id: prompt.identifier, name: prompt.name || prompt.identifier, path: context.map(section => section.name), reason: '原预设的成对区间结构；不代表内容语义结论', confidence: '结构建议' });
        } else {
            const suggestion = semanticSuggestion(prompt);
            if (!suggestion) continue;
            // The author's visible organization is useful context. Never offer
            // to pull an entry out of that path solely for a content keyword.
            if (context.length) suggestion.path = context.map(section => section.name);
            result.push({ id: prompt.identifier, name: prompt.name || prompt.identifier, ...suggestion });
        }
    }
    return result;
}

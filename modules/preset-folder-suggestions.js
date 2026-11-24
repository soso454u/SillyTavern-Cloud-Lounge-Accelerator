// Match distinct signals about what the instruction does. Names, neighboring
// entries and section labels provide no evidence. Weak signals alone never file a rule.
const CATEGORIES = [
    ['基础与身份',
        /你(?:将|要|是|扮演|作为)(?:一名|一个|一位|名为)|你的(?:身份|职责|任务|名字)是|你(?:将)?扮演|你(?:将)?以.{0,12}身份|作为(?:叙事者|主持人|写作助手)|you (?:are|will be|act as) (?:an? |the )|your (?:role|task|identity) is|this is your (?:new )?identity/iu,
        [/身份设定|扮演角色|角色定位|叙事者|游戏主持人|roleplay as|game master|narrator/iu, /你的(?:身份|职责|任务)|必须遵循.*设定|称呼|角色扮演|stay in character|character identity|personality/iu]],
    ['文风',
        /叙事风格|文学语言|文风(?:要求|指南)|写作(?:指南|规则|风格)|(?:语言|文字)质感|语言表达(?:准则|规范)|(?:prose|writing)[_ -]style(?:[_ -]guide)?|writing directive|语言风格|描写风格|叙述视角|叙事视角|narrative (?:style|voice|perspective)|writing style|literary (?:style|language)|point of view/iu,
        [/句式|修辞|文字节奏|语言节奏|意象|比喻|措辞|白描|长短句|语感|prose|sentence (?:rhythm|structure)|imagery|metaphors?/iu, /遣词|用词|文字|文笔|笔触|叙述|细腻|避免.*(?:词语|套话)|word choice|aesthetic|description/iu, /语言|对白|对话|标点|形容词|动词|punctuation|diction|wording|dialogue/iu]],
    ['NSFW',
        /性行为|性爱|做爱|性过程|性描写|性高潮|性姿势|性癖|性互动|成人(?:内容|描写|场景)|床戏|色情(?:内容|描写)|性场景|性交|性器官|性唤起|\bnsfw\b|\bBDSM\b|sexual (?:scenes?|content|activity|anatomy)|explicit sex|erotic scenes?/iu,
        [/亲密(?:场景|互动|行为)|前戏|性欲|性癖|高潮|生殖器|情趣道具|BDSM|foreplay|orgasm|arousal|genitals?/iu, /性描写|感官描写|身体反应|挑逗|情欲|性动作|呻吟|喘息|润滑|sexual (?:acts?|positions?|tension)|sensual|intimacy|kinks?/iu]],
    ['基调',
        /整体(?:氛围|基调)|世界氛围|情感基调|情绪底色|情感底色|(?:^|\n)\s*(?:-\s*)?Tone:\s|营造.{0,10}氛围|基调(?:应|是|为|保持)|overall (?:tone|atmosphere)|emotional tone|establish.{0,16}(?:a mood|an atmosphere)/iu,
        [/喜剧|悲剧|温馨|压抑|comedy|tragedy|emotional intensity/iu, /轻松|沉重|黑暗|幽默|关系氛围|情感强度|mood|relationship tone/iu]],
    ['剧情与世界规则',
        /情节(?:推进|发展)|剧情(?:推进|发展|规则)|推动(?:故事|剧情|情节)|推进(?:故事|剧情|情节)|世界(?:运行|规则|设定|逻辑|遵循)|剧情走向|分支剧情|保持.{0,8}(?:时间线|剧情连贯)|plot (?:progression|development)|advance the (?:story|plot)|world(?:building| rules?)|story continuity/iu,
        [/角色行动|冲突|事件发展|时间线|伏笔|character actions?|timeline|consequences/iu, /状态延续|因果|世界观|NPC|阵营|地理|历史背景|continuity|causality|lore/iu, /场景转换|新场景|推进|支线|结局|事件|previous (?:scene|turn)|plot twist|world state/iu]],
    ['输出与格式',
        /输出(?:格式|结构|模板)|格式(?:约束|要求|模板)|字数(?:限制|要求)|严格遵循以下格式|以.{0,12}(?:格式|标签|代码块)输出|每次(?:正文|回复)(?:结束|结尾)后.{0,20}(?:生成|添加|输出)|(?:output|summary|response) (?:format|template)|formatting (?:rules?|requirements?)|response structure|respond in (?:valid )?(?:json|xml)|must be appended/iu,
        [/(?:状态|信息|属性)栏|标签|代码块|\b(?:JSON|XML|HTML|Markdown)\b|status (?:bar|panel)|tags?/iu, /必须(?:输出|包含)|每次回复(?:末尾|开头)|固定排列|仅输出|must (?:output|include)|end each (?:reply|response)/iu, /<\/\w+[\w:-]*>|固定字段|标题|每[一轮条]|each round|code block/iu]],
    ['其他规则',
        /不要(?:透露|泄露).{0,12}(?:提示词|系统指令)|禁止(?:透露|泄露).{0,12}(?:提示词|系统指令)|禁止(?:歧视|仇恨言论)|(?:禁止|避免|不得)(?:生成|描写|输出)?.{0,4}(?:色情内容|露骨性描写)|(?:avoid|do not (?:include|generate)|prohibit) (?:explicit )?sexual content|内容(?:安全|边界|限制)|(?:不要|避免|禁止)(?:重复表达|词语重复|重复前文|代替用户|替用户)|认知(?:边界|限制)|avoid (?:repetition|repeating)|do not speak for|(?:never|do not) (?:reveal|disclose) .{0,24}(?:instructions|system prompt)|content (?:boundaries|restrictions)/iu,
        [/隐私|未成年人|安全边界|系统指令|privacy|(?:underage|minors)|system instructions/iu, /禁止|避免|不得|拒绝|保密|prohibit|avoid|refuse|confidential/iu]],
];

const ADULT_TOPICS = [
    ['成人描写', /性器官|生殖器|感官描写|体液|身体反应|genitals?|sexual anatomy|physical sensations/iu],
    ['情境与风格', /氛围|情境|情欲|调情|文风|描写风格|atmosphere|sexual tension|flirting|(?:literary|narrative) style/iu],
    ['节奏与动作', /节奏|姿势|前戏|动作|高潮|foreplay|orgasm|pacing|sexual (?:acts?|positions?)/iu],
    ['玩法规则', /性癖|玩法|安全词|同意原则|BDSM|kinks?|safeword|consent rules/iu],
];

const results = new WeakMap();

export function classifyPresetEntry(prompt) {
    const content = typeof prompt.content === 'string' ? prompt.content : '';
    const cached = results.get(prompt);
    if (cached?.content === content && cached.marker === prompt.marker) return cached.path;
    let path = null;
    if (!prompt.marker && content.trim()) {
        const body = content.replace(/<!--[^]*?-->/gu, '');
        const opening = body.slice(0, 450);
        const scored = CATEGORIES.map(([name, strong, weak]) => {
            const evidence = weak.filter(test => test.test(body)).length;
            const primary = strong.test(opening) ? 4 : strong.test(body) ? 3 : 0;
            return { name, score: primary + evidence };
        }).sort((a, b) => b.score - a.score);
        const [best, runnerUp] = scored;
        if (best.score >= 3 && best.score - runnerUp.score >= 2) {
            path = [best.name];
            if (best.name === 'NSFW') {
                const topics = ADULT_TOPICS.filter(([, test]) => test.test(body));
                path.push(topics.length === 1 ? topics[0][0] : '其他');
            }
        }
    }
    results.set(prompt, { content, marker: prompt.marker, path });
    return path;
}

export const PRESET_CATEGORY_ORDER = CATEGORIES.map(([name]) => name);
export const ADULT_CATEGORY_ORDER = [...ADULT_TOPICS.map(([name]) => name), '其他'];

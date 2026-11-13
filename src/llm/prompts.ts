/**
 * Prompts. Keeping them here (rather than inline) makes them reviewable and
 * diffable — a prompt is behaviour, and behaviour deserves version control.
 */

/**
 * Gist extraction. This is the encoding step of fuzzy-trace theory: keep what a
 * person would still remember in three months, drop the rest.
 */
export const GIST_PROMPT = `把下面这段内容压缩成"一个人三个月后还会记住的样子"。

规则：
1. 只保留三个月后仍然有用的信息
2. 丢掉具体措辞、寒暄、过程细节
3. 保留：谁、做了什么决定、为什么、结果
4. 如果是情绪事件，保留情绪和强度
5. 如果只是信息交换，压成一两句话
6. 指代必须消解：把"他/她/它/这个"换成具体的人或物
7. 相对时间必须锚定成绝对日期（今天是 {today}）

只输出 JSON，不要任何其它文字：
{
  "abstract": "<不超过 {maxChars} 字，一句话，直接说结论>",
  "body": "<不超过 200 字，保留必要的上下文>",
  "salience": <1-10 的整数，对这个人有多重要>,
  "future": ["<这条记忆将来可能回答的问题>", "..."],
  "type": "fact | preference | event | skill",
  "emotion": ["<情绪标签，没有就空数组>"]
}

内容：
---
{content}
---`;

/**
 * Reconstruction. Retrieval is not playback: the model re-tells the gist in the
 * light of the current situation, and must say so rather than implying it is
 * quoting. This is also the guard against the drift that comes from treating a
 * summary as a transcript.
 */
export const RECONSTRUCT_PROMPT = `你在回忆一件事。下面是你的记忆要点，不是原话。

当前情境：{situation}

记忆要点：
{abstract}

记忆正文：
{body}

请用一到两句话说明你记得什么。如果要点不足以回答，就直说记不清了。
不要声称这是原话。不要补充要点里没有的信息。`;

/** Consolidation: decide whether a new claim merges into, supersedes, or sits beside an existing one. */
export const CONSOLIDATE_PROMPT = `判断新记忆和已有记忆的关系。

已有记忆：{existing}
新记忆：{incoming}

只输出 JSON：
{"relation": "duplicate | refines | supersedes | unrelated", "reason": "<一句话>"}
`;

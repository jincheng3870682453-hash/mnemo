/**
 * Prospective memory: things you are keeping an eye on.
 *
 * Cognitive science treats "remembering to do something later" as a system
 * separate from recall — triggered by a *time* or an *event*, not by a query.
 * A database never volunteers anything; a person does. This module is the part
 * that lets mnemo volunteer.
 *
 * Intentions are ordinary `MemoryRecord`s with `type: intention` plus two extra
 * fields, so they live in the same store, decay with the same rules, and show up
 * in the same backups.
 *
 *   trigger: time@2026-11-18T09:00
 *   trigger: event@交报告,截稿
 *   status:  pending | done | abandoned
 */
import { daysBetween, parseIso } from '../util/time.js';
export function encodeTrigger(trigger) {
    if (trigger.kind === 'time') {
        if (!trigger.at)
            throw new Error('time trigger requires `at`');
        return `time@${trigger.at}`;
    }
    if (!trigger.keywords || trigger.keywords.length === 0) {
        throw new Error('event trigger requires at least one keyword');
    }
    return `event@${trigger.keywords.map((k) => k.trim()).filter(Boolean).join(',')}`;
}
export function parseTrigger(raw) {
    if (!raw)
        return null;
    const at = raw.indexOf('@');
    if (at <= 0)
        return null;
    const kind = raw.slice(0, at);
    const rest = raw.slice(at + 1).trim();
    if (!rest)
        return null;
    if (kind === 'time')
        return { kind: 'time', at: rest };
    if (kind === 'event') {
        const keywords = rest.split(',').map((k) => k.trim()).filter(Boolean);
        return keywords.length > 0 ? { kind: 'event', keywords } : null;
    }
    return null;
}
export function isPending(record) {
    return record.type === 'intention' && (record.status ?? 'pending') === 'pending' && !record.invalidAt;
}
/** Has the target time arrived? */
export function isDue(record, now) {
    if (!isPending(record))
        return false;
    const trigger = parseTrigger(record.trigger);
    if (!trigger)
        return false;
    if (trigger.kind === 'time') {
        const at = parseIso(trigger.at ?? null);
        return at !== null && at.getTime() <= now.getTime();
    }
    return false;
}
/** Is the target within `withinDays` days from now (including overdue)? */
export function isUpcoming(record, now, withinDays = 14) {
    if (!isPending(record))
        return false;
    const trigger = parseTrigger(record.trigger);
    if (!trigger)
        return false;
    if (trigger.kind === 'time') {
        const at = parseIso(trigger.at ?? null);
        if (!at)
            return false;
        const diff = (at.getTime() - now.getTime()) / 86_400_000;
        return diff <= withinDays;
    }
    return false;
}
/** Does the current context contain one of the event keywords? */
export function matchesEvent(record, contextText) {
    if (!isPending(record))
        return false;
    const trigger = parseTrigger(record.trigger);
    if (!trigger || trigger.kind !== 'event' || !trigger.keywords)
        return false;
    const haystack = contextText.toLowerCase();
    return trigger.keywords.some((k) => haystack.includes(k.toLowerCase()));
}
export function dueIntentions(records, now, contextText = '') {
    return records
        .filter((r) => isDue(r, now) || matchesEvent(r, contextText))
        .sort((a, b) => {
        const ta = parseIso(parseTrigger(a.trigger)?.at ?? null)?.getTime() ?? 0;
        const tb = parseIso(parseTrigger(b.trigger)?.at ?? null)?.getTime() ?? 0;
        return ta - tb;
    });
}
/**
 * Render the resident "things you are keeping an eye on" block.
 *
 * This is intentionally tiny — a handful of lines — but it is the single most
 * human part of the whole system: it is the difference between an assistant that
 * waits to be asked and one that remembers you have a deadline on Tuesday.
 */
export function renderPending(records, now, opts = {}) {
    const withinDays = opts.withinDays ?? 14;
    const limit = opts.limit ?? 5;
    const contextText = opts.contextText ?? '';
    const items = records
        .filter((r) => isUpcoming(r, now, withinDays) || isDue(r, now) || matchesEvent(r, contextText))
        .slice(0, limit);
    if (items.length === 0)
        return '';
    const lines = items.map((r) => {
        const trigger = parseTrigger(r.trigger);
        if (trigger?.kind === 'time' && trigger.at) {
            const at = parseIso(trigger.at);
            if (at) {
                const diff = at.getTime() - now.getTime();
                if (diff < 0) {
                    const overdue = Math.round(daysBetween(at, now));
                    return `- ${r.abstract}（已过期 ${overdue} 天）`;
                }
                const days = Math.max(0, Math.ceil(diff / 86_400_000));
                return days === 0 ? `- ${r.abstract}（今天）` : `- ${r.abstract}（还有 ${days} 天）`;
            }
        }
        return `- ${r.abstract}（等一个时机）`;
    });
    return lines.join('\n');
}
//# sourceMappingURL=intentions.js.map
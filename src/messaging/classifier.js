/**
 * Deterministic Message Classification Module (Non-AI)
 */

const { log } = require("../logger");

const STRICT_BLACKLIST = [
    "חזלש", "חזל\"ש", "שווא", "תרגיל", "יירוט מוצלח", "יורטו", "יורט", 
    "הוסר החשש", "אין סכנה", "נפילה", "שריפה", "נפגעים", "פצועים", 
    "הרוגים", "כשל", "נפל בים", "כטב\"ם", "כטבם", "רחפן", "חדירת כלי טיס"
];

const LAUNCH_WHITELIST = [
    "שיגור", "שיגורים", "ירי", "מטח", "מטחים", "טילים", "רקטות", 
    "בדרך ל", "לעבר", "התרעה", "אזעקה", "התרעות", "הופעלו", "אישור", "דיווח"
];

const SOURCES = ["איראן", "לבנון", "סוריה", "תימן", "עיראק", "עזה"];

const REGION_MAP = [
    { base: "מרכז", aliases: ["מרכז", "גוש דן", "תל אביב", "ת\"א", "הרצליה"] },
    { base: "דרום", aliases: ["דרום", "עוטף", "באר שבע", "ב\"ש", "אשדוד", "אשקלון"] },
    { base: "צפון", aliases: ["צפון", "קריות", "עכו", "נהריה", "צפת", "טבריה", "מירון"] },
    { base: "ירושלים", aliases: ["ירושלים", "י-ם"] },
    { base: "יו\"ש", aliases: ["יו\"ש", "יו״ש", "יהודה ושומרון", "שומרון", "בנימין"] },
    { base: "שרון", aliases: ["שרון", "נתניה", "חדרה"] },
    { base: "שפלה", aliases: ["שפלה", "ראשון לציון", "רחובות", "ראשל\"צ"] },
    { base: "אילת", aliases: ["אילת", "העיר אילת"] },
    { base: "חיפה", aliases: ["חיפה", "מפרץ חיפה"] },
    { base: "ערבה", aliases: ["ערבה"] },
    { base: "נגב", aliases: ["נגב"] },
    { base: "גליל", aliases: ["גליל", "גליל עליון", "גליל מערבי"] },
    { base: "גולן", aliases: ["גולן", "רמת הגולן"] }
];

function mergeAndCleanTargets(oldStr, newStr) {
    const arr1 = (oldStr || "").split(",").map(s => s.trim()).filter(Boolean);
    const arr2 = (newStr || "").split(",").map(s => s.trim()).filter(Boolean);
    let merged = [...new Set([...arr1, ...arr2])];
    
    // סינון כפילויות אגרסיבי: משאיר אזור רק אם הוא לא מוכל באף אזור אחר
    merged = merged.filter(item => {
        return !merged.some(other => other !== item && other.includes(item));
    });
    
    return merged.sort().join(", ");
}

function extractSource(text) {
    for (const src of SOURCES) {
        const regex = new RegExp(`(?<![\\u0590-\\u05FF])(?:מ|מ-|מאזור\\s|מכיוון\\s)?ה?${src}(?![\\u0590-\\u05FF])`);
        if (regex.test(text)) {
            return src;
        }
    }
    return "";
}

function extractTargets(text) {
    const found = [];
    for (const region of REGION_MAP) {
        for (const alias of region.aliases) {
            const safeAlias = alias.replace(/"/g, '["״]');
            const regexStr = `(?<![\\u0590-\\u05FF])(?:ו|ול)?(?:ל|ל-|ב|ב-|לעבר\\s|לאזור\\s|באזור\\s|אזור\\s|לכיוון\\s|אל\\s)*ה?${safeAlias}(?![\\u0590-\\u05FF])(?:\\s*\\([^)]+\\))?`;
            const regex = new RegExp(regexStr);
            const match = text.match(regex);
            
            if (match) {
                const parenMatch = match[0].match(/\(([^)]+)\)/);
                const parenSuffix = parenMatch ? ` (${parenMatch[1]})` : "";
                found.push(region.base + parenSuffix);
                break;
            }
        }
    }
    return mergeAndCleanTargets("", found.join(", "));
}

function extractTime(text) {
    const now = new Date();
    
    const absMatch = text.match(/(?<!\d)([0-1]?[0-9]|2[0-3]):([0-5][0-9])(?!\d)/);
    if (absMatch) {
        return `${absMatch[1].padStart(2, '0')}:${absMatch[2]}`;
    }

    const relMatch = text.match(/(?:בעוד|עוד|בתוך|תוך|יגיעו ב|זמן הגעה)?\s*(?:כ-|-)?(\d+|עשר|חמש|חמישה|רבע|עשרים|חצי)\s*(דקות|שעה)/);
    if (relMatch) {
        let numStr = relMatch[1];
        let unit = relMatch[2];
        let mins = parseInt(numStr);
        
        const numMap = {"עשר": 10, "חמש": 5, "חמישה": 5, "רבע": 15, "עשרים": 20, "חצי": 30};
        if (isNaN(mins)) mins = numMap[numStr] || 0;

        if (unit === "שעה" && numStr === "חצי") mins = 30;
        else if (unit === "שעה" && numStr === "רבע") mins = 15;

        if (mins > 0) {
            now.setMinutes(now.getMinutes() + mins);
            return now.toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
        }
    }
    return "";
}

async function classifyMessage(channelId, messageText, lastPublished) {
    const text = messageText;

    if (STRICT_BLACKLIST.some(word => text.includes(word))) {
        return { category: "IRRELEVANT", reasoning: "Blacklisted keyword.", event_key: "", source: "", target: "", estimated_time: "" };
    }

    const source = extractSource(text);
    const target = extractTargets(text);
    const estimatedTime = extractTime(text);

    const hasLaunchWord = LAUNCH_WHITELIST.some(word => text.includes(word));
    
    if (!hasLaunchWord && !target && !source) {
        if (!(estimatedTime && lastPublished)) {
            return { category: "IRRELEVANT", reasoning: "No launch indicators found.", event_key: "", source: "", target: "", estimated_time: "" };
        }
    }

    if (lastPublished && (lastPublished.source || lastPublished.target)) {
        const isDifferentSource = source && lastPublished.source && source !== lastPublished.source;
        
        if (!isDifferentSource) {
            let mergedTargets = mergeAndCleanTargets(lastPublished.target, target);
            let isNewTarget = target && mergedTargets !== lastPublished.target;
            const isNewTime = estimatedTime && estimatedTime !== lastPublished.estimated_time;

            if (isNewTarget || isNewTime) {
                return {
                    category: "UPDATE_TO_LAST",
                    source: source || lastPublished.source,
                    target: mergedTargets,
                    estimated_time: estimatedTime || lastPublished.estimated_time,
                    reasoning: "New info extracted deterministically.",
                    event_key: `${source || lastPublished.source}->${mergedTargets}`
                };
            }

            if (target === lastPublished.target && (!estimatedTime || estimatedTime === lastPublished.estimated_time)) {
                return { category: "IRRELEVANT", reasoning: "Duplicate info.", event_key: "", source: "", target: "", estimated_time: "" };
            }
        }
    }

    if (target || source) {
        return {
            category: "LAUNCH_REPORT",
            source: source,
            target: target,
            estimated_time: estimatedTime,
            reasoning: "Valid launch parameters extracted.",
            event_key: `${source}->${target}`
        };
    }

    return { category: "IRRELEVANT", reasoning: "Fell through logic.", event_key: "", source: "", target: "", estimated_time: "" };
}

async function checkForNewInfo(newMessages, lastPublished) {
    if (!lastPublished) return { has_new_info: false };

    const combinedText = newMessages.map(m => m.text).join(" | ");
    
    if (STRICT_BLACKLIST.some(word => combinedText.includes(word))) {
        return { has_new_info: false, reasoning: "Blacklisted keyword." };
    }

    const target = extractTargets(combinedText);
    const estimatedTime = extractTime(combinedText);
    const source = extractSource(combinedText);

    // הגנה חזקה: אם המדינה השתנתה, אל תמזג עם האירוע הקודם! שדר מיד כדיווח חדש.
    if (source && lastPublished.source && source !== lastPublished.source) {
        return { 
            has_new_info: true, 
            source: source, 
            target: target, 
            estimated_time: estimatedTime, 
            reasoning: "Different source, cross-event. Treating as new alert." 
        };
    }

    let hasNew = false;
    let finalTarget = lastPublished.target || "";
    let finalTime = lastPublished.estimated_time || "";
    let finalSource = lastPublished.source || "";

    let mergedTargets = mergeAndCleanTargets(finalTarget, target);
    if (target && mergedTargets !== finalTarget) {
        hasNew = true;
        finalTarget = mergedTargets;
    }

    if (estimatedTime && estimatedTime !== finalTime) {
        hasNew = true;
        finalTime = estimatedTime;
    }

    return {
        has_new_info: hasNew,
        source: source || finalSource,
        target: finalTarget,
        estimated_time: finalTime,
        reasoning: hasNew ? "Deterministic logic found new info." : "No new actionable info."
    };
}

module.exports = { classifyMessage, checkForNewInfo };
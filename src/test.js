/**
 * test.js — סקריפט טסט לבדיקת processor + classifier
 * הרצה: node src/test.js
 */

require("dotenv").config();

const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";
const DIM    = "\x1b[2m";

const CH1 = "-1001000000001";
const CH2 = "-1001000000002";

let passed = 0;
let failed = 0;

// המתנה בין בקשות Gemini — free tier מוגבל ל-15/דקה
const API_DELAY = 4500;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function resetState() {
    // פריקת ה-cache של module כדי לאפס state לחלוטין
    delete require.cache[require.resolve("./messaging/processor")];
    delete require.cache[require.resolve("./messaging/classifier")];
}

function getProc() {
    return require("./messaging/processor");
}

function makeCallbacks(proc) {
    let published = false;
    let publishedData = null;

    return {
        async alert(source, target, estimated_time) {
            published = true;
            publishedData = { type: "alert", source, target, estimated_time };
            console.log(`  📤 ALERT: source="${source}" target="${target}" time="${estimated_time}"`);
            // חיוני: מעדכן lastPublished בדיוק כמו index.js
            if (proc) proc.setLastPublished(source, target, estimated_time);
        },
        async update(updatedFields, prevPublished, updateType) {
            published = true;
            publishedData = { type: "update", ...updatedFields, updateType };
            console.log(`  📤 UPDATE (${updateType}): target="${updatedFields.target}" time="${updatedFields.estimated_time}"`);
            if (proc) proc.setLastPublished(
                updatedFields.source || prevPublished.source,
                updatedFields.target || prevPublished.target,
                updatedFields.estimated_time || prevPublished.estimated_time,
            );
        },
        check(shouldPublish) {
            if (shouldPublish === published) {
                console.log(`${GREEN}  ✓ PASS — ${shouldPublish ? "published as expected" : "correctly suppressed"}${RESET}`);
                passed++;
            } else {
                console.log(`${RED}  ✗ FAIL — ${shouldPublish ? "expected publish but nothing sent" : "published but should be suppressed"}${RESET}`);
                failed++;
            }
        },
        checkUpdateType(expected) {
            if (publishedData?.type === "update" && publishedData?.updateType === expected) {
                console.log(`${GREEN}  ✓ PASS — correct update type: ${expected}${RESET}`);
                passed++;
            } else {
                console.log(`${RED}  ✗ FAIL — expected update type "${expected}", got "${publishedData?.updateType}"${RESET}`);
                failed++;
            }
        },
        checkTargetContains(...texts) {
            for (const text of texts) {
                if (publishedData?.target?.includes(text)) {
                    console.log(`${GREEN}  ✓ PASS — target contains "${text}"${RESET}`);
                    passed++;
                } else {
                    console.log(`${RED}  ✗ FAIL — target "${publishedData?.target}" missing "${text}"${RESET}`);
                    failed++;
                }
            }
        },
    };
}

async function runTest(name, fn) {
    resetState();
    console.log(`\n${BOLD}▶ ${name}${RESET}`);
    try {
        await fn();
    } catch (err) {
        console.log(`${RED}  ✗ CRASHED: ${err.message}${RESET}`);
        failed++;
    }
    console.log(`${DIM}  (waiting for rate limit...)${RESET}`);
    await sleep(API_DELAY);
}

async function main() {

    // ── טסט 1: ערוץ אחד בלבד ──
    await runTest("טסט 1 — ערוץ אחד בלבד — לא מפרסם", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור טילים בליסטיים מאיראן לעבר מרכז הארץ", cb);
        cb.check(false);
    });

    // ── טסט 2: שני ערוצים, אותו שיגור ──
    await runTest("טסט 2 — שני ערוצים, אותו שיגור — מפרסם", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור טילים מאיראן לעבר מרכז הארץ", cb);
        await proc.processMessage(CH2, "אישור: שיגור טילים בליסטיים מאיראן, מכוונים למרכז", cb);
        cb.check(true);
    });

    // ── טסט 3: ערוץ 1 שיגור, ערוץ 2 נזק ──
    await runTest("טסט 3 — ערוץ 1 שיגור + ערוץ 2 נזק — לא מפרסם", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור טילים מלבנון לעבר חיפה והצפון", cb);
        await proc.processMessage(CH2, "נזק כבד דווח בחיפה לאחר הפגזות מוקדם יותר הלילה", cb);
        cb.check(false);
    });

    // ── טסט 4: פרסומת ──
    await runTest("טסט 4 — פרסומת — לא מפרסם", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "📢 הצטרפו לערוץ שלנו לעדכונים בזמן אמת! לחצו כאן", cb);
        await proc.processMessage(CH2, "📢 הצטרפו לערוץ שלנו לעדכונים בזמן אמת! לחצו כאן", cb);
        cb.check(false);
    });

    // ── טסט 5: UAV ──
    await runTest("טסט 5 — כטב\"מ/רחפן — לא מפרסם", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "כטב\"מ חשוד זוהה מעל הגליל, כוחות בכוננות", cb);
        await proc.processMessage(CH2, "רחפן עוין זוהה בצפון הארץ, כוחות עוקבים", cb);
        cb.check(false);
    });

    // ── טסט 6: כפילות ──
    // הטסט הזה מחולק לשני שלבים עם reset בין שלב 1 לשלב 2
    await runTest("טסט 6א — פרסום ראשון מצליח", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור טילים מאיראן לעבר מרכז הארץ", cb);
        await proc.processMessage(CH2, "אישור שיגור טילים בליסטיים מאיראן לכיוון מרכז", cb);
        cb.check(true);

        // שלב 2: אותו הדבר שוב — ה-state נשמר (לא עושים reset)
        await sleep(500);
        const cb2 = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור טילים מאיראן לעבר מרכז הארץ", cb2);
        await proc.processMessage(CH2, "אישור שיגור טילים בליסטיים מאיראן לכיוון מרכז", cb2);
        cb2.check(false);
    });

    // ── טסט 7: עדכון יעד ──
    await runTest("טסט 7 — עדכון יעד מערוץ אחד — שולח UPDATE", async () => {
        const proc = getProc();
        const cb1 = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור טילים מאיראן לעבר מרכז הארץ", cb1);
        await proc.processMessage(CH2, "אישור: שיגור מאיראן למרכז", cb1);
        cb1.check(true);

        await sleep(500);
        const cb2 = makeCallbacks(proc);
        await proc.processMessage(CH1, "עדכון: הטילים מכוונים ספציפית לתל אביב ורמת גן", cb2);
        cb2.check(true);
        cb2.checkUpdateType("target");
    });

    // ── טסט 8: עדכון זמן ──
    await runTest("טסט 8 — עדכון זמן הגעה מערוץ אחד — שולח UPDATE", async () => {
        const proc = getProc();
        const cb1 = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור טילים מאיראן לעבר מרכז הארץ", cb1);
        await proc.processMessage(CH2, "אישור שיגור מאיראן", cb1);
        cb1.check(true);

        await sleep(500);
        const cb2 = makeCallbacks(proc);
        await proc.processMessage(CH1, "זמן הגעה משוער: 12 דקות לאזעקות במרכז", cb2);
        cb2.check(true);
        cb2.checkUpdateType("time");
    });

    // ── טסט 9: איחוד יעדים ──
    await runTest("טסט 9 — עדכון יעד מוסיף אזור — target כולל שני אזורים", async () => {
        const proc = getProc();
        const cb1 = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור טילים מאיראן לעבר מרכז הארץ", cb1);
        await proc.processMessage(CH2, "אישור שיגור מאיראן למרכז", cb1);
        cb1.check(true);

        await sleep(500);
        const cb2 = makeCallbacks(proc);
        await proc.processMessage(CH1, "עדכון: הטילים גם מכוונים לצפון הארץ, לא רק למרכז", cb2);
        cb2.check(true);
        cb2.checkTargetContains("מרכז", "צפון");
    });

    // ── טסט 10: דיווח נזק ──
    await runTest("טסט 10 — דיווח נזק אחרי שיגור — לא מפרסם", async () => {
        const proc = getProc();
        const cb1 = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור טילים מאיראן לעבר מרכז הארץ", cb1);
        await proc.processMessage(CH2, "אישור שיגור מאיראן", cb1);
        cb1.check(true);

        await sleep(500);
        const cb2 = makeCallbacks(proc);
        await proc.processMessage(CH1, "נזק כבד דווח בתל אביב, צוותי חירום בשטח", cb2);
        await proc.processMessage(CH2, "פצועים מדווחים ברמת גן לאחר הפגיעה", cb2);
        cb2.check(false);
    });

    // ── טסט 11: לשון עבר ──
    await runTest("טסט 11 — שיגור בלשון עבר — לא מפרסם", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "לפני שעה יוגרו טילים מאיראן לעבר ישראל", cb);
        await proc.processMessage(CH2, "הטיל שיוגר קודם מאיראן נורה בהצלחה", cb);
        cb.check(false);
    });

    // ── טסט 12: שני שיגורים נפרדים ──
    await runTest("טסט 12 — שני שיגורים נפרדים — מפרסם פעמיים", async () => {
        const proc = getProc();
        let alertCount = 0;
        const cb = {
            async alert(source, target) {
                alertCount++;
                console.log(`  📤 ALERT #${alertCount}: source="${source}" target="${target}"`);
            },
            async update() {},
        };

        await proc.processMessage(CH1, "🚨 שיגור טילים מלבנון לעבר הצפון", cb);
        await proc.processMessage(CH2, "אישור: שיגור מלבנון לצפון", cb);
        await sleep(500);
        await proc.processMessage(CH1, "🚨 שיגור נוסף ונפרד: טילים בליסטיים מאיראן לעבר ירושלים", cb);
        await proc.processMessage(CH2, "אישור שיגור מאיראן לכיוון ירושלים ויהודה ושומרון", cb);

        if (alertCount === 2) {
            console.log(`${GREEN}  ✓ PASS — published twice as expected${RESET}`);
            passed++;
        } else {
            console.log(`${RED}  ✗ FAIL — expected 2 publishes, got ${alertCount}${RESET}`);
            failed++;
        }
    });

    // ── סיכום ──
    console.log(`\n${"═".repeat(50)}`);
    console.log(`${BOLD}תוצאות: ${GREEN}${passed} עברו${RESET}${BOLD} | ${RED}${failed} נכשלו${RESET}`);
    console.log(`${"═".repeat(50)}\n`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error("Fatal error:", err);
    process.exit(1);
});
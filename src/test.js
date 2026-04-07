/**
 * THE ENTERPRISE TEST SUITE - 30 Tests
 */

require("dotenv").config(); 
const processor = require("./messaging/processor");

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

const CH1 = "-1001234567890";
const CH2 = "-1000987654321";
const CH3 = "-1005555555555";

function getProc() {
    for (const key of Object.keys(processor.getActiveEvents())) {
        delete processor.getActiveEvents()[key];
    }
    processor.setLastPublished(null, null, null);
    return processor;
}

function makeCallbacks(proc) {
    return {
        publishedData: null,
        publishedUpdate: null,
        async alert(source, target, estimated_time) {
            this.publishedData = { source, target, estimated_time };
            proc.setLastPublished(source, target, estimated_time);
        },
        async update(newData, oldData, updateType) {
            this.publishedUpdate = newData;
            proc.setLastPublished(newData.source, newData.target, newData.estimated_time);
        },
        check(expectedToPublish, alertType = "any") {
            const hasData = this.publishedData !== null;
            const hasUpdate = this.publishedUpdate !== null;
            
            let isSuccess = false;
            if (expectedToPublish) {
                if (alertType === "alert" && hasData) isSuccess = true;
                else if (alertType === "update" && hasUpdate) isSuccess = true;
                else if (alertType === "any" && (hasData || hasUpdate)) isSuccess = true;
            } else {
                if (!hasData && !hasUpdate) isSuccess = true;
            }

            if (isSuccess) {
                console.log(`${GREEN}  ✓ PASS — Publish state correctly resolved (${expectedToPublish ? alertType : 'None'})${RESET}`);
                passed++;
            } else {
                console.log(`${RED}  ✗ FAIL — Expected ${expectedToPublish ? alertType : 'no publish'}, got Alert:${hasData} Update:${hasUpdate}${RESET}`);
                failed++;
            }
        },
        checkData(field, expectedSubstring) {
            const val = this.publishedUpdate?.[field] || this.publishedData?.[field] || "";
            if (val.includes(expectedSubstring)) {
                console.log(`${GREEN}  ✓ PASS — ${field} includes "${expectedSubstring}"${RESET}`);
                passed++;
            } else {
                console.log(`${RED}  ✗ FAIL — ${field} expected to contain "${expectedSubstring}", got "${val}"${RESET}`);
                failed++;
            }
        },
        checkExactData(field, exactString) {
            const val = this.publishedUpdate?.[field] || this.publishedData?.[field] || "";
            if (val === exactString) {
                console.log(`${GREEN}  ✓ PASS — ${field} exactly matches "${exactString}"${RESET}`);
                passed++;
            } else {
                console.log(`${RED}  ✗ FAIL — ${field} expected exact "${exactString}", got "${val}"${RESET}`);
                failed++;
            }
        }
    };
}

async function runTest(name, testFn) {
    console.log(`\n${YELLOW}▶ Running: ${name}${RESET}`);
    try {
        await testFn();
    } catch (err) {
        console.log(`${RED}  ✗ ERROR — Test crashed: ${err.message}${RESET}`);
        failed++;
    }
}

async function main() {
    console.log("Starting ENTERPRISE Test Suite (30 Tests)...\n");

    await runTest("Test 01: Standard Lebanon to North", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור מלבנון לצפון", cb);
        await proc.processMessage(CH2, "אישור ירי מלבנון לצפון", cb);
        cb.check(true, "alert"); cb.checkExactData("source", "לבנון"); cb.checkExactData("target", "צפון");
    });

    await runTest("Test 02: Standard Iran to Center with Exact Time", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 טילים מאיראן למרכז, זמן הגעה 18:30", cb);
        await proc.processMessage(CH2, "מאיראן למרכז ב-18:30", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "מרכז"); cb.checkExactData("estimated_time", "18:30");
    });

    await runTest("Test 03: Multiple Regions (South & Center)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 מעזה לדרום ולמרכז", cb);
        await proc.processMessage(CH2, "ירי מעזה לדרום ומרכז", cb);
        cb.check(true, "alert"); cb.checkExactData("source", "עזה"); cb.checkExactData("target", "דרום, מרכז");
    });

    await runTest("Test 04: City to Region (אשדוד -> דרום)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 רקטות לאשדוד", cb); await proc.processMessage(CH2, "רקטות לאשדוד", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "דרום");
    });

    await runTest("Test 05: City to Region (ראשל\"צ -> שפלה)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 לראשל\"צ", cb); await proc.processMessage(CH2, "לראשל\"צ", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "שפלה");
    });

    await runTest("Test 06: City to Region (בנימין -> יו\"ש)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 לבנימין", cb); await proc.processMessage(CH2, "ירי לבנימין", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "יו\"ש");
    });

    await runTest("Test 07: Slang Abbreviation (י-ם -> ירושלים)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 לי-ם", cb); await proc.processMessage(CH2, "ירי לי-ם", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "ירושלים");
    });

    await runTest("Test 08: Duplicate Overlapping Cities (אשדוד ואשקלון -> דרום)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 לאשדוד ולאשקלון", cb); await proc.processMessage(CH2, "לאשדוד ואשקלון", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "דרום"); 
    });

    await runTest("Test 09: Tricky Source Prefixes (מאזור, מכיוון)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 ירי מכיוון תימן", cb); await proc.processMessage(CH2, "מאזור תימן", cb);
        cb.check(true, "alert"); cb.checkExactData("source", "תימן");
    });

    await runTest("Test 10: Tricky Target Prefixes (ולעבר אזור ה...)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 ולעבר אזור השרון", cb); await proc.processMessage(CH2, "אל השרון", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "שרון");
    });

    await runTest("Test 11: Relative Time (בעוד 10 דקות)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 יגיעו בעוד 10 דקות למרכז", cb); await proc.processMessage(CH2, "למרכז תוך 10 דקות", cb);
        cb.check(true, "alert"); 
        if(cb.publishedData?.estimated_time) { passed++; console.log(`${GREEN}  ✓ PASS — Calculated time: ${cb.publishedData.estimated_time}${RESET}`); } else { failed++; console.log(`${RED}  ✗ FAIL — Missing time${RESET}`); }
    });

    await runTest("Test 12: Relative Time Text (עוד חצי שעה)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 עוד חצי שעה באילת", cb); await proc.processMessage(CH2, "בעוד חצי שעה לאילת", cb);
        cb.check(true, "alert");
        if(cb.publishedData?.estimated_time) { passed++; console.log(`${GREEN}  ✓ PASS — Calculated time: ${cb.publishedData.estimated_time}${RESET}`); } else { failed++; console.log(`${RED}  ✗ FAIL — Missing time${RESET}`); }
    });

    await runTest("Test 13: Relative Time Text (בתוך עשרים דקות)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 בתוך עשרים דקות לשפלה", cb); await proc.processMessage(CH2, "זמן הגעה עשרים דקות לשפלה", cb);
        cb.check(true, "alert");
        if(cb.publishedData?.estimated_time) { passed++; console.log(`${GREEN}  ✓ PASS — Calculated time: ${cb.publishedData.estimated_time}${RESET}`); } else { failed++; console.log(`${RED}  ✗ FAIL — Missing time${RESET}`); }
    });

    await runTest("Test 14: Messy Formatting (Newlines & Emojis)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨🚨🚨\nירי מאיראן!!!\nלעבר המרכז 📍\nבדרך", cb);
        await proc.processMessage(CH2, "מאיראן למרכז!", cb);
        cb.check(true, "alert"); cb.checkExactData("source", "איראן"); cb.checkExactData("target", "מרכז");
    });

    await runTest("Test 15: Punctuation attached to word (לחיפה.)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 לחיפה.", cb); await proc.processMessage(CH2, "ירי לחיפה!", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "חיפה");
    });

    await runTest("Test 16: Interception Report (יירוט מוצלח)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "יירוט מוצלח מעל המרכז", cb); cb.check(false);
    });

    await runTest("Test 17: UAV/Drone filter (כטב\"ם)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "חדירת כלי טיס עוין / כטב\"ם בצפון", cb); cb.check(false);
    });

    await runTest("Test 18: Cancellation / Hazlash (שווא)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "דיווח על ירי - מדובר בזיהוי שווא", cb); cb.check(false);
    });

    await runTest("Test 19: Pure Chatter", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "בוקר טוב עוקבים יקרים", cb); cb.check(false);
    });

    await runTest("Test 20: Fake Update (Identical target, different wording)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 איראן למרכז ודרום", cb); await proc.processMessage(CH2, "איראן למרכז דרום", cb);
        cb.publishedData = null; // reset
        await proc.processMessage(CH3, "עדכון: הטילים לדרום ולמרכז", cb);
        cb.check(false); // MUST block
    });

    await runTest("Test 21: Real Target Update (Adding region)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 איראן למרכז", cb); await proc.processMessage(CH2, "איראן למרכז", cb);
        cb.publishedData = null;
        await proc.processMessage(CH3, "הטווח הורחב, אזעקות גם בדרום", cb);
        cb.check(true, "update"); cb.checkExactData("target", "דרום, מרכז");
    });

    await runTest("Test 22: Real Time Update", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 איראן למרכז", cb); await proc.processMessage(CH2, "איראן למרכז", cb);
        cb.publishedData = null;
        await proc.processMessage(CH3, "יגיעו ב-22:15", cb);
        cb.check(true, "update"); cb.checkExactData("estimated_time", "22:15");
    });

    await runTest("Test 23: Parallel Events (Lebanon -> North, Iran -> Center)", async () => {
        const proc = getProc(); const cbLeb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 מלבנון לצפון", cbLeb); await proc.processMessage(CH2, "מלבנון לצפון", cbLeb);
        cbLeb.check(true, "alert");

        const cbIran = makeCallbacks(proc);
        await proc.processMessage(CH2, "🚨 מאיראן למרכז", cbIran); await proc.processMessage(CH3, "איראן למרכז", cbIran);
        cbIran.check(true, "alert"); cbIran.checkExactData("source", "איראן"); cbIran.checkExactData("target", "מרכז");
    });

    await runTest("Test 24: Regression - Parentheses Subsumption (מרכז (שפלה))", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 למרכז (שפלה) ושפלה", cb); await proc.processMessage(CH2, "למרכז (שפלה)", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "מרכז (שפלה)"); 
    });

    await runTest("Test 25: Regression - The 'ב' prefix (אזעקות במרכז)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 אזעקות במרכז", cb); await proc.processMessage(CH2, "במרכז", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "מרכז");
    });

    await runTest("Test 26: Missing Target (Source only)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 שיגור מתימן", cb); await proc.processMessage(CH2, "ירי מתימן", cb);
        cb.check(true, "alert"); cb.checkExactData("source", "תימן"); cb.checkExactData("target", "");
    });

    await runTest("Test 27: Missing Source (Target only)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 ירי לנגב", cb); await proc.processMessage(CH2, "לנגב", cb);
        cb.check(true, "alert"); cb.checkExactData("source", ""); cb.checkExactData("target", "נגב");
    });

    await runTest("Test 28: Target Eilat (Edge Region)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 לאילת", cb); await proc.processMessage(CH2, "לאילת", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "אילת");
    });

    await runTest("Test 29: Target Golan (Edge Region)", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨 ירי לרמת הגולן", cb); await proc.processMessage(CH2, "לגולן", cb);
        cb.check(true, "alert"); cb.checkExactData("target", "גולן");
    });

    await runTest("Test 30: The 'Everything Everywhere' Test", async () => {
        const proc = getProc(); const cb = makeCallbacks(proc);
        await proc.processMessage(CH1, "🚨🚨🚨 דיווח ראשוני!!!\nמאזור איראן ומעיראק לעבר אזור המרכז (שפלה), אשדוד, וי-ם!\nזמן הגעה: 23:59. t.me/news", cb);
        await proc.processMessage(CH2, "מאיראן שפלה אשדוד וירושלים ב-23:59", cb);
        cb.check(true, "alert");
        cb.checkData("source", "איראן"); 
        cb.checkExactData("target", "דרום, ירושלים, מרכז (שפלה)");
        cb.checkExactData("estimated_time", "23:59");
    });

    console.log(`\n===========================================`);
    console.log(`     ENTERPRISE TEST SUITE SUMMARY         `);
    console.log(`===========================================`);
    console.log(`${GREEN}  PASSED: ${passed}${RESET}`);
    if (failed > 0) {
        console.log(`${RED}  FAILED: ${failed}${RESET}`);
    } else {
        console.log(`${GREEN}  ALL 30 TESTS PASSED PERFECTLY! 🚀🛡️🏆${RESET}`);
    }
    process.exit(failed > 0 ? 1 : 0);
}

main();
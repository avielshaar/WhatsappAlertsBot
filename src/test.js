/**
 * Test Suite for WhatsappAlertsBot
 */

require("dotenv").config(); 
const processor = require("./messaging/processor");

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const RESET = '\x1b[0m';

let passed = 0;
let failed = 0;

const CH1 = "-1001234567890";
const CH2 = "-1000987654321";

function getProc() {
    for (const key of Object.keys(processor.getActiveEvents())) {
        delete processor.getActiveEvents()[key];
    }
    // Correctly nullify the state
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
        check(expectedToPublish) {
            if (expectedToPublish && (this.publishedData || this.publishedUpdate)) {
                console.log(`${GREEN}  ✓ PASS — Alert/Update was published${RESET}`);
                passed++;
            } else if (!expectedToPublish && !this.publishedData && !this.publishedUpdate) {
                console.log(`${GREEN}  ✓ PASS — Alert was NOT published (Expected)${RESET}`);
                passed++;
            } else {
                console.log(`${RED}  ✗ FAIL — Publish state mismatch${RESET}`);
                failed++;
            }
        },
        checkTargetContains(...targets) {
            const targetStr = this.publishedUpdate?.target || this.publishedData?.target || "";
            for (const t of targets) {
                if (targetStr.includes(t)) {
                    console.log(`${GREEN}  ✓ PASS — Target includes "${t}"${RESET}`);
                    passed++;
                } else {
                    console.log(`${RED}  ✗ FAIL — Target missing "${t}" in "${targetStr}"${RESET}`);
                    failed++;
                }
            }
        }
    };
}

async function runTest(name, testFn) {
    console.log(`\n▶ Running: ${name}`);
    try {
        await testFn();
    } catch (err) {
        console.log(`${RED}  ✗ ERROR — Test crashed: ${err.message}${RESET}`);
        failed++;
    }
}

async function main() {
    console.log("Starting test suite...\n");

    // ── Test 13: Smart Target Merging ──
    await runTest("Test 13: Smart Target Merging (Prevent string duplication)", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        
        await proc.processMessage(CH1, "🚨 שיגורים מאיראן לעבר מרכז (שפלה)", cb);
        await proc.processMessage(CH2, "אישור: טילים מאיראן למרכז-דרום", cb);
        
        cb.check(true);
        cb.checkTargetContains("מרכז (שפלה)", "דרום");
        
        const targetString = cb.publishedData?.target || "";
        const centerCount = (targetString.match(/מרכז/g) || []).length;
        if (centerCount === 1) {
            console.log(`${GREEN}  ✓ PASS — 'מרכז' appears only once in: ${targetString}${RESET}`);
            passed++;
        } else {
            console.log(`${RED}  ✗ FAIL — 'מרכז' appears ${centerCount} times in "${targetString}"${RESET}`);
            failed++;
        }
    });

    // ── Test 14: AI Hallucination Filter ──
    await runTest("Test 14: AI Hallucination Filter (Fake update)", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        
        await proc.processMessage(CH1, "🚨 שיגור טילים מאיראן לעבר המרכז והדרום", cb);
        await proc.processMessage(CH2, "אישור מאיראן למרכז ודרום", cb);
        
        // Reset callbacks to listen for updates
        cb.publishedData = null;
        cb.publishedUpdate = null;

        // This is rephrased with filler words. Processor should block it.
        await proc.processMessage(CH1, "עדכון: הטילים בדרכם לאזור המרכז, וגם לדרום", cb);
        
        cb.check(false); // Expecting NO UPDATE
    });

    // ── Test 15: Absolute Time Formatting Check ──
    await runTest("Test 15: Absolute Time Formatting Check", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        
        await proc.processMessage(CH1, "🚨 טילים מתימן, יגיעו בעוד 10 דקות לאילת", cb);
        await proc.processMessage(CH2, "אישור שיגור מתימן לאילת, זמן הגעה משוער עשר דקות", cb);
        
        cb.check(true);
        
        const timeVal = cb.publishedData?.estimated_time || "";
        const timeFormatRegex = /^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$/; 
        
        if (timeFormatRegex.test(timeVal)) {
            console.log(`${GREEN}  ✓ PASS — Time formatted correctly as absolute: ${timeVal}${RESET}`);
            passed++;
        } else {
            console.log(`${RED}  ✗ FAIL — Time format is incorrect: "${timeVal}"${RESET}`);
            failed++;
        }
    });

    // ── Test 16: Legitimate Target Expansion Update ──
    await runTest("Test 16: Legitimate Target Expansion Update", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        
        await proc.processMessage(CH1, "🚨 שיגור טילים מלבנון למרכז", cb);
        await proc.processMessage(CH2, "אישור מאיראן למרכז", cb);
        
        cb.publishedData = null;
        
        // Now an update comes adding a new region
        await proc.processMessage(CH1, "עדכון: הטילים מלבנון מכוונים גם לדרום ולשפלה", cb);
        
        cb.check(true);
        cb.checkTargetContains("דרום");
    });

    // ── Test 17: Time-Only Update ──
    await runTest("Test 17: Time-Only Update", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        
        await proc.processMessage(CH1, "🚨 טילים מאיראן למרכז", cb);
        await proc.processMessage(CH2, "אישור שיגור מאיראן למרכז", cb);
        
        cb.publishedData = null;
        cb.publishedUpdate = null;
        
        // Target is the same, but time is added
        await proc.processMessage(CH1, "עדכון מזמן: הטילים מאיראן למרכז יגיעו ב-18:30", cb);
        
        cb.check(true); // Expecting UPDATE
        const timeVal = cb.publishedUpdate?.estimated_time || "";
        if (timeVal === "18:30") {
            console.log(`${GREEN}  ✓ PASS — Time update caught correctly: ${timeVal}${RESET}`);
            passed++;
        } else {
            console.log(`${RED}  ✗ FAIL — Time update failed: "${timeVal}"${RESET}`);
            failed++;
        }
    });

    // ── Test 18: Instant Spam Rejection ──
    await runTest("Test 18: Instant Spam Regex Rejection", async () => {
        const proc = getProc();
        const cb = makeCallbacks(proc);
        
        // This shouldn't even trigger the AI
        await proc.processMessage(CH1, "להצטרפות לערוץ הדיווחים לחצו כאן: t.me/fakechannel", cb);
        
        cb.check(false);
    });

    console.log(`\n=== SUMMARY ===`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    process.exit(failed > 0 ? 1 : 0);
}

main();
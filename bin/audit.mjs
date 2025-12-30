#!/usr/bin/env node

/**
 * @fileoverview Main code for Audit
 * @author Hongji Dai
 * @date 2025/12/27
 * @version 1.0.0
 */

import {chromium} from "playwright";
import {parseArgs} from "node:util";
import * as readlinePromises from "node:readline/promises";

//Return value of Audit
//0 = No error
//1 = Minor error (program can still run)
// Ex. 1 broken url found
//2 = Major error (program terminates)
// Ex. Unknown flags
let errno = 0;

//Booleans for flags
let isHeadless = false;
let isContinuous = false;
let isVerbose = false;


//Log specifics in verbose mode
function verboseLog(isVerbose, err) {
    if (isVerbose) {
        console.error(`Verbose: ${err.message}`);
    }
}

//TODO: Implement
function output(filename) {

}

//TODO: Implement
function format(res, isHuman, isPretty) {

}

//TODO: Implement
function pretty(line) {

}

//TODO: Implement
function recursiveBrowse() {

}


//Open the requested page
async function browse(userURL) {
    const browser = await chromium.launch({
        headless: isHeadless,
    });

    //Wait until page finishes loading
    //TODO: Add logic to handle page load error
    const page = await browser.newPage();
    await page.goto(userURL, {waitUntil: "networkidle"});

    //Get JS heap mem of page
    //Returns an object with JSHeapUsedSize and usedJSHeapSize
    async function getMem() {
        const client = await page.context().newCDPSession(page);

        // Enable the Performance domain
        await client.send("Performance.enable");

        // Fetch the metrics
        const {metrics} = await client.send("Performance.getMetrics");

        const memUsed = metrics.find(
                                m => m.name === "JSHeapUsedSize"
                            ).value;

        const memSize = metrics.find(
                                m => m.name === "JSHeapTotalSize"
                            ).value;

        return {memUsed, memSize};
    }

    const mem = await getMem();

    //Evaluation inside browser
    let res = await page.evaluate(async () => {

        const result = {
            totalWC: 0,
            retMsg: "Connection Success"
        };

        //Word count helper
        function wc(text) {
            // \s+ matches >=1 whitespace
            const len = text.trim().split(/\s+/)
                        .filter(word => word.length > 0).length;
            console.log(text.trim());
            return len;
        }


        //Helper for walking DOM tree
        async function walk() {
            //https://dev.to/k_ivanow/treewalker-a-practical-guide-to-dom-traversal-hn6
            const walker = document.createTreeWalker(
                document.body, // Root node to start traversal
                NodeFilter.SHOW_TEXT, // Only show text nodes
                {
                    acceptNode: function(node) {
                        //Ignore certain tags
                        const ignoreTag = [
                            "SCRIPT",
                            "STYLE",
                            "NOSCRIPT",
                            "SVG",
                            "CANVAS"
                        ];

                        //Only accept text nodes that aren't empty
                        //Check has a parent first
                        const ret = node.parentElement
                            && !ignoreTag.includes(
                                node.parentElement.tagName
                            )
                            && node.textContent.trim().length > 0
                            ? NodeFilter.FILTER_ACCEPT
                            : NodeFilter.FILTER_REJECT;

                        return ret;
                    }
                }
            );

            let node;
            while ((node = walker.nextNode()) !== null) {
                result.totalWC += wc(node.textContent);
            }

        }

        await walk();

        return result;
    });

    res = {...res, ...mem};
    console.log(res);
    await browser.close();
}

//Continuous Mode
async function input() {
    const rl = readlinePromises.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    function isValidURL(userURL) {
        try {
            new URL(userURL);
            return true;
        } catch(err) {
            errno = 1;
            console.error("Error: Invalid URL");


            return false;
        }
    }

    const stopWords = ["stop", "exit", "quit", "end"];

    while (true) {
        let userURL = await rl.question("Enter URL (https://example.com)\n");

        userURL = userURL.trim();

        //Stops loop
        if (stopWords.includes(userURL.toLowerCase())) {
            break;
        }

        if (isValidURL(userURL)) {
            console.log(`Launching ${userURL}!`);
            await browse(userURL);
        }
    }
    rl.close();
    console.log("Exiting Audit.");
}

//Flags
//--help
// Show instructions and flags for Audit
//--version
// Show Audit version
//--blame
// Blame the guy that wrote this with a randomized insult
//-h, --headless
// Run Audit in headless mode (no browser window)
//-c --continuous
// Long running mode. Audit accepts url input until terminated
//-v --verbose
// More detailed output
//-o --output
// Logs output to a specified file
//-f --format
// Logs output in human readable format
//-p --pretty
// Logs output with colored lines
// Green = Non-bloated sites
// Red = Bloated sites
//-r --recursive
// Samples the site up to a specified number of times
// Ex. audit -r 5 en.wikipedia.org 
// will try to sample up to 5 pages from the URLs provided
// and calculate by averaging the memory size/word
//-b --baseline
// Manually set a baseline memory size/word for Audit to compare to
//-w --wait
// Set the max amount of time in ms Audit should wait for a page to load
// before measuring memory usage
//-s --scroll
// Audit will attempt to scroll down a page to trigger lazy loading sites
// Useful for pages with infinite scrolling

const config = {
    options: {
        help: {
            type: "boolean",
            default: false,
        },
        version: {
            type: "boolean",
            default: false,
        },
        blame: {
            type: "boolean",
            default: false,
        },
        headless: {
            type: "boolean",
            short: "h",
            default: false,
        },
        continuous: {
            type: "boolean",
            short: "c",
            default: false,
        },
        verbose: {
            type: "boolean",
            short: "v",
            default: false,
        },
        output: {
            type: "string",
            short: "o",
            default: "log.txt",
        },
        format: {
            type: "boolean",
            short: "f",
            default: false,
        },
        pretty: {
            type: "boolean",
            short: "p",
            default: false,
        },
        recursive: {
            type: "string",
            short: "r",
        },
        baseline: {
            type: "string",
            short: "b",
        },
        wait: {
            type: "string",
            short: "w",
        },
        scroll: {
            type: "boolean",
            short: "s",
            default: false,
        },
    },
    allowPositionals: true
};



//Main function to loop over urls
//TODO: Implement
function processURLs(urls) {
    //Sanity check
    if (urls.length === 0) {
        errno = 2;
        throw new Error("No urls provided!");
    }

    //Loop
    for (const url of urls) {

    }
}

try {
    //Positionals should be urls
    const {values, positionals} = parseArgs(config);

    //--help
    //TODO: add text
    if (values.help) {
        console.log("Audit help");
        process.exit(errno);
    }

    //Setting values for flags
    isHeadless = values.headless;
    isContinuous = values.continuous;
    isVerbose = values.verbose;

    //TODO: add text
    if (isContinuous) {
        console.log("Audit is running in continuous mode!");
        await input();
    } else {
        processURLs(positionals);
    }

} catch (err) {
    errno = 2;
    console.error(`Error: ${err.message}`);
}

process.exit(errno);




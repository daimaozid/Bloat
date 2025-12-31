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

//Values for options
let isHeadless = false;
let isContinuous = false;
let isVerbose = false;
let isFormat = false;
let isPretty = false;
let recursionLevel = 0; //--recursive
let baseline = 0; //--baseline
let isBaselineSpecified = false;
let waitMS = 30000; //--wait
let isWaitSpecified = false;
let decPlaces = 3; //--decimal
let isDecPlaceSpecified = false; //--decimal

//Object for list of results
const results = {
    list: [],
    avgMem: 0,
};

//Log specifics in verbose mode
function verboseLog(isVerbose, err, msg) {
    if (isVerbose) {
        //Seperate normal logs from error logs
        //err is an Error object
        //if err, ignore msg
        if (err) {
            console.error(`Verbose: ${err.message}`);
        } else {
            console.log(`Verbose: ${msg}`);
        }

        //TODO: Color lines in --pretty
    }
}

//TODO: Implement
function output(filename) {

}

//Function to truncate URL
//Removes https:// and everything after domain
function truncURL(userURL) {

}

//Helper to determine unit
function formatUnit(mem, isFormat) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const base = 1024; //Binary units constant

    //Log base change to get appropriate unit
    let index = Math.floor(Math.log(mem) / Math.log(base)); 

    //If index > units.length, use the largest unit
    if (index > units.length) {
        index = units.length - 1;
    }

    //Human mode always rounds to nearest integer
    //unless --decimal is specified
    if (!isDecPlaceSpecified && isFormat) {
        decPlaces = 0;
    }

    const outputMem = (mem / Math.pow(base, index)).toFixed(decPlaces);

    //~Mem Unit
    return `${isFormat ? "~" : ""}${outputMem} ${units[index]}/Word`;
}

//TODO: Implement
function format(res, isFormat, isPretty) {
    //Format output
    if (isFormat) {
        //Human format would look something like:
        //Logged on: Day Month Date Year XX:YY:ZZ Timezone
        //Avg Mem/Word: ~X UNIT/Word
        //URL List          Mem/Word         Bloated?
        //en.wikipedia.org  ~X UNIT/Word     No
        //youtube.com       ~X UNIT/Word     Yes
        //...
        //# of bloated sites = A
        //# of good sites = B
        //Length of URL column is max(AUDIT_URL_LEN, urlLen)
        //Default is 32 chars
        //Similar logic applies for mem/word
        //Default for mem/word is 16 chars
        //Bloated is 8 chars
        //Ignores slugs and only displays the subdomain
        //UNIT is automatically converted to the neatest unit
        //Always in binary units (KiB, MiB, GiB, etc.)

        //TIME
        const date = new Date().toString();
        console.log("Logged on:", date);

        //Avg Mem
        //TODO: Add memoization 
        res.avgMem = res.list.reduce((sum, r) => {
            //Avoid NaN
            r.totalWC = r.totalWC || 1;
            return sum += r.memSize / r.totalWC;
        }, 0) / res.list.length;
        console.log("Avg Mem/Word:", formatUnit(res.avgMem, isFormat));

        if(!isBaselineSpecified) {
            baseline = res.avgMem;
        }

        let urlCol = "URL List";
        let memCol = "Mem/Word";
        let bloatCol = "Bloated?";
        let numBloated = 0;

        //TODO: Add options to change col width settings

        //Headers
            console.log(`${urlCol.padEnd(32)}${memCol.padEnd(16)}${bloatCol.padEnd(8)}`);

        for (const r of res.list) {
            //TODO: Truncate URL
            urlCol = r.userURL;

            //Avoid NaN
            r.totalWC = r.totalWC || 1;

            //TODO: Add verbose log for r.memUsed / r.totalWC
            memCol = formatUnit(r.memSize / r.totalWC, isFormat);
            bloatCol = "No";
            if (r.memSize / r.totalWC > baseline) {
                bloatCol = "Yes";
                numBloated++;
            }

            console.log(`${urlCol.padEnd(32)}${memCol.padEnd(16)}${bloatCol.padEnd(8)}`);
        }

        //Num of bloated sites
        console.log(`# of bloated sites: ${numBloated}`);
        console.log(`# of good sites: ${res.list.length - numBloated}`);

    } else {
        //Non human mode simply prints URL + formatted Mem/Word
        for (const r of res.list) {
            console.log(`${r.userURL} ${formatUnit(r.memSize / r.totalWC)}`);
        }
    }
}

//TODO: Implement
function pretty(line) {

}

//Open the requested page
async function browse(userURL, recursionLevel) {
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

    res = {...res, ...mem, userURL};
    results.list.push(res);

    // if (res.totalWC !== 0) {
        // const usedMemPerWord = (res.memUsed / res.totalWC).toFixed(decPlaces);
        // const allocatedMemPerWord = (res.memSize / res.totalWC).toFixed(decPlaces);
        // console.log(`Used memory/Word: ${usedMemPerWord}`);
        // console.log(`Allocated memory/Word: ${allocatedMemPerWord}`);
    // }


    await browser.close();
}

//Helper to check URL
function isValidURL(userURL) {
    try {
        new URL(userURL);
        return true;
    } catch(err) {
        errno = 1;
        return false;
    }
}

//Continuous Mode
async function input() {
    const rl = readlinePromises.createInterface({
        input: process.stdin,
        output: process.stdout,
    });


    const stopWords = ["q", "stop", "exit", "quit", "end"];

    while (true) {
        let userURL = await rl.question("Enter URL (https://example.com)\n");

        userURL = userURL.trim();

        //Stops loop
        if (stopWords.includes(userURL.toLowerCase())) {
            break;
        }

        if (isValidURL(userURL)) {
            verboseLog(isVerbose, null, `Launching ${userURL}!`);
            await browse(userURL, recursionLevel);
            format(results, isFormat, isPretty);
        } else {
            console.error("Error: Invalid URL");
        }
    }
    rl.close();
    console.log("Exiting Audit.");
}

//Audit: Test RAM usage of websites!
//Flags
//--help
// Show instructions and flags for Audit
//--version
// Show Audit version
//--blame
// Blame the guy that wrote this with a randomized insult
//--update
// Check for updates and update Audit if needed
//--reset
// Clear the log file for Audit
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
//-d --decimal
// Change number of decimal places for output
// Default is 3

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
        update: {
            type: "boolean",
            default: false,
        },
        reset: {
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
        decimal: {
            type: "string",
            short: "d",
        },
    },
    allowPositionals: true
};



//Main function to loop over urls
async function processURLs(urls) {
    //Sanity check
    if (urls.length === 0) {
        errno = 2;
        throw new Error("No urls provided!");
    }

    //Loop
    for (const userURL of urls) {
        if (isValidURL(userURL)) {
            verboseLog(isVerbose, null, `Launching ${userURL}!`);
            await browse(userURL, recursionLevel);
        } else {
            console.error("Error: Invalid URL");
        }
    }
}

try {
    //Positionals should be urls
    const {values, positionals} = parseArgs(config);

    //--help
    //TODO: add text
    if (values.help) {
        //Ignore the weird format, JS template literals
        const helpMsg = 
        `Audit: Test RAM usage of websites!
    Flags
    --help
    Show instructions and flags for Audit
    --version
    Show Audit version
    --blame
    Blame the guy that wrote this with a randomized insult
    --update
    Check for updates and update Audit if needed
    --reset
    Clear the log file for Audit
    -h, --headless
    Run Audit in headless mode (no browser window)
    -c --continuous
    Long running mode. Audit accepts url input until terminated
    -v --verbose
    More detailed output
    -o --output
    Logs output to a specified file
    -f --format
    Logs output in human readable format
    -p --pretty
    Logs output with colored lines
    Green = Non-bloated sites
    Red = Bloated sites
    -r --recursive
    Samples the site up to a specified number of times
    Ex. audit -r 5 en.wikipedia.org 
    will try to sample up to 5 pages from the URLs provided
    and calculate by averaging the memory size/word
    -b --baseline
    Manually set a baseline memory size/word for Audit to compare to
    -w --wait
    Set the max amount of time in ms Audit should wait for a page to load
    before measuring memory usage
    -s --scroll
    Audit will attempt to scroll down a page to trigger lazy loading sites
    Useful for pages with infinite scrolling
    -d --decimal
    Change number of decimal places for output
    Default is 3`;
        console.log(helpMsg);
        process.exit(errno);
    }

    //--version
    //TODO: Implement
    if (values.version) {
        console.log("Audit version");
        process.exit(errno);
    }

    //--blame
    //TODO: Implement
    if (values.blame) {
        console.log("Something rude :(");
        process.exit(errno);
    }

    //--reset
    //TODO: Implement
    if (values.reset) {
        console.log("Audit reset");
        process.exit(errno);
    }

    //--update
    //TODO: Implement
    if (values.update) {
        console.log("Audit update");
        process.exit(errno);
    }

    //Setting values for flags
    //Setting them explicitly instead of dereferencing
    //Because I think it's better semantics
    //Also because recursionLevel and others require parseInt
    isHeadless = values.headless;
    isContinuous = values.continuous;
    isVerbose = values.verbose;
    isFormat = values.format;
    isPretty = values.pretty;
    recursionLevel = parseInt(values.recursion);
    if(values.baseline) {
        baseline = parseInt(values.baseline);
        isBaselineSpecified = true;
    }
    if(values.waitMS) {
        waitMS = parseInt(values.waitMS);
        isWaitSpecified = true;
    }
    if(values.decimal) {
        decPlaces = parseInt(values.decimal);
        isDecPlaceSpecified = true;
    }


    //TODO: add text
    if (isContinuous) {
        console.log("Audit is running in continuous mode!");
        await input();
    } else {
        await processURLs(positionals);
        format(results, isFormat, isPretty);
    }

} catch (err) {
    errno = 2;
    console.error(`Error: ${err.message}`);
}

process.exit(errno);




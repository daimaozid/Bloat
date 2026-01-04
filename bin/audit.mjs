#!/usr/bin/env node

/**
 * @fileoverview Main code for Audit
 * @author Hongji Dai
 * @date 2025/12/27
 * @version 1.0.0
 */

import {chromium} from "playwright";
import {parseArgs, styleText} from "node:util";
import { createInterface } from 'node:readline/promises';

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
let isSorted = true;
let recursionLevel = 0; //--recursive
let baseline = 0; //--baseline
let isBaselineSpecified = false;
let waitMS = 30000; //--wait
let decPlaces = 3; //--decimal
let isDecPlaceSpecified = false; //--decimal

//Object for list of results
const results = {
    list: [],
    avgMem: 0,
    oldLen: 0, //Old length of list used for memoization
};

//Makes a string pretty for logging in console
//Reject Chalk, return to Node:Util
function pretty(str, type) {
    const styles = {
        success: "green",
        fail: ["red", "bold"], //DO NOT use this for stderr
        err: "red",
        info: "cyan",
        header: ["yellow", "bold"]
    };
    
    return styleText(styles[type], str);
}

//Wrapper for console.log and console.error
//Checks for --pretty and applies colors automatically
function println(str, type) {
    //With --pretty
    let line;
    if (isPretty) {
        line = pretty(str, type);
    } else {
        line = str;
    }

    if (type === "err") {
        console.error(line);
    } else {
        console.log(line);
    }
}


//TODO: Implement
function output(filename) {

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

//Log specifics in verbose mode
function verboseLog(isVerbose, err, msg) {
    if (isVerbose) {
        //Outputs err.message if msg is not provided
        const line = msg || err.message;
        println(`Verbose: ${line}`, err ? "err" : "info");
    }
}

//Formats output and prints to console
//--pretty only affects human format and errors
function format(res) {
    //Sanity check
    if (res.list.length === 0) {
        //Continuous mode
        //Log error and continue
        if (isContinuous) {
            println("Error: No result available!", "err");
            return;
        }

        //Normal mode
        //If nothing worked, just log error and exit
        throw new Error("No result available!");
    }

    //Sort list (ascending order)
    if (isSorted) {
        results.list.sort(
            (pg1, pg2) => pg1.memSizePerWord - pg2.memSizePerWord
        );
    }

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

        //Style: Header (Yellow + Bold)
        //Time
        const date = new Date().toString();
        println(`Logged on: ${date}`, "header");

        //Avg Mem
        for (let i = res.oldLen; i < res.list.length; ++i) {
            res.avgMem += res.list[i].memSizePerWord;
        }
        res.oldLen = res.list.length;

        if(!isBaselineSpecified) {
            baseline = res.avgMem / res.list.length;
        }

        const formattedNum = formatUnit(baseline, isFormat);

        println(`Avg Mem/Word: ${formattedNum}`, "header");

        let urlCol = "URL List";
        let memCol = "Mem/Word";
        let bloatCol = "Bloated?";
        let numBloated = 0;

        //TODO: Add options to change col width settings
        //Headers
        println(`${urlCol.padEnd(32)}${memCol.padEnd(16)}${bloatCol.padEnd(8)}`, "header");

        //Results
        //Style: Success (Green)
        for (const r of res.list) {

            let style = "success";

            //Displays host only
            urlCol = r.userURL.host;
            memCol = formatUnit(r.memSize / r.totalWC, isFormat);
            bloatCol = "No";
            if (r.memSizePerWord > baseline) {
                bloatCol = "Yes";
                numBloated++;
                style = "fail";
            }

            println(`${urlCol.padEnd(32)}${memCol.padEnd(16)}${bloatCol.padEnd(8)}`, style);
        }

        //Num of bloated sites
        println(`# of bloated sites: ${numBloated}`, "header");
        println(`# of good sites: ${res.list.length - numBloated}`, "header");

    } else {
        //Non human mode simply prints URL + formatted Mem/Word
        for (const r of res.list) {
            println(`${r.userURL.toString()} ${formatUnit(r.memSize / r.totalWC)}`, "success");
        }
    }
}

//Helper to check URL
//Returns an URL object if valid, null otherwise
function isValidURL(userURL) {
    try {
        //URL constructor does quite a few nice things
        //1. Trims whitespace
        //2. Normalize cases for protocol and host
        //3. Resolves relative pathing
        //4. Encodes special characters (e.g. Space)
        return new URL(userURL);
    } catch(err) {
        errno = 1;
        return null;
    }
}

//Helper for browse
//Handles everything for pages
//Unsurprisingly, the ugliest code of the entire project
//is the one that's the most idiomatic JS
async function browsePage(browser, userURL) {

    //Returns total mem allocated of a page
    async function getMem(page) {
        const client = await page.context().newCDPSession(page);

        // Enable the Performance domain
        await client.send("Performance.enable");

        // Fetch the metrics
        const {metrics} = await client.send("Performance.getMetrics");

        const memSize = metrics.find(
                                m => m.name === "JSHeapTotalSize"
                            ).value;

        //Detach CDPSession
        await client.detach();

        return memSize;
    }

    //Giant try/catch
    //Basically a transaction for each page
    //Everything has to go right
    //Otherwise fail and move on
    let page;
    try {
        //Wait until page finishes loading or hits timeout
        page = await browser.newPage();

        await page.goto(userURL.toString(), {
            waitUntil: "load",
            timeout: waitMS
        });

        //Evaluation inside browser
        let res = await page.evaluate(async () => {
            const result = {
                totalWC: 0,
            };

            //Word count helper
            function wc(text) {
                // \s+ matches >=1 whitespace
                // Ternary is slightly more efficient/accurate
                // compared to just split on an empty string
                // because "".split() = [""] (len = 1)
                const trimmed = text.trim();
                const len = trimmed ? trimmed.split(/\s+/).length : 0;
                return len;
            }

            //Helper for walking DOM tree
            async function walk() {
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

        const memSize = await getMem(page);

        //Sanity check for memSize
        if (memSize <= 0) {
            errno = 1;
            println(`Error: Unable to get RAM of ${userURL}`, "err");
            return;
        }

        verboseLog(isVerbose, null, `${userURL} audited.`);

        //userURL is an URL object
        res = {...res, memSize, userURL};

        //Avoid NaN for pages with no words
        res.totalWC = res.totalWC || 1;
        res.memSizePerWord = res.memSize / res.totalWC;
        results.list.push(res);
    } catch(err) {
        errno = 1;
        println(`Error: Page evaluation of ${userURL} failed.`, "err");
        return;
    } finally {
        //The ugliest line in existence
        if (page) {
            await page.close().catch(() => {});
        }
    }
}

//Spawns the browser instance and shared context
//Closes browser after all pages are done
async function browse(userURL, recursionLevel) {
    //Launch browser
    const browser = await chromium.launch({
        headless: isHeadless,
    });

    //Promise.all() takes in array of promises
    //Which means map() that returns array of promises is preferred
    //HOWEVER, since Audit skips URLs, for loop is still used

    const promises = [];
    //userURL is an array of potential URLs
    for (let url of userURL) {
        //Check URL is valid
        if ((url = isValidURL(url))) {
            verboseLog(isVerbose, null, `Launching ${url.toString()}`);
        } else {
            println("Error: Invalid URL", "err");
            continue;
        }

        //Note the lack of await here for concurrency
        //Quick explainer for async in JS...
        //It's syntax sugar for
        //return new Promise(...);
        //So no race condition here
        //pg would immediately hold a Promise object
        //which is then pushed
        const pg = browsePage(browser, url);
        promises.push(pg);
    }

    await Promise.all(promises);

    await browser.close();
}

//Continuous Mode
async function input() {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const stopWords = ["q", "stop", "exit", "quit", "end"];

    println("Type RESET in all caps to reset the current list!", "info");
    println("Type OUTPUT in all caps to ouput the current list!", "info");

    while (true) {
        const userURL = await rl.question("Enter URL (https://example.com)\n");

        //Stops loop
        if (stopWords.includes(userURL.toLowerCase())) {
            break;
        }
        
        //RESET (has to be all caps)
        //Clears current list
        if (userURL.trim() === "RESET") {
            results.list = [];
            results.avgMem = 0;
            results.oldLen = 0;
            continue;
        }

        //OUTPUT
        //Outputs current list
        if (userURL.trim() === "OUTPUT") {
            format(results);
            continue;
        }

        //Encapsulate userURL in an array for browse()
        await browse([userURL], recursionLevel);

        println(`${userURL} audited!`, "info");
    }

    rl.close();

    //TODO: Pipe to file for --output
    //Call format after switching pipe

    //Format output
    format(results);

    println("Exiting Audit.", "info");
}

//Flags
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
        sort: {
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
        throw new Error("No urls provided!");
    }

    //Loop
    await browse(urls, recursionLevel);

    //TODO: Pipe to file for --output

    //Format output
    format(results);
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
    Spiritually blames the guy that wrote this
    In other words, only useful for venting and hurting my feelings :(
    --update
    Check for updates and update Audit if needed
    -h, --headless
    Run Audit in headless mode (no browser window)
    -c --continuous
    Long running mode. Audit accepts URL input until terminated
    -v --verbose
    More detailed output
    -o --output
    Logs output to a specified file
    -f --format
    Logs output in human readable format
    -p --pretty
    Logs output with colored lines
    Only works if stdout and stderr supports colors
    Green: Non-bloated sites
    Red: Bloated sites / Error
    Cyan: Info
    -r --recursive
    Samples the site up to a specified number of times
    Ex. audit -r 5 https://en.wikipedia.org 
    will try to sample up to 5 pages from the URLs provided
    and calculate by averaging the memory size/word
    -b --baseline
    Manually set a baseline memory size/word for Audit to compare to
    -w --wait
    Set the max amount of time in ms Audit should wait for a page to load
    before measuring memory usage
    -s --sort
    Sorts the result in ascending order of RAM usage
    -d --decimal
    Change number of decimal places for output
    Default is 3`;
        console.log(helpMsg);
    }

    //--version
    //TODO: Implement
    if (values.version) {
        console.log("Audit version");
    }

    //--blame
    if (values.blame) {
        const responses = [
            "Owie...",
            "Good one.",
            "Did you do it just to test out --blame?",
            "Sticks and stones may break my bones, but names will never hurt me... *sniffle*",
            "Check out git blame. You can actually blame people with that.",
            "You discovered a secret response! Oh wait, you didn't.",
            "I guess this flag is minorly useful for checking if Audit is installed properly?",
        ];

        const index = Math.floor(Math.random() * responses.length);

        console.log(responses[index]);
    }

    //--update
    //TODO: Implement
    if (values.update) {
        console.log("Audit update");
    }

    //Terminate on long flags
    if (values.help || values.version || values.blame || values.update) {
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
    isSorted = values.sort;

    //--pretty only applies if both
    //stdout and stderr support colors
    if (process.stdout.hasColors() && process.stderr.hasColors()) {
        isPretty = values.pretty;
    }

    if(values.baseline) {
        baseline = parseInt(values.baseline);
        isBaselineSpecified = true;
    }

    if(values.wait) {
        waitMS = parseInt(values.wait);
    }

    if(values.recursion) {
        recursionLevel = parseInt(values.recursion);
    }

    if(values.decimal) {
        decPlaces = parseInt(values.decimal);
        isDecPlaceSpecified = true;
    }

    if (isContinuous) {
        println("Audit is running in continuous mode!", "info");
        await input();
    } else {
        await processURLs(positionals);
    }

} catch (err) {
    errno = 2;
    println(`Error: ${err.message}`, "err");
}

//TODO: Delete
console.log("Errno:", errno);

process.exit(errno);

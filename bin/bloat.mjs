#!/usr/bin/env node

/**
 * @fileoverview A simple CLI tool to check bloat (RAM usage) of URLs
 * @author Hongji Dai
 * @date 2025/12/27
 * @version 1.0.0
 * @license GPL-2.0-or-later
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation; either version 2 of the License, or
 * (at your option) any later version.
 */

import {chromium} from "playwright";
import {parseArgs, styleText} from "node:util";
import {createInterface} from 'node:readline/promises';
import {openSync, createWriteStream} from "node:fs";
import {Console} from "node:console";
import {finished} from "stream/promises";

const author = "Hongji Dai";

//Update this with every release
const version = "1.0.1";

//Return value of Bloat
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
let isSorted = false;
let baseline = 0; //--baseline
let isBaselineSpecified = false;
let waitMS = 30000; //--wait
let decPlaces = 3; //--decimal
let isDecPlaceSpecified = false; //--decimal
let batchSize = 5; //--batch
let outputStream; //--output
let isRedirected = false; //--output

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
        success: ["green"],
        fail: ["red", "bold"], //DO NOT use this for stderr
        err: ["red"],
        info: ["cyan"],
        header: ["yellow", "bold"]
    };
    
    return styleText(styles[type], str);
}

//Wrapper for console.log and console.error
//Checks for --pretty and applies colors automatically
//Skips pretty formatting if output redirected
function println(str, type) {
    //With --pretty
    let line;
    if (isPretty && !isRedirected) {
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

//Helper for output() 
//Replaces the global console to redirect things like
//stdout and stderr
//Does nothing if outputStream is undefined
function replaceGlobalConsole() {
    if (outputStream) {
        isRedirected = true;
        const fileConsole = new Console({
            stdout: outputStream,
            stderr: outputStream
        });
        global.console = fileConsole;
    }
}

//Helper for flushing outputStream
//Does nothing if outputStream is undefined 
async function finishStream() {
    if (outputStream) {
        outputStream.end();
        await finished(outputStream);
    }
}

//Helper to determine unit
function formatUnit(mem) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    const base = 1024; //Binary units constant

    //Log base change to get appropriate unit
    let index = Math.floor(Math.log(mem) / Math.log(base)); 

    //If somehow index < 0 (log(mem) is negative)
    //set index to 0
    if (index < 0) {
        index = 0;
    }

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
function verboseLog(err, msg) {
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
    let list = results.list;
    if (isSorted) {
        list = results.list.toSorted(
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
        //Default URL column is 32 chars
        //Default for mem/word is 16 chars
        //Bloated is 8 chars
        //Only displays the host name
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

        //If no baseline is specified
        //Dynamically adjust the average based on the sites
        //audited so far
        //"Bloat" is only meaningful with comparison anyways
        //google.com is bloated compared to enwp.org but not to youtube.com
        //So the rolling average is used
        if(!isBaselineSpecified) {
            baseline = res.avgMem / res.list.length;
        }

        const formattedNum = formatUnit(baseline);

        println(`Avg Mem/Word: ${formattedNum}`, "header");

        let urlCol = "URL List";
        let memCol = "Mem/Word";
        let bloatCol = "Bloated?";
        let numBloated = 0;

        //Headers
        println(`${urlCol.padEnd(32)}${memCol.padEnd(16)}${bloatCol.padEnd(8)}`, "header");

        //Results
        //Style: Success (Green)
        for (const r of list) {

            //Sanity check
            if (r.memSize < 0 || r.totalWC <= 0) {
                continue;
            }

            let style = "success";

            //Displays host only
            urlCol = r.userURL.host;
            memCol = formatUnit(r.memSize / r.totalWC);
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
        for (const r of list) {

            //Sanity check
            if (r.memSize < 0 || r.totalWC <= 0) {
                continue;
            }

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
            function walk() {
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

                //Basically a traversal of a linked list
                let node;
                while ((node = walker.nextNode()) !== null) {
                    result.totalWC += wc(node.textContent);
                }
            }

            walk();

            return result;
        });

        const memSize = await getMem(page);

        //Sanity check for memSize
        if (memSize <= 0) {
            errno = 1;
            println(`Error: Unable to get RAM of ${userURL}`, "err");
            return;
        }

        verboseLog(null, `${userURL} audited.`);

        //userURL is an URL object
        res = {...res, memSize, userURL};

        //Avoid NaN for pages with no words
        res.totalWC = res.totalWC || 1;
        res.memSizePerWord = res.memSize / res.totalWC;
        results.list.push(res);
    } catch(err) {
        errno = 1;
        println(`Error: Page evaluation of ${userURL} failed.`, "err");
    } finally {
        //CLOSE the page no matter what
        //The ugliest line in existence
        if (page) {
            await page.close().catch(() => {});
        }
    }
}

//Spawns the browser instance and shared context
//Closes browser after all pages are done
async function browse(userURL) {

    //Giant try catch
    let browser;
    try {
        //Launch browser
        //If this fails, there're bigger problems
        browser = await chromium.launch({
            headless: isHeadless,
        });

        //Batch URLs for concurrency
        //Default batch is 5 URLS at a time
        //If you set the batchSize too high
        //YOU WILL FORK BOMB YOURSELF
        let lastIndex = 0;

        while (lastIndex < userURL.length) {
            //Promise.all() takes in array of promises
            //Which means map() is preferred
            //HOWEVER, since Bloat skips URLs, for loop is still used
            const promises = [];
            //userURL is an array of potential URLs
            for (let i = 0; i < batchSize; ++i) {
                
                //Out of bounds, break
                if (lastIndex + i >= userURL.length) {
                    break;
                }

                let url = userURL[lastIndex + i];

                //Check URL is valid
                if ((url = isValidURL(url))) {
                    verboseLog(null, `Launching ${url.toString()}`);
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

            lastIndex += batchSize;
            
            verboseLog(null, "-----Batch processed-----");
        }
    } catch(err) {
        throw new Error("Browser instance failed!");
    } finally {
        //CLOSE THE BROWSER NO MATTER WHAT
        if (browser) {
            await browser.close().catch(() => {});
        }
    }
}

//Continuous Mode
async function input() {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const stopWords = ["q", "stop", "exit", "quit", "end"];

    println("Type RESET in all caps to reset the current list!", "info");
    println("Type OUTPUT in all caps to output the current list!", "info");

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
        await browse([userURL]);

        println(`${userURL} audited!`, "info");
    }

    //Close interface
    rl.close();

    //Pipe to output file
    replaceGlobalConsole();

    //Format output
    format(results);

    println("Exiting Bloat.", "info");
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
        license: {
            type: "boolean",
            default: false,
        },
        batch: {
            type: "string",
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
    //Positionals are treated as list of URLs
    allowPositionals: true
};

//Main function to loop over urls
async function processURLs(urls) {
    //Sanity check
    if (urls.length === 0) {
        throw new Error("No urls provided!");
    }

    //Pipe to output file
    replaceGlobalConsole();

    await browse(urls);

    //Format output
    format(results);
}

try {
    //Positionals should be urls
    const {values, positionals} = parseArgs(config);

    //--help
    if (values.help) {
        //Ignore the weird format, JS template literals
        const helpMsg = 
        `
Bloat: Test RAM usage of websites!
    Flags:
    --help
        Show instructions and flags for Bloat
    --version
        Show Bloat version
    --blame
        Spiritually blames the guy that wrote this
        Only useful for venting and hurting my feelings :(
    --license
        Displays the license for Bloat
    -h --headless
        Run Bloat in headless mode (no browser window)
    -c --continuous
        Long running mode, Bloat accepts URL input until terminated
        With --output, only writes the FINAL URL list to the file
    -v --verbose
        Logs more information and error messages
        Useful for debugging how Bloat is running
    -o --output
        Logs output to a specified file
    Ex. bloat --output output.txt
        Bloat will write to output.txt, which includes
        both the final result and error messages
    -f --format
        Logs output in human readable format
        Also sets default decimal place to 0
        Use --decimal to set decimal place explicitly in this mode
    -p --pretty
        Logs output with colored lines
        Only works if stdout and stderr supports colors
        Green: Non-bloated sites
        Red: Bloated sites / Error
        Cyan: Info
        DOES NOT corrupt file generated by --output with color codes
    -b --baseline
        Manually set a baseline memory size/word for URLs to compare to
        CANNOT be 0
    -w --wait
        Set the max amount of time in ms
        Bloat waits for a page to load before measuring memory usage
    -s --sort
        Sorts the result in ascending order of RAM usage
    -d --decimal
        Change number of decimal places for output
        Default is 3
    --batch
        Sets the max number of tabs that can be concurrently opened
        Default is 5
        WARNING: Setting this too high will fork bomb yourself
        If the last line is confusing, it's a good sign that you
        shouldn't change this.
`;
        console.log(helpMsg);
    }

    //--version
    if (values.version) {
        console.log(`Bloat version ${version}`);
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
            "I guess this flag is minorly useful for checking if Bloat is installed properly?",
        ];

        const index = Math.floor(Math.random() * responses.length);

        console.log(responses[index]);
    }

    //--license
    if (values.license) {
        //Ignore weird formatting
        console.log(`
    Copyright (C) 2026 ${author}
    This program comes with ABSOLUTELY NO WARRANTY.
    This is free software, and you are welcome to redistribute it
    under the terms of the GNU General Public License version 2
    (or, at your option, any later version).
        `);
    }

    //Terminate on long flags
    if (values.help || values.version || values.blame || values.license) {
        process.exit(errno);
    }

    //Setting values for flags
    //Setting them explicitly instead of dereferencing
    //Because I think it's better semantics
    //Also because some require parseInt
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

    //Helper to check numbers
    function validNum(num) {
        //All settings should be
        //>=0
        //not NaN
        //throw error and exit if assertion fails
        if (Number.isNaN(num) || num < 0) {
            throw new Error("Invalid settings!");
        }

        return num;
    }

    //--baseline
    if (values.baseline) {
        //Baseline of 0 is not allowed since it's not meaningful
        //Also because it would break formatUnit()
        baseline = validNum(parseInt(values.baseline));

        if (baseline === 0) {
            throw new Error("Invalid baseline! Cannot be 0.");
        }

        isBaselineSpecified = true;
    }

    //--wait
    if (values.wait) {
        waitMS = validNum(parseInt(values.wait));
    }

    //--decimal
    if (values.decimal) {
        decPlaces = validNum(parseInt(values.decimal));
        isDecPlaceSpecified = true;
    }

    //--batch
    //If set to 0, default to 1
    if (values.batch) {
        batchSize = validNum(parseInt(values.batch)) || 1;
    }

    //--output
    if (values.output) {
        const fname = values.output;

        //Sanity check for fname
        //Throws on names the OS does not allow
        //w = O_CREAT|O_WRONLY|O_TRUNC
        const fd = openSync(fname, "w");

        //Wrap fd up in a stream for piping
        //Because Node doesn't have dup2()
        outputStream = createWriteStream(null, {fd});

        outputStream.on("error", (err) => {
            verboseLog(err);
        });
    }

    if (isContinuous) {
        println("Bloat is running in continuous mode!", "info");
        await input();
    } else {
        await processURLs(positionals);
    }

} catch (err) {
    //Unaccounted errors end up here
    errno = 2;
    println(`Error: ${err.message}`, "err");
} finally {
    //Flush the output
    await finishStream().catch(() => {});

    //Exit and return error code
    process.exit(errno);
}

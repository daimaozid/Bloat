import readline from 'node:readline';
import {chromium} from "playwright";

//Open the requested page
async function browse(userURL) {
    const browser = await chromium.launch({headless: false});
    //Wait until page finishes loading
    const page = await browser.newPage({waitUntil: 'networkidle'});
    await page.goto(userURL);
    await page.evaluate(async () => {
        //Word count helper
        function wc(text) {
            // \s+ matches >=1 whitespace
            const len = text.trim().split(/\s+/)
                        .filter(word => word.length > 0).length;
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
            let totalCount = 0;
            while ((node = walker.nextNode()) !== null) {
                totalCount += wc(node.textContent);
                console.log(node.textContent);
            }

            console.log(`Total WC: ${totalCount}`);
        }

        await walk();
    });
    //await browser.close();
}

//Take user input from command line
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

rl.question(`Enter URL ("https://example.com")`, input => {
    //TODO: Filter input

    const userURL = input;
    console.log(`Launching ${userURL}!`);
    rl.close();

    browse(userURL);
});



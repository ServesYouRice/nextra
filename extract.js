const fs = require('fs');

const logPath = 'C:\\Users\\V\\.gemini\\antigravity\\brain\\69bbf2a0-2360-4782-92a2-56541f216f4a\\.system_generated\\logs\\overview.txt';
const text = fs.readFileSync(logPath, 'utf8');

const regex = /File Path: `file:\/\/\/c:\/Users\/V\/Documents\/P2Pvideo\/server\.js`\nTotal Lines: [89]\d\d\n.*?\nShowing lines (\d+) to \d+\n.*?\n([\s\S]*?)(?:The above content|<\/output>)/gi;

let match;
const linesDict = {};

while ((match = regex.exec(text)) !== null) {
    const lines = match[2].trim().split('\n');
    for (const line of lines) {
        if (line.match(/^\d+: /)) {
            const parts = line.split(': ');
            linesDict[parseInt(parts[0])] = parts.slice(1).join(': ');
        }
    }
}

console.log(`Extracted ${Object.keys(linesDict).length} unique lines`);
if (Object.keys(linesDict).length > 0) {
    const maxLine = Math.max(...Object.keys(linesDict).map(Number));
    const missing = [];
    for (let i = 1; i <= maxLine; i++) {
        if (linesDict[i] === undefined) missing.push(i);
    }
    console.log(`Max line: ${maxLine}, Missing: ${missing.length}`);
    if (missing.length === 0) {
        const out = [];
        for (let i = 1; i <= maxLine; i++) out.push(linesDict[i]);
        fs.writeFileSync('server.js', out.join('\n'));
        console.log('Restored server.js perfectly!');
    } else {
        console.log(`Missing line numbers: ${missing.slice(0, 30)}`);
    }
} else {
    console.log("No valid blocks found in overview.txt.");
}

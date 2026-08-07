// Renders public/brand/nextra-social-card.png from the same primary lockup the
// hero uses, so the link preview and the page cannot drift apart again. The
// card is committed art, not a build output - re-run this only when the lockup,
// tagline, or palette changes, then bump the ?v= tag on the og:image and
// twitter:image URLs in index.html so caches refetch it.
const fs = require('fs');
const path = require('path');
const { chromium } = require('@playwright/test');

const repoRoot = path.join(__dirname, '..');
const brandDir = path.join(repoRoot, 'public', 'brand');
const outputPath = path.join(brandDir, 'nextra-social-card.png');

// og:image is 1200x630; both Discord and Twitter crop to that ratio.
const CARD_WIDTH = 1200;
const CARD_HEIGHT = 630;
const TAGLINE = 'Peer-to-peer screen sharing — one link, no accounts';

// The lockup is embedded rather than linked so the render never depends on a
// file:// fetch resolving inside the headless browser.
function readLogoDataUri() {
    const logoPath = path.join(brandDir, 'nextra-primary-logo.png');
    const logo = fs.readFileSync(logoPath);
    if (logo.length === 0) {
        throw new Error(`${logoPath} is empty; cannot render the social card.`);
    }
    return `data:image/png;base64,${logo.toString('base64')}`;
}

// Palette values are copied from src/index.css rather than parsed out of it: the
// card is a standalone artboard, and a silent parse miss would ship a wrong
// colour without failing anything.
function buildMarkup(logoDataUri) {
    return `<!doctype html>
<html>
<head><meta charset="utf-8" /></head>
<body>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    width: ${CARD_WIDTH}px;
    height: ${CARD_HEIGHT}px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 56px;
    background:
      radial-gradient(90% 70% at 12% 88%, rgba(77, 227, 255, 0.16), transparent 60%),
      radial-gradient(80% 70% at 88% 12%, rgba(255, 92, 225, 0.18), transparent 62%),
      radial-gradient(70% 60% at 78% 82%, rgba(160, 107, 255, 0.14), transparent 60%),
      #0f0f12;
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    overflow: hidden;
  }
  .lockup { width: 620px; height: auto; display: block; }
  .tagline {
    font-size: 34px;
    font-weight: 400;
    letter-spacing: 0.01em;
    color: #a2a2b0;
  }
</style>
<img class="lockup" src="${logoDataUri}" alt="Nextra" />
<p class="tagline">${TAGLINE}</p>
</body>
</html>`;
}

async function main() {
    const markup = buildMarkup(readLogoDataUri());
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage({
            viewport: { width: CARD_WIDTH, height: CARD_HEIGHT },
            deviceScaleFactor: 1,
        });
        await page.setContent(markup, { waitUntil: 'load' });
        // setContent resolves before a data: URI image has decoded, and a
        // screenshot taken then silently loses the lockup.
        await page.locator('.lockup').first().waitFor({ state: 'visible' });
        await page.screenshot({ path: outputPath, type: 'png' });
    } finally {
        await browser.close();
    }

    const written = fs.statSync(outputPath);
    console.log(`[brand] wrote ${path.relative(repoRoot, outputPath)} (${written.size} bytes)`);
}

main().catch((error) => {
    console.error(`[brand] ${error.message}`);
    process.exitCode = 1;
});

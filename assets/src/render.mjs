// Renders every .shot in readme-art.html to assets/<id>.png.
// Usage: node render.mjs <path/to/readme-art.html> <out-dir> [sheet.png]
// Needs puppeteer-core (npm i puppeteer-core) and Google Chrome.
import puppeteer from 'puppeteer-core';
import { pathToFileURL } from 'node:url';

const [html, out, sheet] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--allow-file-access-from-files'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1700, height: 1000, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(html).href);
await page.evaluate(() => document.fonts.ready);
for (const el of await page.$$('.shot')) {
  const id = await el.evaluate((e) => e.id);
  await el.screenshot({ path: `${out}/${id}.png`, omitBackground: true });
  console.log(id);
}
if (sheet) {
  await page.setViewport({ width: 1700, height: 1000, deviceScaleFactor: 0.5 });
  await page.screenshot({ path: sheet, fullPage: true });
}
await browser.close();

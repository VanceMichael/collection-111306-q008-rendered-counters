import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {startSource} from '../src/source.mjs';
test('真实浏览器呈现及操作保留源端特殊情形',{timeout:20000},async()=>{
 const source=await startSource();const browser=await chromium.launch({headless:true});
 const context=await browser.newContext({acceptDownloads:true});const page=await context.newPage();
 const action=async action=>{const response=await fetch(source.url+'/api/action',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action})});assert.equal(response.status,200);return response.json();};
 try{await page.goto(source.url);await page.waitForFunction(()=>window.portalReady);const screen=await page.locator('h2').first().evaluate(element=>getComputedStyle(element,'::before').content);
assert.ok(screen.includes('counter'));
await page.emulateMedia({media:'print'});
assert.equal(await page.evaluate(()=>matchMedia('print').matches),true);
await page.click('#insert');assert.equal(await page.locator('section').count(),2);
assert.equal(await page.locator('h2').first().textContent(),'前置检查');}
 finally{await browser.close();await source.close();}
});

// An account added while uploading must still be there after the app is closed and opened again, even when another account was moved
// under a main account first (that used to make two accounts share a number, and one vanished on reopening, its lines left as 1999).
//   NODE_PATH=$(npm root -g) node test/e2e-persist.cjs
const { chromium } = require('playwright'); const http=require('http'),fs=require('fs'),path=require('path'),os=require('os');
const SITE=path.join(__dirname,'..','app');
const MIME={'.html':'text/html','.js':'text/javascript','.jpg':'image/jpeg','.png':'image/png','.webmanifest':'application/manifest+json'};
const srv=http.createServer((q,r)=>{const u=q.url.split('?')[0];const f=path.join(SITE,u==='/'?'index.html':u);if(!fs.existsSync(f)||fs.statSync(f).isDirectory()){r.writeHead(404);return r.end();}r.writeHead(200,{'Content-Type':MIME[path.extname(f)]??'application/octet-stream'});r.end(fs.readFileSync(f));});
const HEAD='Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #\n';
const PASS='correct horse battery';
srv.listen(0,async()=>{const b=await chromium.launch();const p=await (await b.newContext({viewport:{width:1000,height:1000},reducedMotion:'reduce'})).newPage();const problems=[];p.on('pageerror',e=>problems.push(e.message));
await p.goto(`http://localhost:${srv.address().port}/`);
const openHome = async () => { if (await p.locator('#home').isVisible() && !(await p.evaluate(() => document.documentElement.hasAttribute('data-open')))) { await p.click('#home-hint'); await p.waitForTimeout(500); } };
await openHome();
await p.setInputFiles('#file',[path.join(SITE,'..','samples','FAKE-chase-checking.csv')]);await p.waitForTimeout(800);
await p.click('#banner-btn');await p.fill('#sec-pass',PASS);await p.fill('#sec-pass2',PASS);await p.click('text=Save on this device');await p.waitForTimeout(3000);
await p.keyboard.press('Escape');
// paste accounts list, then a file for a new account made while uploading
await p.click('#gear');await p.locator('#settings-body .menu-row',{hasText:'Accounts'}).click();
await p.fill('#acct-paste','Chase Checkings (1044)\nChase Savings (8527)\nChase Credit Card (6426)');await p.click('#acct-paste-go');await p.waitForTimeout(800);
const sel=p.locator('#acctunder-savings-8527');const opts=await sel.locator('option').allInnerTexts();await sel.selectOption({index:1});await p.waitForTimeout(800);
await p.click('#settings-close');
const f=path.join(os.tmpdir(),'Chase1899_Activity.CSV');fs.writeFileSync(f,HEAD+'CREDIT,01/05/2026,"INTEREST",1.00,ACCT,501.00,\n');
await p.setInputFiles('#file',[f]);await p.waitForSelector('#ask-overlay');
await p.selectOption('#ask-account','__new');await p.selectOption('#ask-kind','savings');await p.fill('#ask-name','Chase Savings (1899)');await p.click('#ask-ok');await p.waitForTimeout(1500);
await p.waitForTimeout(2000);
await p.reload();await p.waitForSelector('#lock:not([hidden])');await openHome();
await p.fill('#lock-pass',PASS);await p.click('#lock-btn');await p.waitForTimeout(4000);
await p.click('#gear');await p.locator('#settings-body .menu-row',{hasText:'Accounts'}).click();
const ok1 = (await p.locator('#acctname-savings-1899').count()) === 1, ok2 = (await p.locator('#orphan-box').count()) === 0;
const codes = (await p.textContent('#acct-list')).match(/\d{4}(?= · )/g);
const ok3 = new Set(codes).size === codes.length;
console.log((ok1 ? 'PASS' : 'FAIL') + ' the account added while uploading is still there after reopening');
console.log((ok2 ? 'PASS' : 'FAIL') + ' no lines are left without an account (no 1999)');
console.log((ok3 ? 'PASS' : 'FAIL') + ' every account has its own number  ' + codes.join(','));
const bad = !(ok1 && ok2 && ok3) || problems.length; if (problems.length) console.log('FAIL errors', problems.join(' | '));
console.log(bad ? '\nFAILED' : '\nALL PASSED');
await b.close();srv.close();process.exit(bad ? 1 : 0);});

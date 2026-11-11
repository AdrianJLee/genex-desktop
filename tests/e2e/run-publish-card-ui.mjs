/**
 * The Publish card of a game made in an engine, in a disposable Electron profile with a fake
 * `window.studio`: skeleton rows and no button until the game folder has answered. An Unreal game on a
 * Mac opens with both apps switched on and one button, "Build Mac and Windows": the agent builds the
 * Mac app here while Genex Cloud builds the Windows one and keeps it, the busy button says both and
 * "Windows can take up to an hour."; while a press is being sent the blue button keeps its words, its
 * fill and its label's colour; once the Mac app is built, "Publish to Mac and Windows" gives
 * players the Mac app now and the Windows one as soon as it is built; both built publishes both, or
 * only the one switched on. A live game whose apps are older builds both, then updates both. Genex
 * Cloud building an app that was published shows its clock, the busy button and "It can take up to an
 * hour."; a done card has no button; a failed cloud build has its error block and leaves the Mac app
 * free to go; a build that didn't start has a block that tries again; a switch turned off takes that
 * app down with an amber button; the same game on a PC builds its Windows app there, and a switch
 * turned off there stays off after the publish and when the card opens again; a Unity game lists its
 * four platforms. No row says "Public:", and no Share assets line shows. Dark screens, and the main
 * ones in light.
 */
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildDesignGallery } from "../../scripts/design-gallery.mjs";
import { fixtureElectronArgs, fixtureElectronEnv, resolveElectron } from "../../scripts/electron-runtime.mjs";
import { sourceIdentity } from "../../scripts/studio-dev/files.mjs";

/** The whole check, from Electron's start to its exit. */
const RUN_TIMEOUT_MS = 120_000;

const out = await buildDesignGallery();
const evidence = path.resolve(".studio-dev/evidence", `publish-card-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(path.join(os.tmpdir(), "genex-publish-card-"));
await build({
  entryPoints: ["tests/fixtures/publish-card.tsx"],
  outfile: path.join(out, "publish-card.js"),
  bundle: true,
  format: "esm",
  jsx: "automatic",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"production"' },
});
await writeFile(
  path.join(out, "publish-card.html"),
  '<html data-theme="dark"><head><link rel="stylesheet" href="gallery.css"></head><body style="margin:0;background:var(--background)"><div id="root" style="display:flex;width:100vw;height:100vh"></div><script type="module" src="publish-card.js"></script></body></html>',
);
const boot = path.join(out, "publish-card.cjs");
await writeFile(
  boot,
  `
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(profile)});
const evidence=${JSON.stringify(evidence)};
const report={source:${JSON.stringify(sourceIdentity(process.cwd()))},profile:${JSON.stringify(profile)},providers:'synthetic',steps:{},errors:[]};
report.buildId=report.source.sourceDigest;
report.electron=process.versions.electron;
app.whenReady().then(async()=>{
 const win=new BrowserWindow({width:1100,height:1000,show:false,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,zoomFactor:1}});
 const wc=win.webContents;
 wc.on('console-message',(event)=>{if(event.level==='error')report.errors.push(event.message)});
 const js=(source)=>wc.executeJavaScript(source);
 const capture=async(name)=>{const file=path.join(evidence,name+'.png');fs.writeFileSync(file,(await wc.capturePage()).toPNG());return file;};
 const step=async(name,source)=>{const result=await js(source);report.steps[name]=result;return result;};
 const rows=(seen)=>seen.rows.map((row)=>[row.name,row.status,row.side]);
 const clean=(name,seen)=>{
  assert.equal(seen.overflow,false,name+': nothing runs past the card');
  assert.doesNotMatch(seen.text,/Public:/,name+': no "Public:" word');
  assert.equal(seen.share,false,name+': no Share assets line');
  assert.doesNotMatch(seen.text,/Only Mac players/,name);
 };
 try {
  await wc.loadFile(${JSON.stringify(path.join(out, "publish-card.html"))});
  // While the folder is read: skeleton rows, no status, no button.
  const loading=await step('loading','window.cardRig.open({scene:"loading"})');
  assert.equal(loading.loading,true);
  assert.equal(loading.primary,null,'no button before the folder has answered');
  report.loading=await capture('dark-0-loading');
  const answered=await step('answered','window.cardRig.answer()');
  assert.equal(answered.loading,false);
  const NOT_BUILT=[['Mac','Not built','builds on this Mac'],['Windows','Not built','builds on Genex Cloud']];
  for (const theme of ['dark','light']) {
   // Nothing built yet: both apps are switched on and one button builds both.
   const first=await step(theme+'First','window.cardRig.open({scene:"first",theme:"'+theme+'"})');
   assert.deepEqual(rows(first),NOT_BUILT);
   assert.deepEqual(first.rows.map((row)=>row.on),[true,true]);
   assert.equal(first.primary,'Build Mac and Windows');
   clean('first',first);
   report[theme+'First']=await capture(theme+'-a1-opens');
  }
  await step('darkFirstSwitches','window.cardRig.open({scene:"first",theme:"dark"})');
  const windowsOnly=await step('firstMacOff','window.cardRig.toggle("mac")');
  assert.equal(windowsOnly.primary,'Build Windows','the button names what is switched on');
  report.firstMacOff=await capture('dark-m5a-mac-off');
  const neither=await step('firstBothOff','window.cardRig.toggle("windows")');
  assert.equal(neither.primary,null,'no button only when nothing is switched on');
  report.firstBothOff=await capture('dark-m5c-both-off');
  const macOnly=await step('firstWindowsOff','window.cardRig.toggle("mac")');
  assert.equal(macOnly.primary,'Build Mac');
  report.firstWindowsOff=await capture('dark-m5b-windows-off');
  // While a press is being sent the blue button keeps its words, its fill and its label's colour.
  for (const theme of ['light','dark']) {
   await step(theme+'SendingOpen','window.cardRig.open({scene:"first",theme:"'+theme+'"})');
   const ready=await step(theme+'SendingReady','window.cardRig.toggle("mac")');
   assert.equal(ready.primary,'Build Windows');
   const sending=await step(theme+'Sending','window.cardRig.hold()');
   assert.equal(sending.primary,'Build Windows','a pressed button keeps its words');
   assert.equal(sending.primaryDisabled,true,'and takes no second press');
   assert.deepEqual([sending.primaryInk,sending.primaryFill],[ready.primaryInk,ready.primaryFill],theme+': a pressed button keeps its label colour and its fill');
   report[theme+'Sending']=await capture(theme+'-press-being-sent');
   await step(theme+'Sent','window.cardRig.goThrough()');
  }
  // Windows alone: Genex Cloud builds it, and the button stays busy until there is an app to publish.
  await step('darkFirstWindowsOnly','window.cardRig.open({scene:"first",theme:"dark"})');
  await step('windowsOnlyMacOff','window.cardRig.toggle("mac")');
  const alone=await step('windowsOnlyPress','window.cardRig.press()');
  assert.deepEqual(alone.asked,['cloud:windows:keep']);
  assert.equal(alone.composed.length,0,'the agent builds nothing here');
  assert.deepEqual(rows(alone),[['Mac','Not built','builds on this Mac'],['Windows','Sending to Genex Cloud',null]]);
  assert.match(alone.primary??'',/^Building Windows/);
  assert.equal(alone.primaryDisabled,true);
  assert.equal(alone.note,'It can take up to an hour.');
  clean('windowsOnlyPress',alone);
  report.windowsOnly=await capture('dark-m5d-windows-alone-building');
  // One Build: the agent builds the Mac app here, Genex Cloud builds the Windows one and keeps it.
  await step('darkFirstAgain','window.cardRig.open({scene:"first",theme:"dark"})');
  const bothPress=await step('bothPress','window.cardRig.press()');
  assert.equal(bothPress.composed.length,1,'the agent is asked once');
  assert.match(bothPress.composed[0].text,/Mac app of genex-strike/);
  assert.deepEqual(bothPress.asked,['cloud:windows:keep'],'Genex Cloud builds and keeps: nothing goes to players');
  assert.deepEqual(rows(bothPress),[['Mac','Building on this Mac',null],['Windows','Sending to Genex Cloud',null]]);
  assert.match(bothPress.primary??'',/^Building Mac and Windows/);
  assert.equal(bothPress.primaryDisabled,true);
  assert.equal(bothPress.note,'Windows can take up to an hour.');
  clean('bothPress',bothPress);
  report.bothPress=await capture('dark-a2-building-both');
  for (const theme of ['dark','light']) {
   // The Mac app is built while Genex Cloud still builds: one Publish for both.
   const macBuilt=await step(theme+'MacBuilt','window.cardRig.open({scene:"macBuilt",theme:"'+theme+'"})');
   assert.deepEqual(rows(macBuilt),[['Mac','Ready to publish','3.2 GB'],['Windows','Building on Genex Cloud',null]]);
   assert.match(macBuilt.rows[1].clock??'',/\\d/,'a clock in place of the switch');
   assert.equal(macBuilt.primary,'Publish to Mac and Windows');
   assert.equal(macBuilt.primaryDisabled,false);
   assert.equal(macBuilt.note,'Windows can take up to an hour.');
   clean('macBuilt',macBuilt);
   report[theme+'MacBuilt']=await capture(theme+'-a3-mac-built');
  }
  const published=await step('publishBoth','window.cardRig.press()');
  assert.deepEqual(published.asked,['apps:mac','release:windows'],'the Mac app goes, and the Windows one once it is built');
  for (const theme of ['dark','light']) {
   // Published while Genex Cloud builds: its clock, the busy button and the line under it.
   const following=await step(theme+'Following','window.cardRig.open({scene:"following",theme:"'+theme+'"})');
   assert.deepEqual(following.rows.map((row)=>[row.name,row.status,row.switch]),[
    ['Mac','Live · up to date',true],
    ['Windows','Building on Genex Cloud',false],
   ]);
   assert.match(following.primary??'',/^Publishing to Windows/);
   assert.equal(following.primaryDisabled,true);
   assert.equal(following.note,'It can take up to an hour.');
   clean('following',following);
   report[theme+'Following']=await capture(theme+'-a5-windows-follows');
  }
  // Done: nothing to press.
  const done=await step('done','window.cardRig.open({scene:"done"})');
  assert.deepEqual(rows(done).map((one)=>one.slice(0,2)),[['Mac','Live · up to date'],['Windows','Live · up to date']]);
  assert.equal(done.primary,null);
  clean('done',done);
  report.done=await capture('dark-a6-done');
  // A switch off: the button takes that app down, in amber.
  const off=await step('off','window.cardRig.toggle("windows")');
  assert.equal(off.primary,'Take Windows down');
  assert.equal(off.warn,true);
  report.takeDown=await capture('dark-take-down');
  const down=await step('down','window.cardRig.press()');
  assert.deepEqual(down.asked.filter((one)=>!one.startsWith('review:')),['publish-remove-app:windows']);
  // Both built: one Publish, or only the app switched on.
  const bothBuilt=await step('bothBuilt','window.cardRig.open({scene:"bothBuilt"})');
  assert.deepEqual(rows(bothBuilt),[['Mac','Ready to publish','3.2 GB'],['Windows','Ready to publish','2.9 GB']]);
  assert.equal(bothBuilt.primary,'Publish to Mac and Windows');
  assert.equal(bothBuilt.note,null);
  clean('bothBuilt',bothBuilt);
  report.bothBuilt=await capture('dark-m1a-both-built');
  const justMac=await step('bothBuiltWindowsOff','window.cardRig.toggle("windows")');
  assert.equal(justMac.primary,'Publish to Mac');
  report.bothBuiltWindowsOff=await capture('dark-m1b-windows-off');
  const sentMac=await step('publishMac','window.cardRig.press()');
  assert.deepEqual(sentMac.asked,['apps:mac'],'the Windows app stays built');
  // Only the Windows app is built: the Mac app, switched on, is built first; switched off, Windows goes alone.
  const windowsBuilt=await step('windowsBuilt','window.cardRig.open({scene:"windowsBuilt"})');
  assert.deepEqual(rows(windowsBuilt),[['Mac','Not built','builds on this Mac'],['Windows','Ready to publish','2.9 GB']]);
  assert.equal(windowsBuilt.primary,'Build Mac');
  const justWindows=await step('windowsBuiltMacOff','window.cardRig.toggle("mac")');
  assert.equal(justWindows.primary,'Publish to Windows');
  const sentWindows=await step('publishWindows','window.cardRig.press()');
  assert.deepEqual(sentWindows.asked,['apps:','release:windows']);
  for (const theme of ['dark','light']) {
   // A live game that changed: each row says where it gets built, and one button builds both.
   const old=await step(theme+'Old','window.cardRig.open({scene:"old",theme:"'+theme+'"})');
   assert.deepEqual(rows(old),[
    ['Mac','Live · older than your game','builds on this Mac'],
    ['Windows','Live · older than your game','builds on Genex Cloud'],
   ]);
   assert.equal(old.primary,'Build Mac and Windows');
   clean('old',old);
   report[theme+'Old']=await capture(theme+'-m2a-older');
  }
  const buildPress=await step('buildPress','window.cardRig.press()');
  assert.equal(buildPress.composed.length,1,'the agent is asked once');
  assert.match(buildPress.composed[0].text,/Build the Mac app of genex-strike again/);
  assert.deepEqual(buildPress.asked,['cloud:windows:keep'],'building sends nothing to players');
  assert.deepEqual(rows(buildPress),[['Mac','Building on this Mac',null],['Windows','Sending to Genex Cloud',null]]);
  assert.match(buildPress.primary??'',/^Building Mac and Windows/);
  // The Mac app lands and the agent's turn ends: the open card sees it, with no reopening.
  const landed=await step('landed','window.cardRig.land()');
  assert.deepEqual(rows(landed)[0],['Mac','Live · update ready','3.2 GB'],'the card follows the folder');
  assert.equal(landed.primary,'Update Mac and Windows');
  // Both newer apps are built: players keep the older ones until Update.
  const ready=await step('updateReady','window.cardRig.open({scene:"updateReady"})');
  assert.deepEqual(rows(ready),[['Mac','Live · update ready','3.2 GB'],['Windows','Live · update ready','2.9 GB']]);
  assert.equal(ready.primary,'Update Mac and Windows');
  clean('updateReady',ready);
  report.updateReady=await capture('dark-m2b-update-ready');
  const updated=await step('updated','window.cardRig.press()');
  assert.deepEqual(updated.asked,['apps:mac','release:windows']);
  // A build that publishes itself (one an older Genex started): the same clock and line, as an update.
  const building=await step('building','window.cardRig.open({scene:"building"})');
  assert.match(building.primary??'',/^Updating Windows/);
  assert.equal(building.primaryDisabled,true);
  assert.equal(building.note,'It can take up to an hour.');
  clean('building',building);
  // A failed Genex Cloud build of the game as it is: the older app stays live, and a block under the rows
  // names it, never its log, with Send to agent and Copy; the main button has nothing to do.
  const failed=await step('failed','window.cardRig.open({scene:"failed"})');
  assert.deepEqual(rows(failed)[1],['Windows','Couldn’t build · the older one is still live',null]);
  assert.deepEqual(failed.blocks.map((one)=>[one.target,one.text,one.send,one.copy]),[['windows','Windows build error'+'Send to agent',true,true]]);
  assert.doesNotMatch(failed.text,/FVector|C2065/,'the log never shows');
  assert.equal(failed.primary,null,'the error is not the main button');
  clean('failed',failed);
  report.failed=await capture('dark-failed-live');
  // The same before the first publish: the Mac app never waits for Windows.
  const failedFirst=await step('failedFirst','window.cardRig.open({scene:"failedFirst"})');
  assert.deepEqual(rows(failedFirst),[['Mac','Ready to publish','3.2 GB'],['Windows','Couldn’t build',null]]);
  assert.deepEqual(failedFirst.blocks.map((one)=>[one.target,one.send,one.copy]),[['windows',true,true]]);
  assert.equal(failedFirst.primary,'Publish to Mac');
  clean('failedFirst',failedFirst);
  report.failedFirst=await capture('dark-m3a-build-failed');
  const sentFix=await step('sendFix','window.cardRig.block("send")');
  assert.match(sentFix.composed[0]?.text??'',/FVector/,'the agent gets the whole log');
  assert.deepEqual(sentFix.blocks.map((one)=>[one.sent,one.send]),[[true,false]],'the block says the agent is on it');
  assert.match(sentFix.blocks[0].text,/^Agent is fixing the Windows build/);
  report.sentFix=await capture('dark-m3b-agent-fixing');
  // A build that didn't start: the row says so, a block tries again, and the Mac app builds on.
  await step('startFails','window.cardRig.open({scene:"startFails"})');
  const refused=await step('startFailsPress','window.cardRig.press()');
  assert.deepEqual(rows(refused),[['Mac','Building on this Mac',null],['Windows','Couldn’t send',null]]);
  assert.deepEqual(refused.blocks.map((one)=>[one.target,one.text,one.retry,one.copy]),[['windows','Windows build didn’t start'+'Try again',true,true]]);
  assert.doesNotMatch(refused.text,/this month/,'the words of the CLI never show');
  assert.match(refused.primary??'',/^Building Mac/);
  assert.doesNotMatch(refused.primary??'',/Windows/);
  clean('startFails',refused);
  report.startFails=await capture('dark-m4-build-did-not-start');
  const again=await step('startAgain','window.cardRig.block("retry")');
  assert.deepEqual(again.asked,['cloud:windows:keep','cloud:windows:keep'],'Try again starts the build again');
  // A send that didn't reach Genex: its block tries it again, the main button stays out of it.
  const unsent=await step('sendFailed','window.cardRig.open({scene:"sendFailed"})');
  assert.deepEqual(unsent.blocks.map((one)=>[one.target,one.retry,one.copy]),[['mac',true,true]]);
  assert.doesNotMatch(unsent.text,/HTTP 413/,'the words of the CLI never show');
  assert.equal(unsent.primary,null);
  report.sendFailed=await capture('dark-send-failed');
  const retried=await step('retry','window.cardRig.block("retry")');
  assert.deepEqual(retried.asked,['apps:mac'],'Try again sends that app again');
  // The same game on a PC: its Windows app is built there and starts switched on, Linux stays off.
  const pc=await step('pc','window.cardRig.open({scene:"pc"})');
  assert.deepEqual(pc.rows.map((row)=>[row.name,row.status,row.side,row.on]),[
   ['Windows','Not built','builds on this PC',true],
   ['Linux','Not built','builds on this PC',false],
  ]);
  assert.equal(pc.primary,'Build Windows');
  clean('pc',pc);
  report.pc=await capture('dark-pc-opens');
  // Its web build is ready and its Windows app, not built, is switched off: the switch stays where it was
  // left, after the publish and when the card opens again.
  const pcWeb=await step('pcWeb','window.cardRig.open({scene:"pcWeb"})');
  assert.deepEqual(pcWeb.rows.map((row)=>[row.name,row.status,row.on]),[
   ['Web','Ready to publish',true],
   ['Windows','Not built',true],
   ['Linux','Not built',false],
  ]);
  const webOnly=await step('pcWebWindowsOff','window.cardRig.toggle("windows")');
  assert.equal(webOnly.primary,'Publish to web');
  const webSent=await step('pcWebPublish','window.cardRig.press()');
  assert.deepEqual(webSent.asked.filter((one)=>!one.startsWith('review:')),['web:']);
  assert.deepEqual(webSent.rows.map((row)=>[row.name,row.on]),[['Web',true],['Windows',false],['Linux',false]],'the Windows switch stays off after the publish');
  assert.equal(webSent.primary,'Publish to web');
  clean('pcWebPublish',webSent);
  report.pcWebPublished=await capture('dark-pc-web-windows-stays-off');
  const pcWebAgain=await step('pcWebAgain','window.cardRig.open({scene:"pcWeb",again:true})');
  assert.deepEqual(pcWebAgain.rows.map((row)=>[row.name,row.on]),[['Web',true],['Windows',false],['Linux',false]],'and when the card opens again');
  assert.equal(pcWebAgain.primary,'Publish to web');
  // A Unity game with all four platforms.
  for (const theme of ['dark','light']) {
   const unity=await step(theme+'Unity','window.cardRig.open({scene:"unity",theme:"'+theme+'"})');
   assert.deepEqual(unity.rows.map((row)=>[row.name,row.status,row.on]),[
    ['Web','Live · up to date',true],
    ['Mac','Live · up to date',true],
    ['Windows','Ready to publish',true],
    ['Linux','Not built',false],
   ]);
   assert.equal(unity.primary,'Publish to Windows');
   clean('unity',unity);
   report[theme+'Unity']=await capture(theme+'-unity');
  }
  const linux=await step('linuxOn','window.cardRig.toggle("linux")');
  assert.equal(linux.primary,'Build Linux','an app the agent makes is built first, alone');
  assert.deepEqual(report.errors,[]);
  console.log('PASS Publish card: skeleton rows before the folder answers; one Build makes the Mac app here and the Windows app on Genex Cloud, kept; one Publish gives players what is built and what Genex Cloud still builds once built; both built publish together or one alone; older apps build, then update; Genex Cloud shows its clock and the hour line; done has no button; a pressed button keeps its words, fill and label colour while the press is sent; a switch off takes an app down in amber; a failed cloud build leaves the Mac app free and its block hands the log to the agent, never showing it; a build that did not start and a failed send have blocks that try again; a PC builds its Windows app there; a switch turned off stays off after the publish and when the card opens again; a Unity game lists four platforms; no "Public:", no Share assets');
 } catch(error) { report.failure=error.stack; console.error(error); await capture('failure').catch(()=>{}); }
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(report,null,2));
 app.exit(report.failure?1:0);
});`,
);
try {
  const child = spawn(resolveElectron(), fixtureElectronArgs([boot]), { env: fixtureElectronEnv(), stdio: "inherit" });
  const timer = setTimeout(() => child.kill("SIGKILL"), RUN_TIMEOUT_MS);
  try {
    const code = await new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", resolve);
    });
    if (code !== 0) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
} finally {
  await rm(profile, { recursive: true, force: true });
}
console.log(evidence);

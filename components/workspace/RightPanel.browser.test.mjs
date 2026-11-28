import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';

const require = createRequire(import.meta.url);
const { webpack } = require('next/dist/compiled/webpack/webpack.js');
const repo = path.resolve(import.meta.dirname, '../..');

test('workspace menus suspend the native browser and per-session layouts restore only regular tool tabs', { timeout: 120000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'piora-tool-menu-'));
  let browser;
  try {
    await writeFile(path.join(directory, 'ts.cjs'), `const ts=require(${JSON.stringify(require.resolve('typescript'))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`);
    await writeFile(path.join(directory, 'css.cjs'), `module.exports=function(s){const prefix=require('node:path').basename(this.resourcePath).replace(/\\W/g,'_');const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+'_'+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.append(style);export default '+JSON.stringify(names)}`);
    // Real workspace, browser and viewport queue; unrelated panels stay inert.
    const stubs = path.join(directory, 'stubs.tsx');
    await writeFile(stubs, `
const empty = () => null;
export { empty as FileExplorer, empty as FileViewer, empty as TabBar, empty as ReviewPanel,
  empty as CommandPanel, empty as SafeHarmonyPanel, empty as AutomationPanel, empty as SSHPanel,
  empty as DesignToHarmonyPanel, empty as RunChangesPane,
  empty as SideChatTabStripItems, empty as SideChatTabPanels, empty as SideChatMenuEntries, empty as MarkdownBody };
export default () => empty;`);
    await writeFile(path.join(directory, 'entry.tsx'), `
import {useEffect,useState} from 'react';import {createRoot} from 'react-dom/client';
import {I18nProvider} from '@/hooks/useI18n';import {RightPanel} from '@/components/workspace/RightPanel';
import {rightPanelLayoutScope,useRightPanelLayout} from '@/hooks/useRightPanelLayout';
import {useBrowserPanelNavigation} from '@/hooks/useBrowserPanelNavigation';
import {GoalComposerRail} from '@/components/workflow/GoalComposerRail';
import {ProposedPlanCard} from '@/components/workflow/ProposedPlanCard';
import {OPEN_WORKFLOW_PANEL_EVENT} from '@/components/workflow/workflow-events';
const noop=()=>{};
const goal = {current:{id:'fixture-goal',kind:'goal',status:'paused',objective:'Fixture goal',turnsUsed:0,turnBudget:2}};
const plan = {type:'toolCall',toolCallId:'fixture-plan',toolName:'piora_submit_plan',input:{title:'Fixture plan'}};
function App(){const[sessionId,setSessionId]=useState('fixture'),[roomId,setRoomId]=useState(null);
const layoutScope=rightPanelLayoutScope(sessionId,roomId);
const selectSession=id=>{setRoomId(null);setSessionId(id);};
const {rightPanelOpen:active,rightPanelTab:tab,rightPanelMaximized:maximized,openRightPanelTools:tools,setRightPanelOpen:setActive,setRightPanelTab:setTab,setRightPanelMaximized:setMaximized,setOpenRightPanelTools:setTools,closeWorkflowTab}=useRightPanelLayout(layoutScope,rightPanelLayoutScope('fixture'),sessionId);
useBrowserPanelNavigation(sessionId,tab,setActive,layoutScope);
useEffect(()=>{
  const open=event=>{if(event.detail.sessionId!==sessionId)return;setTab(event.detail.tab);setActive(true);};
  window.addEventListener(OPEN_WORKFLOW_PANEL_EVENT,open);
  return()=>window.removeEventListener(OPEN_WORKFLOW_PANEL_EVENT,open);
},[sessionId,setActive,setTab]);
return <I18nProvider><div style={{display:'flex',flexWrap:'wrap',width:'calc(100% - 305px)',gap:4}}><button id='outside'>Outside</button><button onClick={()=>setActive(v=>!v)}>Toggle panel</button>
<button onClick={()=>selectSession('fixture')}>Session A</button><button onClick={()=>selectSession('second')}>Session B</button>
<button onClick={()=>setRoomId('blue')}>Room Blue</button><button onClick={()=>setSessionId('second')}>Switch member</button></div>
<div style={{height:0,overflow:'visible',position:'absolute',top:0,right:0,width:300,zIndex:1}}>
<ProposedPlanCard block={plan} pending={false} sessionId={sessionId}/>
<GoalComposerRail snapshot={goal} sessionId={sessionId} enabled busy={false} running={false} error={null} onAction={async()=>true} onRefresh={async()=>{}} onOpenEditModal={noop}/>
</div>
<div id='file-panel' data-layout-scope={layoutScope} data-maximized={String(maximized)} style={{height:'calc(100vh - 130px)',marginTop:90,display:active?'flex':'none',flexDirection:'column'}}><RightPanel activeTab={tab} onActiveTabChange={setTab} openTools={tools} onOpenToolsChange={setTools} onCloseWorkflowTab={closeWorkflowTab} active={active} maximized={maximized} onMaximizedChange={setMaximized} onClosePanel={()=>setActive(false)} cwd={null} refreshKey={0} fileNavMode='tree' onFileNavModeChange={noop} runFileChanges={null} fileTabs={[]} activeFileTabId={null} canReopenClosedFileTab={false} onSelectFileTab={noop} onCloseFileTab={noop} onCloseOtherFileTabs={noop} onCloseFileTabsToRight={noop} onMoveFileTab={noop} onReopenClosedFileTab={noop} onOpenFile={noop} onDirtyChange={noop} onRefresh={noop} onMention={noop} onMentions={noop} onMentionLines={noop} selectedAutomationId={null} sessionId={sessionId} capabilities={null}/></div></I18nProvider>}
createRoot(document.getElementById('root')).render(<App/>);`);
    const alias = Object.fromEntries(['../FileExplorer', '../FileViewer', '../TabBar', './ReviewPanel', './CommandPanel', './HarmonyPanel', '../AutomationPanel', './SSHPanel', './design-to-harmony/DesignToHarmonyPanel', './RunChangesPane', '../side-chat/SideChatRightPanelSlots', '../MarkdownBody', 'next/dynamic'].map(name => [name + '$', stubs]));
    const compiler = webpack({ mode: 'development', target: 'web', devtool: false, entry: path.join(directory, 'entry.tsx'), output: { path: directory, filename: 'bundle.js' }, resolve: { extensions: ['.tsx', '.ts', '.js'], modules: ['node_modules', path.join(repo, 'node_modules')], alias: { ...alias, '@': repo } }, module: { rules: [{ test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, 'ts.cjs') }, { test: /\.css$/, use: path.join(directory, 'css.cjs') }] } });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve())));
    const css = (await readFile(path.join(repo, 'app/globals.css'), 'utf8')).replace(/^@import.*$/gm, '');
    browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chromium', headless: true });
    for (const locale of ['zh-CN', 'en']) {
      const page = await browser.newPage({ viewport: { width: 700, height: 750 } });
      page.setDefaultTimeout(15_000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.addInitScript(locale => {
        localStorage.setItem('pi-locale', locale);
        localStorage.setItem('piora-desktop-browser-onboarding-v1', 'done');
        if (!localStorage.getItem('piora-right-panel-layouts-v1') && !localStorage.getItem('piora-right-panel-tab')) {
          if (locale === 'zh-CN') {
            localStorage.setItem('piora-right-panel-layouts-v1', JSON.stringify({
              'session:fixture': { open: true, activeTab: 'goal', openTools: ['plan', 'browser', 'goal'] },
            }));
          } else {
            localStorage.setItem('piora-right-panel-tab', 'browser');
            localStorage.setItem('piora-right-panel-open', 'true');
          }
        }
        window.nativeActions = []; window.nativeViewports = [];
        const state = { sessionId: 'fixture', activeTabId: 'native-tab', url: 'https://example.test/kept-page', title: 'Existing browser tab', tabs: [{ id: 'native-tab', title: 'Existing browser tab', url: 'https://example.test/kept-page' }], canGoBack: false, canGoForward: false, loading: false };
        window.emitNativeState = () => { state.url = 'https://example.test/redirected'; window.nativeStateListener?.({ ...state }); };
        window.piDesktop = { browser: {
          setViewport: async (bounds, visible) => {
            const layoutScope = document.getElementById('file-panel')?.dataset.layoutScope;
            window.nativeViewports.push({ ...bounds, visible, layoutScope }); window.nativeVisible = visible;
            if (visible && window.delayNextShow) { window.delayNextShow = false; await new Promise(resolve => { window.finishShow = resolve; }); }
          },
          action: async input => {
            window.nativeActions.push(input);
            if (input.action === 'set_session') {
              if (window.delaySession === input.sessionId) {
                delete window.delaySession;
                await new Promise(resolve => { window.finishSession = resolve; });
              }
              state.sessionId = input.sessionId;
            }
            return { ...state };
          },
          getState: async () => ({ ...state }),
          onState: listener => { window.nativeStateListener = listener; return () => { window.nativeStateListener = null; }; },
          onDownload: () => () => {},
          importChromeBookmarks: async () => ({ bookmarkCount: 0, profiles: [] }),
        } };
      }, locale);
      await page.route('https://tool-menu.test/**', async route => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname.endsWith('.js')) return route.fulfill({ contentType: 'text/javascript', body: await readFile(path.join(directory, path.basename(pathname))) });
        if (pathname.startsWith('/fonts/')) return route.fulfill({ status: 404, body: '' });
        const snapshot = { sessionId: 'fixture', revision: 1, mode: 'default', turnBudget: 12, current: null, history: [] };
        if (pathname === '/api/agent/fixture/workflow/plan') return route.fulfill({ json: { plan: null, snapshot } });
        if (pathname === '/api/agent/fixture/workflow') return route.fulfill({ json: snapshot });
        if (pathname === '/api/settings/laboratory') return route.fulfill({ json: { planGoalEnabled: true } });
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><meta charset='utf-8'><style>${css}</style><div id='root'></div><script src='/bundle.js'></script>` });
      });
      await page.goto('https://tool-menu.test/');
      const trigger = page.getByRole('button', { name: locale === 'zh-CN' ? '打开工具' : 'Open tool', exact: true });
      const menu = page.getByRole('menu');
      const nativeVisible = visible => page.waitForFunction(expected => window.nativeVisible === expected, visible);
      await nativeVisible(true);
      await page.evaluate(() => { window.delayNextShow = true; window.dispatchEvent(new Event('resize')); });
      await page.waitForFunction(() => typeof window.finishShow === 'function');
      const initialActions = await page.evaluate(() => window.nativeActions);
      await trigger.click(); await menu.waitFor();
      assert.equal(await page.evaluate(() => window.nativeVisible), false, 'opening the menu hides the native view immediately, even with a pending resize');
      assert.equal(await menu.getByRole('menuitem').count(), 7);
      for (const item of await menu.getByRole('menuitem').all()) assert.equal(await item.isVisible(), true);
      const mark = await page.evaluate(() => { window.finishShow(); return window.nativeViewports.length; });
      await page.setViewportSize({ width: 520, height: 660 });
      await page.evaluate(() => window.emitNativeState());
      await page.waitForTimeout(300); // Includes the 250ms position reconciliation.
      assert.equal(await page.evaluate(index => window.nativeViewports.slice(index).some(call => call.visible), mark), false, 'late replies, resizing and page events cannot reshow the browser over the menu');
      const output = process.env.PIORA_RIGHT_PANEL_REPORT_DIR ?? path.join(repo, '.verification/tool-menu');
      await mkdir(output, { recursive: true });
      await page.screenshot({ path: path.join(output, `${locale}.png`) });
      await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' }); await nativeVisible(true);
      await trigger.click(); await nativeVisible(false);
      await page.locator('#outside').click(); await nativeVisible(true);
      await trigger.click(); await nativeVisible(false); await trigger.click(); await nativeVisible(true);
      assert.deepEqual(await page.evaluate(() => window.nativeActions), initialActions, 'opening and closing the menu never reloads or replaces the browser tab');
      await trigger.click();
      await menu.getByRole('menuitem', { name: locale === 'zh-CN' ? '终端' : 'Terminal', exact: true }).click();
      await nativeVisible(false);
      await page.getByRole('tab', { name: locale === 'zh-CN' ? '浏览器' : 'Browser', exact: true }).click();
      await nativeVisible(true);
      await trigger.click(); await nativeVisible(false);
      await page.getByRole('button', { name: 'Toggle panel', exact: true }).click(); await menu.waitFor({ state: 'hidden' });
      await page.getByRole('button', { name: 'Toggle panel', exact: true }).click(); await nativeVisible(true);
      assert.equal(await menu.count(), 0, 'reopening the panel cannot restore a stale menu');

      const actionsBeforeDialogs = await page.evaluate(() => window.nativeActions);
      await page.evaluate(() => {
        window.finishShow = undefined;
        window.delayNextShow = true;
        window.dispatchEvent(new Event('resize'));
      });
      await page.waitForFunction(() => typeof window.finishShow === 'function');
      await page.evaluate(() => {
        const portal = document.createElement('div');
        portal.id = 'dialog-portal';
        portal.innerHTML = '<div role="dialog" aria-modal="true" style="position:fixed;top:0;left:0;width:80px;height:20px">Settings</div>';
        document.body.append(portal);
      });
      await nativeVisible(false);
      assert.ok(await page.evaluate(() => window.nativeViewports.at(-1).width > 0), 'temporary suspension retains the measured browser bounds');
      const afterDialog = await page.evaluate(() => {
        const dialog = document.createElement('dialog');
        dialog.id = 'confirmation';
        dialog.textContent = 'Confirmation';
        document.body.append(dialog);
        dialog.showModal();
        document.getElementById('dialog-portal').hidden = true;
        window.finishShow();
        return window.nativeViewports.length;
      });
      await page.setViewportSize({ width: 600, height: 720 });
      await page.evaluate(() => window.emitNativeState());
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(index => window.nativeViewports.slice(index).some(call => call.visible), afterDialog), false,
        'closing one modal and refreshing the viewport cannot cover another modal');
      await page.evaluate(() => document.getElementById('confirmation').close());
      await nativeVisible(true);
      await page.evaluate(() => { document.getElementById('dialog-portal').hidden = false; });
      await nativeVisible(false);
      await page.evaluate(() => document.getElementById('dialog-portal').remove());
      await nativeVisible(true);

      await page.evaluate(() => {
        const popup = document.createElement('div');
        popup.id = 'anchored-popup';
        popup.setAttribute('role', 'menu');
        popup.setAttribute('popover', 'manual');
        popup.style.cssText = 'position:fixed;inset:auto;top:0;left:0;margin:0;width:12px;height:12px';
        document.body.append(popup);
        popup.showPopover();
      });
      await page.locator('#anchored-popup').waitFor();
      assert.equal(await page.evaluate(() => window.nativeVisible), true, 'a menu outside the browser leaves the native page visible');
      await page.evaluate(() => {
        const bounds = window.nativeViewports.findLast(item => item.visible);
        const popup = document.getElementById('anchored-popup');
        popup.style.left = `${bounds.x + 4}px`;
        popup.style.top = `${bounds.y + 4}px`;
      });
      await nativeVisible(false);
      await page.evaluate(() => document.getElementById('anchored-popup').hidePopover());
      await nativeVisible(true);
      await page.evaluate(() => document.getElementById('anchored-popup').showPopover());
      await nativeVisible(false);
      await page.evaluate(() => document.getElementById('anchored-popup').remove());
      await nativeVisible(true);
      assert.deepEqual(await page.evaluate(() => window.nativeActions), actionsBeforeDialogs, 'portals hide the existing view without starting browser navigation');

      const panel = page.locator('#file-panel');
      const toolTabs = panel.getByRole('tablist').first().getByRole('tab');
      const select = name => page.getByRole('button', { name, exact: true }).click();
      const browserLabel = locale === 'zh-CN' ? '浏览器' : 'Browser';
      const terminalLabel = locale === 'zh-CN' ? '终端' : 'Terminal';
      const workflowTabs = panel.locator('#workspace-plan-tab, #workspace-goal-tab');
      const planTab = panel.getByRole('tab', { name: locale === 'zh-CN' ? '计划' : 'Plan', exact: true });
      const goalTab = panel.getByRole('tab', { name: locale === 'zh-CN' ? '目标' : 'Goal', exact: true });
      assert.deepEqual(await toolTabs.allTextContents(), [browserLabel, terminalLabel]);
      await page.getByTestId('proposed-plan-open-editor').click();
      await planTab.waitFor();
      await page.getByTestId('plan-side-panel-empty').waitFor();
      assert.equal(await planTab.getAttribute('aria-selected'), 'true');
      await page.getByTestId('goal-rail-open-panel').click();
      await goalTab.waitFor();
      assert.equal(await workflowTabs.count(), 1, 'only the currently viewed details appear in the tab strip');
      await panel.locator('#workspace-goal-tab + button').click();
      await workflowTabs.waitFor({ state: 'detached' });
      assert.equal(await toolTabs.first().getAttribute('aria-selected'), 'true', 'closing Goal returns to the previous tool');
      await page.getByTestId('proposed-plan-open-editor').click();
      await planTab.waitFor();
      await panel.getByRole('tab', { name: terminalLabel, exact: true }).click();
      await workflowTabs.waitFor({ state: 'detached' });
      await panel.getByRole('tab', { name: browserLabel, exact: true }).click();
      await page.getByTestId('goal-rail-open-panel').click();
      await goalTab.waitFor();
      await select('Toggle panel');
      await select('Toggle panel');
      await workflowTabs.waitFor({ state: 'detached' });
      await page.getByTestId('goal-rail-open-panel').click();
      await goalTab.waitFor();
      await select('Session B');
      await panel.waitFor({ state: 'hidden' });
      await select('Toggle panel');
      await trigger.click();
      await menu.getByRole('menuitem', { name: /^SSH/ }).click();
      assert.equal(await toolTabs.count(), 1);
      const ssh = toolTabs.first();
      assert.match(await ssh.textContent(), /^SSH/);
      assert.equal(await ssh.getAttribute('aria-selected'), 'true');
      await page.getByRole('button', { name: locale === 'zh-CN' ? '最大化右侧工作区' : 'Maximize right workspace', exact: true }).click();
      assert.equal(await panel.getAttribute('data-maximized'), 'true');

      await select('Session A');
      await panel.waitFor();
      assert.deepEqual(await toolTabs.allTextContents(), [browserLabel, terminalLabel]);
      assert.equal(await toolTabs.first().getAttribute('aria-selected'), 'true');
      assert.equal(await panel.getAttribute('data-maximized'), 'false');
      await select('Toggle panel');
      await select('Session B');
      await panel.waitFor();
      assert.equal(await panel.getAttribute('data-maximized'), 'true');

      await page.reload();
      await panel.waitFor({ state: 'hidden' });
      await select('Session B');
      await panel.waitFor();
      assert.equal(await panel.getAttribute('data-maximized'), 'true');
      assert.equal(await toolTabs.count(), 1);
      assert.equal(await toolTabs.first().getAttribute('aria-selected'), 'true');
      await select('Session A');
      await panel.waitFor({ state: 'hidden' });
      await select('Toggle panel');
      assert.deepEqual(await toolTabs.allTextContents(), [browserLabel, terminalLabel]);
      await page.getByTestId('proposed-plan-open-editor').click();
      await planTab.waitFor();
      await page.reload();
      await panel.waitFor();
      assert.deepEqual(await toolTabs.allTextContents(), [browserLabel, terminalLabel]);
      assert.equal(await workflowTabs.count(), 0, 'refresh restores the previous regular tabs without Plan or Goal');

      await select('Room Blue');
      await panel.waitFor({ state: 'hidden' });
      await select('Toggle panel');
      await trigger.click();
      await menu.getByRole('menuitem', { name: new RegExp('^' + browserLabel) }).click();
      await nativeVisible(true);
      assert.deepEqual(await toolTabs.allTextContents(), [browserLabel]);
      await select('Switch member');
      await panel.waitFor({ state: 'hidden' });
      await nativeVisible(false);
      await select('Toggle panel');
      await nativeVisible(true);
      const resumeViewports = await page.evaluate(() => {
        window.delaySession = 'fixture';
        return window.nativeViewports.length;
      });
      await select('Session A');
      await page.waitForFunction(() => typeof window.finishSession === 'function');
      await nativeVisible(false);
      const showedBeforeSessionReady = await page.evaluate(index => window.nativeViewports.slice(index)
        .some(view => view.layoutScope === 'session:fixture' && view.visible), resumeViewports);
      assert.equal(showedBeforeSessionReady, false, 'the restored layout must wait for its own native browser session');
      await page.evaluate(() => window.finishSession());
      await nativeVisible(true);
      assert.deepEqual(await toolTabs.allTextContents(), [browserLabel, terminalLabel]);

      await page.evaluate(() => {
        localStorage.removeItem('piora-right-panel-layouts-v1');
        localStorage.setItem('piora-right-panel-tab', 'plan');
        localStorage.setItem('piora-right-panel-open', 'true');
      });
      await page.reload();
      await panel.waitFor();
      assert.equal(await toolTabs.count(), 0, 'legacy global Plan selection does not become a regular tab');
      assert.deepEqual(errors, []);
      await page.close();
    }
  } finally {
    await browser?.close();
    assert.equal(path.dirname(directory), path.resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true });
  }
});

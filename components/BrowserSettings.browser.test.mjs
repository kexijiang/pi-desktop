import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { webpack } = require("next/dist/compiled/webpack/webpack.js");
const repo = path.resolve(import.meta.dirname, "..");

test("browser settings stays transparent over wallpaper without square wrapper and shows breadcrumbs only on subpages", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "piora-browser-settings-ui-"));
  const artifacts = path.join(repo, ".verification/browser-settings-ui");
  let browser;
  try {
    await mkdir(artifacts, { recursive: true });
    await writeFile(
      path.join(directory, "ts.cjs"),
      `const ts=require(${JSON.stringify(require.resolve("typescript"))});module.exports=s=>ts.transpileModule(s,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText`,
    );
    await writeFile(
      path.join(directory, "css.cjs"),
      `module.exports=function(s){const prefix=require('node:path').basename(this.resourcePath,'.module.css')+'_';const names=Object.fromEntries([...s.matchAll(/\\.([a-zA-Z][\\w-]*)/g)].map(m=>[m[1],prefix+m[1]]));const css=s.replace(/\\.([a-zA-Z][\\w-]*)/g,(_,n)=>'.'+names[n]);return 'const style=document.createElement("style");style.textContent='+JSON.stringify(css)+';document.head.appendChild(style);export default '+JSON.stringify(names)}`,
    );
    await writeFile(
      path.join(directory, "entry.tsx"),
      `import React from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "@/hooks/useI18n";
import { BrowserSettings } from "@/components/BrowserSettings";
import dialogStyles from "@/components/SettingsDialog.module.css";

createRoot(document.getElementById("root")!).render(
  <I18nProvider>
    <div className="settings-backdrop" style={{ minHeight: "100vh", position: "relative" }}>
      <div className={\`\${dialogStyles.dialog} settings-dialog\`}>
        <main className={\`\${dialogStyles.content} settings-content\`}>
          <div className={dialogStyles.contentBody}>
            <div className={\`\${dialogStyles.contentCanvas} settings-embedded-section\`}>
              <div className={dialogStyles.tabPanel}>
                <BrowserSettings />
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  </I18nProvider>
);`,
    );

    const compiler = webpack({
      mode: "development",
      target: "web",
      devtool: false,
      entry: path.join(directory, "entry.tsx"),
      output: { path: directory, filename: "bundle.js", publicPath: "/" },
      resolve: { extensions: [".tsx", ".ts", ".js"], modules: [path.join(repo, "node_modules")], alias: { "@": repo } },
      module: {
        rules: [
          { test: /\.tsx?$/, exclude: /node_modules/, use: path.join(directory, "ts.cjs") },
          { test: /\.css$/, use: path.join(directory, "css.cjs") },
        ],
      },
    });
    await new Promise((resolve, reject) => compiler.run((error, stats) => compiler.close(() => (
      error || stats.hasErrors() ? reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()
    ))));

    const preflight = await readFile(path.join(repo, "node_modules/tailwindcss/preflight.css"), "utf8");
    const globalCss = (await readFile(path.join(repo, "app/globals.css"), "utf8")).replace(/^@import.*$/gm, "");
    const bgCss = await readFile(path.join(repo, "app/theme-backgrounds.css"), "utf8");
    const html = `<!doctype html><html lang="zh-CN" data-app-background-active="true" style="--app-background-fallback:linear-gradient(135deg,#b5d8ff 0%,#f0d9ff 100%);--app-background-overlay:24%"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${preflight}\n${globalCss}\n${bgCss}body{margin:0;color:var(--text);font-family:var(--ui-font-family)}</style><div id="root"></div><script src="/bundle.js"></script></html>`;

    browser = await chromium.launch({ channel: process.platform === "win32" ? "msedge" : "chromium", headless: true });
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, locale: "zh-CN" });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem("pi-locale", "zh-CN");
      window.piDesktop = {
        browser: {
          getPreferences: async () => ({ directory: "C:\\Users\\lyh\\Downloads", effectiveDirectory: "C:\\Users\\lyh\\Downloads", askEachTime: false }),
          setPreferences: async (next) => ({ directory: next.directory, effectiveDirectory: next.directory || "C:\\Users\\lyh\\Downloads", askEachTime: next.askEachTime }),
          tools: async (action) => {
            if (action === "history") return [];
            if (action === "downloads") return [];
            if (action === "deviceDefault") return false;
            return null;
          },
          getState: async () => ({ url: "about:blank" }),
        },
        selectDirectory: async () => null,
      };
    });

    await page.route("http://browser-settings.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith(".js")) return route.fulfill({ contentType: "text/javascript", body: await readFile(path.join(directory, path.basename(pathname))) });
      if (pathname.startsWith("/fonts/")) return route.fulfill({ contentType: "font/woff2", body: await readFile(path.join(repo, "public", pathname.slice(1))) });
      return route.fulfill({ contentType: "text/html", body: html });
    });

    await page.goto("http://browser-settings.test/");
    const section = page.locator('[data-profile-section="browser"]');
    await section.waitFor();

    // 1. No opaque rectangular background behind browser settings over wallpaper
    const rootMetrics = await section.evaluate(el => {
      const home = el.parentElement;
      const homeStyle = getComputedStyle(home);
      const bodyStyle = getComputedStyle(el);
      const cards = [
        el.querySelector('[data-settings-id="browser.downloads"]'),
        el.querySelector("#browser-zoom-label")?.closest("section"),
        el.querySelector('[class*="navList"]'),
      ].filter(Boolean).map(card => {
        const s = getComputedStyle(card);
        return { radius: s.borderRadius, expectedRadius: s.getPropertyValue("--radius-panel").trim(), background: s.backgroundColor, width: card.getBoundingClientRect().width };
      });
      return { homeBg: homeStyle.backgroundColor, bodyPaddingLeft: bodyStyle.paddingLeft, cards };
    });
    assert.equal(rootMetrics.homeBg, "rgba(0, 0, 0, 0)", "browser settings wrapper must stay transparent over wallpaper");
    assert.equal(rootMetrics.bodyPaddingLeft, "0px", "pageBody must not add redundant inner gutter");
    assert.equal(rootMetrics.cards.length, 3);
    for (const card of rootMetrics.cards) {
      assert.equal(card.radius, card.expectedRadius);
      assert.equal(card.background, rootMetrics.cards[0].background);
      assert.ok(card.width <= 760);
    }

    // 2. Root browser page omits redundant disabled breadcrumb strip
    assert.equal(await page.getByRole("navigation", { name: "浏览器设置路径" }).count(), 0);
    await page.screenshot({ path: path.join(artifacts, "browser-root-wallpaper.png"), fullPage: true, animations: "disabled" });

    // 3. Navigating into a subpage displays breadcrumbs and back/forward work
    await page.getByRole("button", { name: "历史记录" }).click();
    await page.locator('[data-profile-section="history"]').waitFor();
    const crumbs = page.getByRole("navigation", { name: "浏览器设置路径" });
    await crumbs.waitFor();
    assert.equal(await crumbs.getByRole("button", { name: "后退" }).isDisabled(), false);
    await page.screenshot({ path: path.join(artifacts, "browser-subpage-wallpaper.png"), fullPage: true, animations: "disabled" });

    await crumbs.getByRole("button", { name: "后退" }).click();
    await section.waitFor();
    // Forward stack is non-empty, so breadcrumbs stay available to go forward
    assert.equal(await crumbs.getByRole("button", { name: "前进" }).isDisabled(), false);

    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

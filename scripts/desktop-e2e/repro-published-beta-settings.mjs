import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const { runDesktopScenario } = await import(pathToFileURL(resolve("scripts/desktop-e2e/harness.mjs")).href);
const [executableArg, mode] = process.argv.slice(2);
const executable = !executableArg || executableArg === "-" ? undefined : resolve(executableArg);
const expectFixed = mode === "fixed";
const evidence = { application: executable ? mode : "development", browserCards: [], restoreButtons: [] };
const scenario = {
  id: "browser-settings-trash-remote",
  scope: "Windows Electron, real application routes, synthetic recycle bin item and an isolated profile",
  coverage: ["browser settings card corners", "remote menu and route presence", "recycle bin button geometry and restoration"],
  limits: ["Synthetic conversation only", "Remote status checked through the local renderer"],
  async prepare({ paths, directory, report }) {
    const id = randomUUID();
    const project = join(directory, "fixture workspace with a long project directory name");
    await mkdir(project);
    const original = join(paths.agent, "sessions", "--fixture-project--", id + ".jsonl");
    const trash = join(paths.agent, "trash", "sessions");
    const trashed = join(trash, id, "fixture.jsonl");
    await mkdir(join(trash, id), { recursive: true });
    const title = "A long conversation title to verify the complete restore button at small window sizes";
    const timestamp = new Date().toISOString();
    const contents = [
      { type: "session", version: 3, id, cwd: project, timestamp },
      { type: "message", id: "a1000001", parentId: null, timestamp, message: { role: "user", content: "Synthetic restore verification", timestamp: Date.now() } },
      { type: "session_info", id: "a1000002", parentId: "a1000001", timestamp, name: title },
    ].map(row => JSON.stringify(row)).join("\n") + "\n";
    await writeFile(trashed, contents);
    await writeFile(join(trash, id + ".manifest.json"), JSON.stringify({ id, title, cwd: project, trashedAt: Date.now(), entries: [{ original, trashed }] }));
    this.fixture = { title, original, contents };
    report.fixture = { data: "synthetic", application: evidence.application };
  },
  async run({ page, directory, step, screenshot }) {
    const dialog = page.getByRole("dialog", { name: /^(Settings|设置)$/ });
    await step("browser-card-corners-and-remote-entry", async () => {
      await page.setViewportSize({ width: 1320, height: 850 });
      await page.getByRole("button", { name: /^(Settings|设置)$/ }).click();
      await dialog.getByTestId("settings-browser").click();
      const browser = dialog.locator('[data-profile-section="browser"]');
      await browser.waitFor();
      await browser.locator("#browser-download-directory:enabled").waitFor();
      evidence.browserCards = await browser.evaluate(section => {
        const target = {
          downloads: section.querySelector('[data-settings-id="browser.downloads"]'),
          zoom: section.querySelector("#browser-zoom-label")?.closest("section"),
          menu: section.querySelector('[class*="navList"]'),
        };
        const report = Object.entries(target).map(([name, element]) => {
          if (!element) throw new Error("Missing browser settings card " + name);
          const style = getComputedStyle(element);
          return {
            name, radius: style.borderTopLeftRadius, bottomRadius: style.borderBottomRightRadius,
            panelRadius: style.getPropertyValue("--radius-panel").trim(), background: style.backgroundColor,
          };
        });
        return report;
      });
      evidence.remoteMenuCount = await dialog.getByRole("button", { name: /^(Remote Control|远程控制)$/i }).count();
      evidence.remoteStatus = await page.evaluate(async () => {
        const response = await fetch("/api/remote/status", { cache: "no-store" });
        const body = response.ok ? await response.json() : null;
        return { status: response.status, hasConnector: Boolean(body?.connector) };
      });
      await screenshot("browser-settings.png");
      if (expectFixed) {
        assert.ok(evidence.browserCards.every(card => card.radius === card.panelRadius && card.bottomRadius === card.panelRadius), JSON.stringify(evidence.browserCards));
        assert.equal(evidence.remoteMenuCount, 0);
        assert.equal(evidence.remoteStatus.status, 404);
      }
    });
    await step("recycle-bin-control-geometry-and-restoration", async () => {
      await dialog.getByTestId("settings-archived").click();
      await dialog.getByRole("button", { name: /^(Recycle Bin|Trash|回收站)$/i }).click();
      const trash = dialog.locator('[data-settings-id="trash"]');
      const row = trash.locator("article").filter({ hasText: this.fixture.title });
      const restore = row.getByRole("button", { name: /^(Restore|恢复)$/ });
      await restore.waitFor();
      for (const width of [1320, 1024, 700, 490, 390]) {
        await page.setViewportSize({ width, height: 850 });
        const geometry = await restore.evaluate(button => {
          const { left, right, width: actualWidth } = button.getBoundingClientRect();
          const style = getComputedStyle(button);
          const label = document.createRange();
          label.selectNodeContents(button);
          const text = label.getBoundingClientRect();
          const row = button.closest("article").getBoundingClientRect();
          const expectedWidth = text.width + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
          return { actualWidth, expectedWidth, fit: actualWidth >= expectedWidth - 1 && left >= row.left && right <= row.right + 1 && right <= innerWidth + 1, textWidth: text.width };
        });
        evidence.restoreButtons.push({ viewport: width, ...geometry });
        if (width === 1024 || width === 390) await screenshot("trash-" + width + ".png");
        if (expectFixed) assert.equal(geometry.fit, true, JSON.stringify({ width, ...geometry }));
      }
      await page.setViewportSize({ width: 1024, height: 850 });
      await restore.click();
      await trash.getByRole("status").filter({ hasText: /Restored|已恢复/i }).waitFor();
      assert.equal(await readFile(this.fixture.original, "utf8"), this.fixture.contents);
      await row.waitFor({ state: "hidden" });
      evidence.restoreSucceeded = true;
    });
    await writeFile(join(directory, "installed-settings-evidence.json"), JSON.stringify(evidence, null, 2));
  },
};
const result = await runDesktopScenario({ root, executable, scenario, timeoutMs: 900_000, stepTimeoutMs: executable ? 60_000 : 300_000,
  ...(process.env.PIORA_TEST_ELECTRON_DIST ? { electronDist: process.env.PIORA_TEST_ELECTRON_DIST } : {}) });
console.log(JSON.stringify({ directory: result.directory, status: result.report.status, failedStep: result.report.failedStep, error: result.report.error, evidence }));
process.exitCode = result.report.status === "passed" ? 0 : 1;

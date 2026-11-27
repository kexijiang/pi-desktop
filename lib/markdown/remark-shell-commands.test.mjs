import assert from 'node:assert/strict';
import test from 'node:test';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import rehypeStringify from 'rehype-stringify';
import { createJiti } from 'jiti';
const { remarkShellCommands } = await createJiti(import.meta.url).import('./remark-shell-commands.ts');
const parser = unified().use(remarkParse).use(remarkShellCommands);
test('command recognition preserves ampersands, quotes, Windows paths and literal package placeholders', async () => {
  // Text fixture only: never execute these commands.
  const source = String.raw`adb uninstall <app.package> & adb install "D:\bak\app-china-normal-<vendor>-release-formal.apk" & adb shell pm clear <app.package>.launcher`;
  const tree = await parser.run(parser.parse(source), source);
  assert.equal(tree.children[0].type, 'code');
  assert.equal(tree.children[0].value, source);
  const html = String(await unified().use(remarkParse).use(remarkShellCommands).use(remarkRehype).use(rehypeStringify).process(source));
  assert.match(html, /<pre><code class="language-sh">/);
  assert.match(html, /&#x3C;app.package>/);
  assert.match(html, /&#x26; adb install/);
});
test('ordinary prose, inline code, existing fences, HTML and entities retain their meaning', async () => {
  for (const source of ['Use adb install "example.apk" & retry.', 'git is useful & convenient', '<div>adb shell echo "hello"</div>', '`adb shell echo "hello"`', '```powershell\nadb shell echo "hello"\n```', 'adb installation notes', 'Some text\nadb shell echo test']) {
    const before = parser.parse(source);
    assert.deepEqual(await parser.run(structuredClone(before), source), before);
  }
  const source = 'adb shell echo "&amp;"';
  assert.equal((await parser.run(parser.parse(source), source)).children[0].value, source);
});

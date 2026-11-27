const STABLE_PAGE_MS = 750;

interface InteractionPage {
  ready: boolean;
  route: string;
  dialogs: number;
  forms: number;
  challenges: number;
  notices: number;
  marker: boolean;
}

function pageState(selector: string | null): InteractionPage {
  const visible = (element: Element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return bounds.width > 0 && bounds.height > 0 && style.visibility === "visible" && style.display !== "none";
  };
  const find = (query: string) => Array.from(document.querySelectorAll(query)).filter(visible);
  let marker = false;
  if (selector) {
    try { marker = find(selector).length > 0; } catch { /* An invalid selector cannot indicate completion. */ }
  }
  const dialogs = find("dialog[open], [role=dialog], [role=alertdialog]");
  const forms = find("form").filter(form => Array.from(form.querySelectorAll("input, button, select, textarea")).some(visible));
  const challenges = find("iframe").filter(frame =>
    /captcha|turnstile|challenge/i.test((frame.getAttribute("title") ?? "") + " " + (frame.getAttribute("src") ?? "")));
  const notices = find("[role=status], [role=alert], [aria-live]:not([aria-live=off])").filter(notice => {
    const text = notice.textContent?.slice(0, 240).toLowerCase() ?? "";
    return /\b(?:completed|confirmed|successful|successfully|verified|submitted)\b|成功|验证通过|已完成|已提交/.test(text)
      && !/\b(?:not|failed|unsuccessful|error|yet|pending)\b|未|失败|错误/.test(text);
  });
  return {
    ready: (location.protocol === "http:" || location.protocol === "https:")
      && document.readyState !== "loading" && find("[aria-busy=true], [aria-invalid=true]").length === 0,
    route: location.origin + location.pathname + (location.hash.startsWith("#/") ? location.hash.split("?")[0] : ""),
    dialogs: dialogs.length,
    forms: forms.length,
    challenges: challenges.length,
    notices: notices.length,
    marker,
  };
}

export function browserInteractionProbe(selector?: string): string {
  return `(${pageState.toString()})(${JSON.stringify(selector ?? null)})`;
}

function readPage(value: unknown): InteractionPage | null {
  if (!value || typeof value !== "object") return null;
  const page = value as Partial<InteractionPage>;
  if (typeof page.ready !== "boolean" || typeof page.route !== "string" || typeof page.marker !== "boolean"
    || ![page.dialogs, page.forms, page.challenges, page.notices].every(Number.isSafeInteger)) return null;
  return page as InteractionPage;
}

interface Observation {
  tabId: string;
  selector: string | undefined;
  before: InteractionPage | null;
  inputVersion: number;
  candidate: { signature: string; since: number } | null;
}

export class BrowserInteractionWaits {
  private readonly observations = new Map<string, Observation>();

  constructor(
    private readonly observe: (tabId: string, script: string) => Promise<unknown>,
    private readonly now: () => number,
  ) {}

  async begin(sessionId: string, tabId: string, selector?: string): Promise<void> {
    const observation: Observation = { tabId, selector, before: null, inputVersion: 0, candidate: null };
    this.observations.set(sessionId, observation);
    observation.before = await this.read(observation);
  }

  noteInput(sessionId: string, tabId: string): void {
    const observation = this.observations.get(sessionId);
    if (observation?.tabId !== tabId) return;
    observation.inputVersion++;
    observation.candidate = null;
  }

  async check(sessionId: string, tabId: string): Promise<boolean> {
    const observation = this.observations.get(sessionId);
    if (observation?.tabId !== tabId || (!observation.inputVersion && !observation.selector)) return false;
    const inputVersion = observation.inputVersion;
    const after = await this.read(observation);
    if (this.observations.get(sessionId) !== observation || observation.inputVersion !== inputVersion) return false;
    const before = observation.before;
    if (!before && after) observation.before = after;

    // A stable change hands back control for a fresh snapshot. It does not
    // establish whether the user's action was approved or successful.
    const advanced = before && after?.ready && (observation.selector
      ? !before.marker && after.marker
      : inputVersion > 0 && (after.route !== before.route || after.dialogs < before.dialogs
        || after.forms < before.forms || after.challenges < before.challenges || after.notices > before.notices));
    if (!advanced || !after) {
      observation.candidate = null;
      return false;
    }
    const signature = JSON.stringify(after);
    if (observation.candidate?.signature !== signature) {
      observation.candidate = { signature, since: this.now() };
      return false;
    }
    return this.now() - observation.candidate.since >= STABLE_PAGE_MS;
  }

  delete(sessionId: string): void {
    this.observations.delete(sessionId);
  }

  private async read(observation: Observation): Promise<InteractionPage | null> {
    try { return readPage(await this.observe(observation.tabId, browserInteractionProbe(observation.selector))); }
    catch { return null; /* A navigation can temporarily replace the document. */ }
  }
}

import { emitKeypressEvents } from "node:readline";
import { spawn, type ChildProcess } from "node:child_process";
import { connectedRepository } from "@thestraylight/heptapod-core/connected-repository";
import { loadPullRequestPage, type OpenPullRequest } from "@thestraylight/heptapod-core/setup";

const PAGE_SIZE = 10;
const MAX_PULL_REQUESTS = 250;
const VIEWPORT_SIZE = 10;
const SELECTOR_HEIGHT = VIEWPORT_SIZE + 5;
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ACCENT = "\x1b[38;2;125;211;252m";
const SUCCESS = "\x1b[38;2;74;222;128m";
const DANGER = "\x1b[38;2;248;113;113m";
const MUTED = "\x1b[38;2;148;163;184m";
const RESET_COLOR = "\x1b[39m";
const HEADING = "\x1b[1mHeptapod\x1b[22m · Select pull requests";
const INGESTION_SPINNER_PROGRAM = `
const frames = ${JSON.stringify(SPINNER_FRAMES.map((frame) => `${ACCENT}${frame}${RESET_COLOR}`))};
const row = Number(process.argv[1]);
let frame = 0;
const paint = () => {
  process.stdout.write("\\x1b7\\x1b[" + row + ";1H" + frames[frame] + "\\x1b8");
  frame = (frame + 1) % frames.length;
};
paint();
setInterval(paint, 80);
`;

interface DrawStatus {
  frame?: number;
  selectedCount: number;
  loadingMore?: boolean;
  loadError?: string;
}

function accent(value: string): string {
  return `${ACCENT}${value}${RESET_COLOR}`;
}

function success(value: string): string {
  return `${SUCCESS}${value}${RESET_COLOR}`;
}

function danger(value: string): string {
  return `${DANGER}${value}${RESET_COLOR}`;
}

function muted(value: string): string {
  return `${MUTED}${value}${RESET_COLOR}`;
}

function truncate(value: string, width: number): string {
  const characters = [...value];
  if (characters.length <= width) return value;
  return width <= 1 ? "…" : `${characters.slice(0, width - 1).join("")}…`;
}

function enterTuiScreen(onRestore: () => void = () => {}): () => void {
  let open = true;
  const restore = () => {
    if (!open) return;
    open = false;
    onRestore();
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };
  process.once("exit", restore);
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  return () => {
    process.off("exit", restore);
    restore();
  };
}

function renderStatus(status: DrawStatus, columns: number): string {
  const detail = `${status.selectedCount} selected${status.loadError ? ` · Could not load more: ${status.loadError}` : ""}`;
  const indicator = status.loadingMore ? accent(SPINNER_FRAMES[status.frame ?? 0]) : " ";
  return `${indicator} ${truncate(detail, Math.max(1, columns - 2))}`;
}

export function renderPullRequestSelector(
  pullRequests: OpenPullRequest[],
  selected: Set<number>,
  cursor: number,
  status: DrawStatus,
  columns = process.stdout.columns ?? 100,
  clear = true,
): string {
  const viewportStart = Math.min(
    Math.max(0, cursor - VIEWPORT_SIZE + 1),
    Math.max(0, pullRequests.length - VIEWPORT_SIZE),
  );
  const visible = pullRequests.slice(viewportStart, viewportStart + VIEWPORT_SIZE);
  const rows = [HEADING, ""];
  for (let offset = 0; offset < VIEWPORT_SIZE; offset += 1) {
    const pullRequest = visible[offset];
    if (!pullRequest) { rows.push(""); continue; }
    const index = viewportStart + offset;
    const active = index === cursor ? accent("›") : " ";
    const checked = selected.has(pullRequest.number) ? accent("x") : " ";
    const plainPrefix = `  [ ] #${pullRequest.number} `;
    rows.push(`${active} [${checked}] #${pullRequest.number} ${truncate(pullRequest.title, Math.max(1, columns - plainPrefix.length))}`);
  }
  rows.push("", renderStatus(status, columns), truncate("↑/↓ move · space toggle · a toggle all · enter start · q cancel", columns));
  return `${clear ? "\x1b[2J\x1b[H" : ""}${rows.join("\n")}\n`;
}

function draw(pullRequests: OpenPullRequest[], selected: Set<number>, cursor: number, status: DrawStatus, replace: boolean): void {
  process.stdout.write(`${replace ? `\x1b[${SELECTOR_HEIGHT}A\r` : ""}\x1b[J${renderPullRequestSelector(
    pullRequests, selected, cursor, status, process.stdout.columns ?? 100, false,
  )}`);
}

function drawStatus(status: DrawStatus): void {
  process.stdout.write(`\x1b[2A\r\x1b[2K${renderStatus(status, process.stdout.columns ?? 100)}\x1b[2B\r`);
}

function startLoadingSpinner(label: string): () => void {
  let frame = 0;
  const paint = () => {
    process.stdout.write(`\x1b[2J\x1b[H${HEADING}\n\n${accent(SPINNER_FRAMES[frame])} ${label}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };
  paint();
  const timer = setInterval(paint, 80);
  return () => {
    clearInterval(timer);
    process.stdout.write("\x1b[2J\x1b[H");
  };
}

export async function choosePullRequests(root: string): Promise<OpenPullRequest[]> {
  const closeScreen = enterTuiScreen();
  const stopLoading = startLoadingSpinner("Loading pull requests…");
  let repository: Awaited<ReturnType<typeof connectedRepository>>;
  let firstPage: Awaited<ReturnType<typeof loadPullRequestPage>>;
  try {
    repository = await connectedRepository(root);
    if (!repository.githubUrl) throw new Error("The current repository needs a GitHub origin before pull requests can be listed.");
    firstPage = await loadPullRequestPage(repository.name, false, undefined, PAGE_SIZE);
  } catch (error) {
    stopLoading();
    closeScreen();
    throw error;
  }
  stopLoading();
  const pullRequests = [...firstPage.pullRequests];
  let nextCursor = firstPage.hasNextPage ? firstPage.endCursor ?? undefined : undefined;
  if (!pullRequests.length) { closeScreen(); return []; }
  const selected = new Set<number>();
  let active = 0;
  let loadingMore = false;
  let loadError: string | undefined;
  let spinnerFrame = 0;
  let advanceAfterLoad = false;
  let finished = false;
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  let spinnerTimer: NodeJS.Timeout | undefined;
  let drawn = false;
  const status = (): DrawStatus => ({ frame: spinnerFrame, selectedCount: selected.size, loadingMore, loadError });
  const redraw = () => {
    draw(pullRequests, selected, active, status(), drawn);
    drawn = true;
  };
  const loadMore = async () => {
    if (finished || loadingMore || !nextCursor || pullRequests.length >= MAX_PULL_REQUESTS) return;
    loadingMore = true;
    loadError = undefined;
    const cursor = nextCursor;
    spinnerTimer = setInterval(() => {
      spinnerFrame = (spinnerFrame + 1) % SPINNER_FRAMES.length;
      drawStatus(status());
    }, 80);
    redraw();
    try {
      const page = await loadPullRequestPage(repository.name, false, cursor, PAGE_SIZE);
      const known = new Set(pullRequests.map((pullRequest) => pullRequest.number));
      const additions = page.pullRequests.filter((pullRequest) => !known.has(pullRequest.number));
      const previousLength = pullRequests.length;
      pullRequests.push(...additions.slice(0, MAX_PULL_REQUESTS - pullRequests.length));
      nextCursor = page.hasNextPage && pullRequests.length < MAX_PULL_REQUESTS ? page.endCursor ?? undefined : undefined;
      if (advanceAfterLoad && pullRequests.length > previousLength) active = previousLength;
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    } finally {
      advanceAfterLoad = false;
      loadingMore = false;
      if (spinnerTimer) clearInterval(spinnerTimer);
      spinnerTimer = undefined;
      if (!finished) redraw();
    }
  };
  redraw();
  return new Promise((resolve, reject) => {
    const finish = (result: OpenPullRequest[]) => {
      finished = true;
      if (spinnerTimer) clearInterval(spinnerTimer);
      process.stdin.off("keypress", keypress);
      process.stdin.off("error", inputError);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      closeScreen();
      resolve(result);
    };
    const inputError = (error: Error) => {
      finished = true;
      if (spinnerTimer) clearInterval(spinnerTimer);
      process.stdin.off("keypress", keypress);
      process.stdin.setRawMode?.(false);
      process.stdin.pause();
      closeScreen();
      reject(error);
    };
    const keypress = (_input: string, key: { name?: string; ctrl?: boolean }) => {
      if ((key.ctrl && key.name === "c") || key.name === "q" || key.name === "escape") { finish([]); return; }
      if (key.name === "up" || key.name === "k") active = Math.max(0, active - 1);
      else if (key.name === "down" || key.name === "j") {
        if (active < pullRequests.length - 1) active += 1;
        else if (nextCursor) advanceAfterLoad = true;
        else active = 0;
      }
      else if (key.name === "space") {
        const number = pullRequests[active].number;
        if (selected.has(number)) selected.delete(number); else selected.add(number);
      } else if (key.name === "a") {
        if (selected.size === pullRequests.length) selected.clear(); else for (const pullRequest of pullRequests) selected.add(pullRequest.number);
      } else if (key.name === "return") { finish(pullRequests.filter((pullRequest) => selected.has(pullRequest.number))); return; }
      redraw();
      if (nextCursor && active >= pullRequests.length - 2) void loadMore();
    };
    process.stdin.on("keypress", keypress);
    process.stdin.once("error", inputError);
  });
}

export interface IngestionProgressItem {
  pullRequest: OpenPullRequest;
  state: "pending" | "running" | "complete" | "failed";
  message: string;
  url?: string;
}

export function renderIngestionProgress(
  items: IngestionProgressItem[],
  frame = 0,
  columns = process.stdout.columns ?? 100,
  clear = true,
): string {
  const rows = ["\x1b[1mHeptapod\x1b[22m · Ingest pull requests", ""];
  for (const item of items) {
    const icon = item.state === "running" ? accent(SPINNER_FRAMES[frame])
      : item.state === "complete" ? success("✓")
        : item.state === "failed" ? danger("✕")
          : "·";
    const prefix = `  #${item.pullRequest.number} `;
    rows.push(`${icon} #${item.pullRequest.number} ${truncate(item.pullRequest.title, Math.max(1, columns - prefix.length))}`);
    if (item.state === "complete") rows.push(`  ${success("Complete")} · ${accent(item.url ?? "")}`);
    else if (item.state === "failed") rows.push(`  ${danger("Failed")} · ${item.message}`);
    else rows.push(`  ${muted(truncate(item.message, Math.max(1, columns - 2)))}`);
  }
  return `${clear ? "\x1b[2J\x1b[H" : ""}${rows.join("\n")}\n`;
}

export function createIngestionProgress(pullRequests: OpenPullRequest[]) {
  const items: IngestionProgressItem[] = pullRequests.map((pullRequest) => ({
    pullRequest,
    state: "pending",
    message: "Waiting",
  }));
  const frame = 0;
  let spinner: ChildProcess | undefined;
  const paint = () => process.stdout.write(renderIngestionProgress(items, frame));
  const stopSpinner = () => {
    spinner?.kill();
    spinner = undefined;
  };
  const startSpinner = (number: number) => {
    const index = items.findIndex((item) => item.pullRequest.number === number);
    if (index < 0) return;
    spinner = spawn(process.execPath, ["-e", INGESTION_SPINNER_PROGRAM, String(3 + index * 2)], {
      stdio: ["ignore", "inherit", "ignore"],
    });
    spinner.on("error", () => {});
    spinner.unref();
  };
  const update = (number: number, state: IngestionProgressItem["state"], message: string, url?: string) => {
    stopSpinner();
    const item = items.find((candidate) => candidate.pullRequest.number === number);
    if (!item) return;
    item.state = state;
    item.message = message;
    item.url = url;
    paint();
    if (state === "running") startSpinner(number);
  };
  const closeScreen = enterTuiScreen(stopSpinner);
  paint();
  return {
    start(number: number) { update(number, "running", "Starting ingestion"); },
    progress(number: number, message: string) { update(number, "running", message); },
    complete(number: number, url: string) { update(number, "complete", "Complete", url); },
    fail(number: number, message: string) { update(number, "failed", message); },
    finish() {
      closeScreen();
      process.stdout.write(renderIngestionProgress(items, frame, process.stdout.columns ?? 100, false));
    },
  };
}

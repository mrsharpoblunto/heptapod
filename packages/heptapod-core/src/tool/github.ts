import { run } from "./process.js";
import type { Evidence, GitHubSource } from "./types.js";

interface PullRequestText {
  body?: string;
  comments?: Array<{ body?: string }>;
}

interface PullRequestHtml {
  data?: {
    repository?: {
      pullRequest?: {
        bodyHTML?: string;
        comments?: { nodes?: Array<{ bodyHTML?: string }> };
      };
    };
  };
}

const ATTACHMENT_URL = /https:\/\/github\.com\/user-attachments\/assets\/[a-zA-Z0-9-]+/g;
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((https:\/\/[^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
const VIDEO_DETAILS = /<details[\s\S]*?<span[^>]*class="[^"]*\bm-1\b[^"]*"[^>]*>([^<]+)<\/span>[\s\S]*?<video[^>]+src="([^"]+)"/gi;

function attachmentId(url: string): string | null {
  return url.match(/([a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})/i)?.[1] ?? null;
}

function videoAttachments(htmlTexts: string[]): Map<string, string> {
  const videos = new Map<string, string>();
  for (const html of htmlTexts) {
    for (const match of html.matchAll(VIDEO_DETAILS)) {
      const id = attachmentId(match[2]);
      if (id) videos.set(id, match[1].replaceAll("&amp;", "&").trim() || "Pull request video");
    }
  }
  return videos;
}

export function extractGitHubEvidence(texts: string[], sourceUrl: string, htmlTexts: string[] = []): Evidence[] {
  const evidence = new Map<string, Evidence>();
  const videos = videoAttachments(htmlTexts);
  for (const text of texts) {
    for (const match of text.matchAll(MARKDOWN_IMAGE)) {
      const [, alt, url] = match;
      if (url.includes("github.com/user-attachments/assets/") || url.includes("user-images.githubusercontent.com/")) {
        evidence.set(url, { url, label: alt || "Pull request evidence", kind: "image", sourceUrl });
      }
    }
    for (const match of text.matchAll(ATTACHMENT_URL)) {
      const [url] = match;
      if (!evidence.has(url)) {
        const videoLabel = videos.get(attachmentId(url) ?? "");
        evidence.set(url, {
          url,
          label: videoLabel ?? "Pull request evidence",
          kind: videoLabel ? "video" : "image",
          sourceUrl,
        });
      }
    }
  }
  return [...evidence.values()];
}

export function collectGitHubEvidence(source?: GitHubSource): Evidence[] {
  if (!source) return [];
  let pullRequest: PullRequestText;
  try {
    const result = run("gh", ["pr", "view", source.pullRequestUrl, "--json", "body,comments"], {
      allowFailure: true,
    });
    if (result.status !== 0) return [];
    pullRequest = JSON.parse(result.stdout.toString("utf8")) as PullRequestText;
  } catch {
    return [];
  }

  const texts = [pullRequest.body ?? "", ...(pullRequest.comments ?? []).map((comment) => comment.body ?? "")];
  let htmlTexts: string[] = [];
  try {
    const repository = new URL(source.repositoryUrl).pathname.split("/").filter(Boolean);
    if (repository.length === 2) {
      const query = "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){bodyHTML comments(first:100){nodes{bodyHTML}}}}}";
      const result = run("gh", [
        "api", "graphql",
        "-f", `owner=${repository[0]}`,
        "-f", `name=${repository[1]}`,
        "-F", `number=${source.number}`,
        "-f", `query=${query}`,
      ], { allowFailure: true });
      if (result.status === 0) {
        const rendered = JSON.parse(result.stdout.toString("utf8")) as PullRequestHtml;
        const pullRequestHtml = rendered.data?.repository?.pullRequest;
        htmlTexts = [
          pullRequestHtml?.bodyHTML ?? "",
          ...(pullRequestHtml?.comments?.nodes ?? []).map((comment) => comment.bodyHTML ?? ""),
        ];
      }
    }
  } catch {
    htmlTexts = [];
  }
  return extractGitHubEvidence(texts, source.pullRequestUrl, htmlTexts);
}

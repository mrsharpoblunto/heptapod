import assert from "node:assert/strict";
import { test } from "vitest";
import { findGitHubMediaUrl } from "../src/tool/github-metadata.js";

const asset = "0e4c2d6b-beff-4dea-9b83-afd15b0ba4c5";
test("resolves private image attachments from authenticated PR HTML, preserving signed parameters", () => {
  const image = `https://private-user-images.githubusercontent.com/781106/649120039-${asset}.png?jwt=signed&amp;download=1`;
  assert.equal(findGitHubMediaUrl(`<a href="https://github.com/example/repo/pull/62"><img alt="Screenshot" src="${image}"></a>`, asset, "image"), image.replaceAll("&amp;", "&"));
});
test("matches the requested media type and rejects unrelated or untrusted URLs", () => {
  const video = `https://private-user-images.githubusercontent.com/1/${asset}.mov?jwt=signed`;
  const html = `<img src="https://example.com/${asset}.png"><img src="https://user-images.githubusercontent.com/unrelated.png"><video src="${video}"></video>`;
  assert.equal(findGitHubMediaUrl(html, asset, "image"), null);
  assert.equal(findGitHubMediaUrl(html, asset, "video"), video);
});

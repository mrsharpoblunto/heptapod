import { validateReviewId } from "./cache.js";
import { serviceWebUrl } from "./service-config.js";

export function buildReviewUrl(id: string, siteUrl?: string): string {
  validateReviewId(id);
  const base = new URL(siteUrl ?? process.env.HEPTAPOD_URL ?? serviceWebUrl());
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("Heptapod site URL must use http or https.");
  }
  base.pathname = `/reviews/${id.split("/").map(encodeURIComponent).join("/")}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

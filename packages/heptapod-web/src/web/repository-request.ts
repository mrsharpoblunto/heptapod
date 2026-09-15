import { getRepository, repositoryDatabasePath } from "@thestraylight/heptapod-core/repositories";

export function repositoryDatabaseForRequest(request: Request): string | undefined | null {
  const id = new URL(request.url).searchParams.get("repository");
  if (!id) return undefined;
  return getRepository(id) ? repositoryDatabasePath(id) : null;
}

import { listRepositories } from "@thestraylight/heptapod-core/repositories";
import { RepositoryIndex } from "../src/web/RepositoryIndex";
import { SetupChecklist } from "../src/web/SetupChecklist";
import { SetupProvider } from "../src/web/SetupContext";
import { startSetupChecks } from "../src/web/setup-checks";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default function RepositoryIndexPage() {
  const entries = listRepositories().map((repository) => ({
    repository,
    checklist: <SetupProvider promises={startSetupChecks(repository.root)}><SetupChecklist /></SetupProvider>,
  }));
  return <RepositoryIndex entries={entries} />;
}

"use client";

import { FolderGit2, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import type { RegisteredRepository } from "@thestraylight/heptapod-core/repositories";
import { ListCard } from "./ListCard";
import { useToast } from "./Toasts";

export function RepositoryIndex({ entries }: { entries: Array<{ repository: RegisteredRepository; checklist: ReactNode }> }) {
  const router = useRouter();
  const notify = useToast();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const add = async () => {
    if (adding) return;
    setAdding(true);
    try {
      const response = await fetch("/api/service/repositories/pick", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not add the repository.");
      if (!result.cancelled) router.refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setAdding(false); }
  };
  const remove = async (repository: RegisteredRepository) => {
    if (!window.confirm(`Remove ${repository.name} from Heptapod? Repository files and retained review data will not be deleted.`)) return;
    setRemoving(repository.id);
    try {
      const response = await fetch(`/api/service/repositories/${encodeURIComponent(repository.id)}`, { method: "DELETE" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not remove the repository.");
      router.refresh();
    } catch (error) { notify(error instanceof Error ? error.message : String(error)); }
    finally { setRemoving(null); }
  };
  return <main className="review-index-scene"><div className="review-index repository-index">
    <header className="review-index-header"><div><h1 className="review-index-title">HEPTAPOD</h1></div></header>
    <div className="repository-section-header"><h2 className="review-section-title">Repositories</h2><button type="button" className="repository-add-button"
      disabled={adding} aria-label="Add repository" title="Add repository" onClick={() => void add()}><Plus size={18} aria-hidden="true" /></button></div>
    {!entries.length ? <div className="empty-state">Add a local Git repository to begin.</div> : <div className="repository-list">{entries.map(({ repository, checklist }) =>
      <ListCard className="repository-card" clickable key={repository.id}>
        <Link className="repository-card-link" href={`/repositories/${encodeURIComponent(repository.id)}`} aria-label={`Open repository ${repository.name}`} />
        <div className="repository-open">
          <FolderGit2 size={20} aria-hidden="true" /><span><strong>{repository.name}</strong><small>{repository.root}</small></span>
        </div>
        <div className="repository-actions">{checklist}<button className="repository-remove" disabled={removing === repository.id}
          aria-label={`Remove repository ${repository.name}`} title="Remove repository" onClick={() => void remove(repository)}><Trash2 size={16} aria-hidden="true" /></button></div>
      </ListCard>)}</div>}
  </div></main>;
}

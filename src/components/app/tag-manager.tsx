"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { createTag, deleteTag } from "@/lib/actions/settings";

export function TagManager({
  workspaceId,
  tags,
}: {
  workspaceId: string;
  tags: { id: string; name: string; color: string; useCount: number }[];
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [pending, startTransition] = React.useTransition();

  return (
    <div className="border-t border-hairline p-4">
      {tags.length === 0 ? (
        <p className="mb-3 text-[13px] text-faint">No tags in this workspace yet.</p>
      ) : (
        <ul className="mb-3 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <li
              key={tag.id}
              className="group inline-flex items-center gap-1.5 rounded-full border border-hairline py-1 pl-2 pr-1 text-[12px]"
            >
              <span className="size-2 rounded-full" style={{ background: tag.color }} aria-hidden />
              <span className="text-body">{tag.name}</span>
              <span className="text-faint tabular">{tag.useCount}</span>
              <button
                disabled={pending}
                onClick={() =>
                  startTransition(async () => {
                    const result = await deleteTag(tag.id);
                    if (result.ok) router.refresh();
                    else toast.error(result.error);
                  })
                }
                className="rounded-full p-0.5 text-faint opacity-0 transition-opacity hover:bg-sunken hover:text-rose-600 group-hover:opacity-100"
                aria-label={`Delete ${tag.name}`}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          startTransition(async () => {
            const result = await createTag(workspaceId, name);
            if (result.ok) {
              setName("");
              router.refresh();
            } else toast.error(result.error);
          });
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="New tag"
          className="max-w-xs"
        />
        <Button type="submit" size="sm" variant="outline" loading={pending} disabled={!name.trim()}>
          <Plus className="size-3.5" />
          Add
        </Button>
      </form>
    </div>
  );
}

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { restoreFromTrash } from "@/lib/actions/trash";

export type TrashRow = {
  id: string;
  type: string;
  label: string;
  detail: string | null;
  workspaceName: string;
  archivedAt: string;
  daysArchived: number;
};

/**
 * The list that makes archiving reversible in practice.
 *
 * Archive was already reversible on the server; without this screen an
 * archived record simply vanished and there was nowhere to get it back from.
 */
export function TrashList({ items }: { items: TrashRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  if (items.length === 0) {
    return (
      <EmptyState
        icon={<Trash2 className="size-5" />}
        title="Nothing archived"
        description="Archived contacts, companies, deals, projects, opportunities and notes appear here so you can put them back."
      />
    );
  }

  return (
    <ul className="divide-y divide-hairline">
      {items.map((item) => (
        <li key={`${item.type}:${item.id}`} className="flex items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-2 truncate text-[13px] font-medium text-body">
              {item.label}
              <Badge>{item.type}</Badge>
            </p>
            <p className="truncate text-[12px] text-muted">
              {item.detail ? `${item.detail} · ` : ""}
              {item.workspaceName} · archived{" "}
              {item.daysArchived === 0 ? "today" : `${item.daysArchived}d ago`}
            </p>
          </div>

          <Button
            variant="outline"
            size="xs"
            loading={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await restoreFromTrash(item.type, item.id);
                if (result.ok) {
                  toast.success(`${item.label} restored`);
                  router.refresh();
                } else toast.error(result.error);
              })
            }
          >
            <RotateCcw className="size-3" />
            Restore
          </Button>
        </li>
      ))}
    </ul>
  );
}

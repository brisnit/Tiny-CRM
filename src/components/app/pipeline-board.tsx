"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  DndContext, DragOverlay, PointerSensor, KeyboardSensor, closestCorners,
  useDroppable, useSensor, useSensors,
  type DragEndEvent, type DragStartEvent,
} from "@dnd-kit/core";
import { useDraggable } from "@dnd-kit/core";
import { AlertTriangle, Building2, Clock, GripVertical, Plus, TrendingUp } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatCompact } from "@/lib/money";
import { formatDayOnly, timeAgo } from "@/lib/dates";
import { useSyncedState } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { moveDealToStage } from "@/lib/actions/deals";
import { moveOpportunityToStage } from "@/lib/actions/opportunities";

export type BoardCard = {
  id: string;
  name: string;
  valueCents: number;
  stageId: string;
  expectedCloseAt: Date | string | null;
  lastActivityAt: Date | string | null;
  nextStep: string | null;
  company: { id: string; name: string } | null;
  primaryContact: { id: string; fullName: string } | null;
  project: { id: string; name: string } | null;
  intel: {
    winProbability: number;
    momentum: { value: string; score: number; summary: string };
    risks: string[];
    recommendedAction: string;
  };
};

export type BoardColumn = {
  stage: { id: string; name: string; color: string; kind: string; probability: number };
  deals: BoardCard[];
  valueCents: number;
  count: number;
};

/**
 * The pipeline board.
 *
 * Cards move optimistically — the column updates the moment you drop, and only
 * rolls back if the server rejects the move. Dragging a pipeline stage is the
 * single most tactile interaction in a CRM; it should never feel like it is
 * waiting for a round-trip.
 */
export function PipelineBoard({
  columns: initialColumns,
  kind,
  href,
}: {
  columns: BoardColumn[];
  kind: "deal" | "opportunity";
  href: string;
}) {
  const router = useRouter();
  const [columns, setColumns] = useSyncedState(initialColumns);
  const [dragging, setDragging] = React.useState<BoardCard | null>(null);

  const sensors = useSensors(
    // A small distance threshold keeps a click on the card from starting a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor),
  );

  function onDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    const card = columns.flatMap((c) => c.deals).find((d) => d.id === id);
    setDragging(card ?? null);
  }

  function onDragEnd(event: DragEndEvent) {
    setDragging(null);
    const { active, over } = event;
    if (!over) return;

    const cardId = String(active.id);
    const targetStageId = String(over.id);
    const source = columns.find((c) => c.deals.some((d) => d.id === cardId));
    if (!source || source.stage.id === targetStageId) return;

    const card = source.deals.find((d) => d.id === cardId)!;
    const previous = columns;

    // Optimistic move.
    setColumns((current) =>
      current.map((column) => {
        if (column.stage.id === source.stage.id) {
          const deals = column.deals.filter((d) => d.id !== cardId);
          return { ...column, deals, count: deals.length, valueCents: column.valueCents - card.valueCents };
        }
        if (column.stage.id === targetStageId) {
          const deals = [{ ...card, stageId: targetStageId }, ...column.deals];
          return { ...column, deals, count: deals.length, valueCents: column.valueCents + card.valueCents };
        }
        return column;
      }),
    );

    void (async () => {
      const result =
        kind === "deal"
          ? await moveDealToStage(cardId, targetStageId)
          : await moveOpportunityToStage(cardId, targetStageId);

      if (!result.ok) {
        setColumns(previous);
        toast.error(result.error);
        return;
      }
      const target = columns.find((c) => c.stage.id === targetStageId);
      toast.success(`Moved to ${target?.stage.name ?? "a new stage"}`);
      router.refresh();
    })();
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="-mx-4 overflow-x-auto px-4 pb-3 sm:-mx-6 sm:px-6">
        <div className="flex min-w-max gap-3">
          {columns.map((column) => (
            <Column key={column.stage.id} column={column} href={href} />
          ))}
        </div>
      </div>

      <DragOverlay dropAnimation={{ duration: 160, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
        {dragging ? <Card card={dragging} href={href} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

function Column({ column, href }: { column: BoardColumn; href: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.stage.id });

  return (
    <div className="flex w-[286px] shrink-0 flex-col">
      <div className="mb-2 flex items-center gap-2 px-1">
        <span className="size-2 shrink-0 rounded-full" style={{ background: column.stage.color }} aria-hidden />
        <h3 className="truncate text-[12.5px] font-semibold text-body">{column.stage.name}</h3>
        <span className="text-[11px] text-faint tabular">{column.count}</span>
        <span className="ml-auto text-[11.5px] font-medium text-muted tabular">
          {formatCompact(column.valueCents)}
        </span>
      </div>

      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[140px] flex-1 flex-col gap-2 rounded-xl border border-dashed p-2 transition-colors",
          isOver
            ? "border-brand-400 bg-brand-50/50 dark:bg-brand-950/30"
            : "border-hairline bg-sunken/30",
        )}
      >
        {column.deals.length === 0 ? (
          <p className="px-2 py-6 text-center text-[12px] text-faint">
            {isOver ? "Drop here" : "Nothing here"}
          </p>
        ) : (
          column.deals.map((card) => <DraggableCard key={card.id} card={card} href={href} />)
        )}
      </div>
    </div>
  );
}

function DraggableCard({ card, href }: { card: BoardCard; href: string }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: card.id });

  return (
    <div ref={setNodeRef} className={cn(isDragging && "opacity-40")}>
      <Card card={card} href={href} handleProps={{ ...attributes, ...listeners }} />
    </div>
  );
}

function Card({
  card,
  href,
  handleProps,
  overlay,
}: {
  card: BoardCard;
  href: string;
  handleProps?: Record<string, unknown>;
  overlay?: boolean;
}) {
  const momentum = card.intel.momentum.value;
  const alarming = momentum === "stalled" || momentum === "slowing";

  return (
    <div
      className={cn(
        "group rounded-lg border border-hairline bg-panel p-2.5 transition-shadow",
        overlay ? "shadow-pop rotate-[1.5deg]" : "hover:shadow-panel",
      )}
    >
      <div className="flex items-start gap-1.5">
        <button
          {...handleProps}
          className="-ml-1 mt-0.5 cursor-grab touch-none rounded p-0.5 text-faint opacity-0 transition-opacity hover:bg-sunken group-hover:opacity-100 active:cursor-grabbing"
          aria-label={`Drag ${card.name}`}
        >
          <GripVertical className="size-3.5" />
        </button>
        <Link href={`${href}/${card.id}` as never} className="min-w-0 flex-1">
          <p className="line-clamp-2 text-[12.5px] font-medium leading-snug text-body">{card.name}</p>
          {card.company ? (
            <p className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted">
              <Building2 className="size-3 shrink-0" />
              {card.company.name}
            </p>
          ) : null}
        </Link>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-[13px] font-semibold tabular text-body">{formatCompact(card.valueCents)}</span>
        <span className="inline-flex items-center gap-1 text-[11px] text-faint tabular">
          <TrendingUp className="size-3" />
          {card.intel.winProbability}%
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-hairline pt-2">
        {alarming ? (
          <Badge
            tone={
              momentum === "stalled"
                ? "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900"
                : "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900"
            }
          >
            <AlertTriangle className="size-2.5" />
            {momentum === "stalled" ? "Stalled" : "Slowing"}
          </Badge>
        ) : null}
        <span className="inline-flex items-center gap-1 text-[10.5px] text-faint">
          <Clock className="size-2.5" />
          {timeAgo(card.lastActivityAt)}
        </span>
        {card.expectedCloseAt ? (
          <span className="ml-auto text-[10.5px] text-faint">{formatDayOnly(card.expectedCloseAt)}</span>
        ) : null}
      </div>
    </div>
  );
}

/** Shown when a workspace has no pipeline at all. */
export function EmptyBoard({ label }: { label: string }) {
  return (
    <EmptyState
      icon={<Plus />}
      title={`No ${label} yet`}
      description="Deals get a stage, a value and a next step — so you always know what is actually in play."
    />
  );
}

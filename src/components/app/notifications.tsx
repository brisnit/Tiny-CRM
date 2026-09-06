"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle, Bell, CalendarClock, CheckCheck, Clock, Sparkles, TrendingDown, UserRound,
} from "lucide-react";

import { Sheet } from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { timeAgo } from "@/lib/dates";
import { markAllNotificationsRead, markNotificationRead } from "@/lib/actions/notifications";
import { cn } from "@/lib/utils";

export type NotificationItem = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  createdAt: string;
  readAt: string | null;
  workspaceName: string | null;
  href: string | null;
};

const ICONS: Record<string, React.ElementType> = {
  task_due: Clock,
  task_overdue: AlertTriangle,
  deal_inactive: TrendingDown,
  project_risk: AlertTriangle,
  deadline: CalendarClock,
  opportunity_deadline: CalendarClock,
  contact_followup: UserRound,
  ai_recommendation: Sparkles,
};

const TONES: Record<string, string> = {
  task_overdue: "text-rose-500",
  project_risk: "text-rose-500",
  deal_inactive: "text-amber-500",
  deadline: "text-amber-500",
  opportunity_deadline: "text-amber-500",
  ai_recommendation: "text-brand-500",
};

export function NotificationsPanel({
  open,
  onOpenChange,
  notifications,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  notifications: NotificationItem[];
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const unread = notifications.filter((n) => !n.readAt);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      width="sm"
      title="Notifications"
      description={unread.length ? `${unread.length} unread` : "You're all caught up"}
    >
      {unread.length > 0 ? (
        <div className="border-b border-hairline px-5 py-2">
          <button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await markAllNotificationsRead();
                router.refresh();
              })
            }
            className="inline-flex items-center gap-1.5 text-[12px] font-medium text-muted transition-colors hover:text-body disabled:opacity-50"
          >
            <CheckCheck className="size-3.5" />
            Mark all as read
          </button>
        </div>
      ) : null}

      <div className="flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <EmptyState
            icon={<Bell />}
            title="Nothing needs you right now"
            description="Overdue tasks, quiet deals, project risks and approaching deadlines will appear here."
          />
        ) : (
          <ul className="divide-y divide-hairline">
            {notifications.map((n) => {
              const Icon = ICONS[n.type] ?? Bell;
              return (
                <li key={n.id}>
                  <button
                    onClick={() =>
                      startTransition(async () => {
                        if (!n.readAt) await markNotificationRead(n.id);
                        if (n.href) {
                          onOpenChange(false);
                          router.push(n.href as never);
                        }
                        router.refresh();
                      })
                    }
                    className={cn(
                      "flex w-full gap-3 px-5 py-3 text-left transition-colors hover:bg-sunken/60",
                      !n.readAt && "bg-brand-50/30 dark:bg-brand-950/20",
                    )}
                  >
                    <Icon className={cn("mt-0.5 size-4 shrink-0", TONES[n.type] ?? "text-faint")} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-snug text-body">{n.title}</span>
                      {n.body ? (
                        <span className="mt-0.5 block text-[12px] leading-relaxed text-muted">{n.body}</span>
                      ) : null}
                      <span className="mt-1 block text-[11px] text-faint">
                        {timeAgo(n.createdAt)}
                        {n.workspaceName ? ` · ${n.workspaceName}` : ""}
                      </span>
                    </span>
                    {!n.readAt ? (
                      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-500" aria-hidden />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}

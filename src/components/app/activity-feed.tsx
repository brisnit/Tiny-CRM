import * as React from "react";
import Link from "next/link";
import {
  ArrowRightLeft, CalendarDays, CheckSquare, FileText, Mail, MessageSquare,
  Paperclip, Phone, Plus, Sparkles, Users,
} from "lucide-react";

import { formatDay, formatTime, timeAgo } from "@/lib/dates";
import { ACTIVITY_TYPE } from "@/lib/enums";
import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ElementType> = {
  note: FileText,
  call: Phone,
  meeting: CalendarDays,
  email: Mail,
  task: CheckSquare,
  file: Paperclip,
  stage_change: ArrowRightLeft,
  project_update: ArrowRightLeft,
  comment: MessageSquare,
  ai_insight: Sparkles,
  created: Plus,
  field_change: Users,
};

export type ActivityItem = {
  id: string;
  type: string;
  title: string;
  body?: string | null;
  direction?: string | null;
  durationMin?: number | null;
  occurredAt: Date | string;
  contact?: { id: string; fullName: string } | null;
  company?: { id: string; name: string } | null;
  deal?: { id: string; name: string } | null;
  project?: { id: string; name: string } | null;
  actor?: { name: string; avatarUrl?: string | null } | null;
};

/**
 * The chronological record. A continuous rail rather than a stack of cards —
 * the point of a timeline is that it reads as one story.
 */
export function ActivityFeed({
  items,
  showLinks = true,
  dense,
  className,
}: {
  items: ActivityItem[];
  showLinks?: boolean;
  dense?: boolean;
  className?: string;
}) {
  return (
    <ol className={cn("relative", className)}>
      {items.map((item, index) => {
        const Icon = ICONS[item.type] ?? FileText;
        const links = showLinks
          ? [
              item.contact && { href: `/contacts/${item.contact.id}`, label: item.contact.fullName },
              item.company && { href: `/companies/${item.company.id}`, label: item.company.name },
              item.deal && { href: `/deals/${item.deal.id}`, label: item.deal.name },
              item.project && { href: `/projects/${item.project.id}`, label: item.project.name },
            ].filter(Boolean as unknown as (v: unknown) => v is { href: string; label: string })
          : [];

        return (
          <li key={item.id} className="relative flex gap-3">
            {/* Connector rail */}
            <div className="flex flex-col items-center">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-sunken text-faint ring-1 ring-hairline">
                <Icon className="size-3.5" />
              </span>
              {index < items.length - 1 ? <span className="w-px flex-1 bg-hairline" aria-hidden /> : null}
            </div>

            <div className={cn("min-w-0 flex-1", dense ? "pb-3" : "pb-5")}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                <span className="text-[13px] font-medium leading-snug text-body">{item.title}</span>
                <span className="text-[11px] text-faint" title={formatDay(item.occurredAt)}>
                  {timeAgo(item.occurredAt)}
                </span>
                {item.durationMin ? (
                  <span className="text-[11px] text-faint">· {item.durationMin} min</span>
                ) : null}
                {item.direction && item.direction !== "internal" ? (
                  <span className="text-[11px] text-faint">· {item.direction}</span>
                ) : null}
              </div>

              {item.body ? (
                <p className="mt-1 line-clamp-3 text-pretty text-[12.5px] leading-relaxed text-muted">{item.body}</p>
              ) : null}

              {links.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {links.map((link) => (
                    <Link
                      key={link.href}
                      href={link.href as never}
                      className="truncate rounded-md bg-sunken px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-hairline hover:text-body"
                    >
                      {link.label}
                    </Link>
                  ))}
                </div>
              ) : null}

              <div className="mt-1 text-[11px] text-faint">
                {ACTIVITY_TYPE.label(item.type)} · {formatDay(item.occurredAt)} at {formatTime(item.occurredAt)}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

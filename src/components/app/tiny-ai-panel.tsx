"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, Bot, Loader2, RotateCcw, Sparkles, Square } from "lucide-react";

import { Sheet } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Markdown } from "@/components/app/markdown";
import { cn } from "@/lib/utils";

export type AiFocus = {
  type: "contact" | "company" | "deal" | "project" | "opportunity";
  id: string;
  label: string;
} | null;

type Turn = { role: "user" | "assistant"; content: string };

const SUGGESTIONS = [
  "What do I need to do today?",
  "Which deals need attention?",
  "Who haven't I talked to in 30 days?",
  "What projects are at risk?",
  "What should I follow up on?",
];

export function TinyAiPanel({
  open,
  onOpenChange,
  scope,
  focus,
  initialQuestion,
  providerLabel,
  modelBacked,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scope: string;
  focus?: AiFocus;
  initialQuestion?: string | null;
  providerLabel: string;
  modelBacked: boolean;
}) {
  const router = useRouter();
  const [turns, setTurns] = React.useState<Turn[]>([]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);

  const ask = React.useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || streaming) return;

      setInput("");
      setStreaming(true);
      const history = turns.slice(-6);
      setTurns((t) => [...t, { role: "user", content: trimmed }, { role: "assistant", content: "" }]);

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const response = await fetch("/api/ai/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            question: trimmed,
            scope,
            history,
            focus: focus ? { type: focus.type, id: focus.id } : null,
          }),
        });

        if (!response.body) throw new Error("No response body");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          setTurns((t) => {
            const next = [...t];
            const last = next[next.length - 1]!;
            next[next.length - 1] = { ...last, content: last.content + chunk };
            return next;
          });
        }
        // The agent can create records via automations, so refresh after.
        router.refresh();
      } catch (error) {
        if ((error as Error).name !== "AbortError") {
          setTurns((t) => {
            const next = [...t];
            next[next.length - 1] = {
              role: "assistant",
              content: "Something went wrong reaching Tiny AI. Please try again.",
            };
            return next;
          });
        }
      } finally {
        setStreaming(false);
        abortRef.current = null;
      }
    },
    [focus, router, scope, streaming, turns],
  );

  // Fire the question that opened the panel (from ⌘K) exactly once.
  const firedRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (open && initialQuestion && firedRef.current !== initialQuestion) {
      firedRef.current = initialQuestion;
      void ask(initialQuestion);
    }
    if (!open) firedRef.current = null;
  }, [open, initialQuestion, ask]);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  React.useEffect(() => {
    if (open && !initialQuestion) {
      const timer = setTimeout(() => inputRef.current?.focus(), 120);
      return () => clearTimeout(timer);
    }
  }, [open, initialQuestion]);

  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      width="md"
      title={
        <span className="flex items-center gap-2">
          <Sparkles className="size-4 text-brand-500" />
          Tiny AI
        </span>
      }
      description={focus ? `Focused on ${focus.label}` : providerLabel}
    >
      <div ref={scrollRef} className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {turns.length === 0 ? (
          <div className="space-y-5">
            <div className="rounded-xl border border-hairline bg-sunken/50 p-4">
              <p className="text-[13px] leading-relaxed text-body">
                Ask me anything about your business. I read your contacts, deals, projects, tasks and
                activity — {focus ? `right now I'm focused on ${focus.label}.` : "across everything in scope."}
              </p>
              {!modelBacked ? (
                <p className="mt-2.5 border-t border-hairline pt-2.5 text-xs text-muted">
                  Running on the built-in reasoning engine. Scores and risk calls are exact; add an{" "}
                  <code className="rounded bg-panel px-1 py-0.5 font-mono text-[10px]">ANTHROPIC_API_KEY</code> for
                  open-ended answers.
                </p>
              ) : null}
            </div>
            <div className="space-y-1.5">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void ask(s)}
                  className="flex w-full items-center gap-2 rounded-lg border border-hairline px-3 py-2 text-left text-[13px] text-body transition-colors hover:border-brand-300 hover:bg-brand-50/40 dark:hover:bg-brand-950/30"
                >
                  <Bot className="size-3.5 shrink-0 text-brand-500" />
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <div key={i} className="flex justify-end">
              <p className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-500 px-3.5 py-2 text-[13px] leading-relaxed text-white">
                {turn.content}
              </p>
            </div>
          ) : (
            <div key={i} className="flex gap-2.5">
              <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 ring-1 ring-brand-100 dark:bg-brand-950 dark:text-brand-400 dark:ring-brand-900">
                <Sparkles className="size-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                {turn.content ? (
                  <Markdown content={turn.content} />
                ) : (
                  <span className="inline-flex items-center gap-2 text-[13px] text-faint">
                    <Loader2 className="size-3.5 animate-spin" />
                    Reading your CRM…
                  </span>
                )}
              </div>
            </div>
          ),
        )}
      </div>

      <div className="border-t border-hairline p-3">
        <div className="flex items-end gap-2 rounded-xl border border-hairline-strong bg-panel p-2 focus-within:border-brand-400 focus-within:ring-2 focus-within:ring-brand-500/20">
          <textarea
            ref={inputRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${Math.min(e.target.scrollHeight, 140)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void ask(input);
              }
            }}
            placeholder={focus ? `Ask about ${focus.label}…` : "Ask about your business…"}
            className="max-h-36 min-h-[24px] flex-1 resize-none bg-transparent px-1.5 py-1 text-[13px] text-body outline-none placeholder:text-faint"
          />
          {streaming ? (
            <Button
              size="icon-sm"
              variant="subtle"
              onClick={() => abortRef.current?.abort()}
              title="Stop"
            >
              <Square className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="icon-sm"
              variant="brand"
              disabled={!input.trim()}
              onClick={() => void ask(input)}
              title="Send"
            >
              <ArrowUp className="size-4" />
            </Button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-between px-1">
          <p className="text-[11px] text-faint">{providerLabel}</p>
          {turns.length > 0 ? (
            <button
              onClick={() => setTurns([])}
              className={cn("inline-flex items-center gap-1 text-[11px] text-faint transition-colors hover:text-body")}
            >
              <RotateCcw className="size-3" />
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}

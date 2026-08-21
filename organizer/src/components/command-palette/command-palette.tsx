"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { useCommandPalette } from "@/lib/stores/commandPaletteStore";
import { CommandItem } from "./command-item";
import { filterCommands, getCommands, type Command } from "./command-registry";
import { SearchResults } from "./search-results";

interface SearchResponse {
  success: boolean;
  data: {
    events: Array<{ id: string; title: string; slug: string; status: string; startsAt: string }>;
    orders: Array<{ id: string; eventId: string; orderNumber: string; buyerName: string; buyerEmail: string; status: string }>;
    attendees: Array<{ id: string; eventId: string; ticketNumber: string; name: string; email: string; status: string }>;
  };
}

export function CommandPalette() {
  const router = useRouter();
  const params = useParams();
  const currentEventId = typeof params.eventId === "string" ? params.eventId : undefined;
  const { isOpen, query, selectedIndex, close, setQuery, setSelectedIndex } =
    useCommandPalette();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [isSearchMode, setIsSearchMode] = useState(false);
  const [searchResults, setSearchResults] = useState<SearchResponse["data"] | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const allCommands = useMemo(() => getCommands(currentEventId), [currentEventId]);
  const filteredCommands = useMemo(
    () => filterCommands(allCommands, query),
    [allCommands, query],
  );

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const timer = window.setTimeout(() => inputRef.current?.focus(), 50);
    return () => window.clearTimeout(timer);
  }, [isOpen]);

  useEffect(() => {
    if (query.length < 2) {
      setIsSearchMode(false);
      setSearchResults(null);
      setIsSearching(false);
      return;
    }

    if (filteredCommands.length > 0) {
      setIsSearchMode(false);
      setIsSearching(false);
      return;
    }

    setIsSearchMode(true);
    setIsSearching(true);

    const timer = window.setTimeout(async () => {
      try {
        const result = await fetchWithAuth<SearchResponse>(
          `/api/search?q=${encodeURIComponent(query)}`,
          { redirectOnUnauthorized: false },
        );
        setSearchResults(result.data);
      } catch {
        setSearchResults({ events: [], orders: [], attendees: [] });
      } finally {
        setIsSearching(false);
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [filteredCommands.length, query]);

  const executeCommand = useCallback(
    (command: Command) => {
      if (command.href) {
        close();
        router.push(command.href);
        return;
      }

      if (command.action) {
        close();
        command.action();
        return;
      }

      if (command.id === "search-global") {
        setIsSearchMode(true);
      }
    },
    [close, router],
  );

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (isSearchMode) {
      return;
    }

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setSelectedIndex(Math.min(selectedIndex + 1, filteredCommands.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setSelectedIndex(Math.max(selectedIndex - 1, 0));
        break;
      case "Enter":
        event.preventDefault();
        if (filteredCommands[selectedIndex]) {
          executeCommand(filteredCommands[selectedIndex]);
        }
        break;
    }
  }

  useEffect(() => {
    if (!listRef.current) {
      return;
    }

    const activeElement = listRef.current.querySelector("[data-active='true']");
    if (activeElement instanceof HTMLElement) {
      activeElement.scrollIntoView({ block: "nearest" });
    }
  }, [selectedIndex]);

  return (
    <Dialog open={isOpen} onOpenChange={(open) => (!open ? close() : undefined)}>
      <DialogContent className="top-[20%] w-[min(92vw,40rem)] translate-y-0 overflow-hidden p-0">
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <Search className="size-5 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            placeholder="명령어 또는 검색어 입력..."
            className="flex-1 bg-transparent text-base text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="hidden rounded-lg border border-border bg-bg-muted px-2 py-1 text-xs text-muted-foreground sm:inline-block">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[50vh] overflow-y-auto">
          {isSearchMode ? (
            <SearchResults
              events={searchResults?.events ?? []}
              orders={searchResults?.orders ?? []}
              attendees={searchResults?.attendees ?? []}
              isLoading={isSearching}
              onClose={close}
            />
          ) : filteredCommands.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              일치하는 명령이 없습니다. 계속 입력하면 통합 검색으로 전환됩니다.
            </div>
          ) : (
            <div className="space-y-1 p-2">
              {filteredCommands.map((command, index) => (
                <div key={command.id} data-active={index === selectedIndex}>
                  <CommandItem
                    command={command}
                    isActive={index === selectedIndex}
                    onSelect={executeCommand}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-border px-5 py-3 text-xs text-muted-foreground/60">
          <span>↑↓ 이동</span>
          <span>↵ 선택</span>
          <span>ESC 닫기</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}

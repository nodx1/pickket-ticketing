"use client";

import { createContext } from "react";
export type TabId = "community" | "details" | "booking" | "reviews";

export interface DetailPageState {
  activeTab: TabId;
  setActiveTab: (t: TabId) => void;
  /** Shared state for cross-tab data sync */
  bidCount: number;
  viewCount: number;
  totalSeats: number;
  eventStatus: string;
  category: string;
}

export const DetailPageContext = createContext<DetailPageState>({
  activeTab: "community",
  setActiveTab: () => {},
  bidCount: 0,
  viewCount: 0,
  totalSeats: 0,
  eventStatus: "",
  category: "",
});

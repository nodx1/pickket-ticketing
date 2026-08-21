"use client";

import { useEffect, type ReactNode } from "react";
import {
  generateBehaviorToken,
  setBehaviorTokenProvider,
  startBehaviorCollection,
  stopBehaviorCollection,
} from "@pickket/lib";

/**
 * Keep bot-behaviour collection alive across event-detail → booking
 * navigation. Lottery apply is protected by X-Behavior-Token, so a
 * page-local provider leaves the booking route unable to apply after the
 * detail component unmounts.
 */
export function BehaviorTokenProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    startBehaviorCollection();
    setBehaviorTokenProvider(generateBehaviorToken);
    return () => {
      setBehaviorTokenProvider(null);
      stopBehaviorCollection();
    };
  }, []);

  return children;
}

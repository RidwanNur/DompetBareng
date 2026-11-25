"use client";

import { useEffect } from "react";

export function ShareTargetRegistration() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    void navigator.serviceWorker
      .register("/share-target-sw.js", { scope: "/", updateViaCache: "none" })
      .catch(() => {
        // Server tetap menerima kiriman saat service worker tidak aktif.
      });
  }, []);

  return null;
}

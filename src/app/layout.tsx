import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { Wallet } from "lucide-react";
import "@fontsource-variable/lora/wght.css";
import "@fontsource-variable/plus-jakarta-sans/wght.css";
import { BottomNav } from "@/components/layout/bottom-nav";
import { MotionEffects } from "@/components/layout/motion-effects";
import { ShareTargetRegistration } from "@/components/layout/share-target-registration";
import { getCurrentUser } from "@/lib/auth";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "DompetBareng",
    template: "%s | DompetBareng",
  },
  manifest: "/manifest.json",
  icons: { icon: "/icons/icon-192.png" },
};

export const viewport: Viewport = {
  colorScheme: "light",
  themeColor: "#0F766E",
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const user = await getCurrentUser();

  return (
    <html lang="id">
      <body className="app-shell">
        <MotionEffects />
        <header className="app-header">
          <div className="app-header-inner">
            <Link className="app-brand" href="/">
              <span className="app-brand-mark" aria-hidden="true">
                <Wallet size={21} strokeWidth={1.75} />
              </span>
              DompetBareng
            </Link>
            <Link className="app-sign-in" href="/login">
              {user ? "Akun" : "Masuk"}
            </Link>
          </div>
        </header>
        {children}
        <BottomNav />
        <ShareTargetRegistration />
      </body>
    </html>
  );
}

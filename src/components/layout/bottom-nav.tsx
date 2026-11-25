"use client";

import { ChartPie, History, House, UsersRound } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const tabs = [
  { href: "/", label: "Beranda", Icon: House },
  { href: "/riwayat", label: "Riwayat", Icon: History },
  { href: "/laporan", label: "Laporan", Icon: ChartPie },
  { href: "/ruang", label: "Ruang", Icon: UsersRound },
] as const;

export function BottomNav() {
  const pathname = usePathname();

  return (
    <nav id="bottom-nav" className="bottom-nav" aria-label="Navigasi utama">
      {tabs.map(({ href, label, Icon }) => {
        const active =
          pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));

        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className="bottom-nav-link"
          >
            <Icon aria-hidden="true" size={21} strokeWidth={1.75} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

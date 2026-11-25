import { Fragment, type CSSProperties } from "react";
import { formatRupiah } from "@/lib/format";
import type { Rupiah } from "@/types/database";

type AmountProps = {
  value: Rupiah | bigint;
  className: string;
  as?: "p" | "dd";
  showPlus?: boolean;
};

export function DashboardAmount({ value, className, as: Element = "p", showPlus }: AmountProps) {
  const formatted = (showPlus ? "+" : "") + formatRupiah(value);
  const groups = formatted.split(".");

  return (
    <Element className={className} style={{ "--amount-characters": formatted.length } as CSSProperties}>
      {groups.map((group, index) => (
        <Fragment key={index}>
          {index > 0 && <>{ "." }<wbr /></>}
          {group}
        </Fragment>
      ))}
    </Element>
  );
}

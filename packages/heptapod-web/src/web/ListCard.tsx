"use client";

import type { MouseEventHandler, ReactNode } from "react";

export function ListCard({ children, className, clickable = false, onClick }: {
  children: ReactNode;
  className?: string;
  clickable?: boolean;
  onClick?: MouseEventHandler<HTMLElement>;
}) {
  return <article className={`review-list-item${clickable ? " review-list-item-clickable" : ""}${className ? ` ${className}` : ""}`} onClick={onClick}>
    {children}
  </article>;
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { HeptapodBackdrop } from "../src/web/HeptapodBackdrop";
import { ToastProvider } from "../src/web/Toasts";
import { GitHubMetadataStoreProvider } from "../src/web/GitHubIdentity";

export const metadata: Metadata = {
  title: "Heptapod",
  description: "Narrative, verified reviews of large diffs.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <HeptapodBackdrop />
        <ToastProvider><GitHubMetadataStoreProvider>{children}</GitHubMetadataStoreProvider></ToastProvider>
      </body>
    </html>
  );
}

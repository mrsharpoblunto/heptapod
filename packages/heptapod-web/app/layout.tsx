import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { HeptapodBackdrop } from "../src/web/HeptapodBackdrop";
import { ToastProvider } from "../src/web/Toasts";
import { GitHubMetadataStoreProvider } from "../src/web/GitHubIdentity";
import { SetupProvider } from "../src/web/SetupContext";
import { startSetupChecks } from "../src/web/setup-checks";

export const metadata: Metadata = {
  title: "Heptapod",
  description: "Narrative, verified reviews of large diffs.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const setup = startSetupChecks();
  return (
    <html lang="en">
      <body>
        <HeptapodBackdrop />
        <ToastProvider><GitHubMetadataStoreProvider><SetupProvider promises={setup}>{children}</SetupProvider></GitHubMetadataStoreProvider></ToastProvider>
      </body>
    </html>
  );
}

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { GitHubMetadataProvider } from "../src/web/GitHubIdentity";
import "./globals.css";

export const metadata: Metadata = {
  title: "Heptapod",
  description: "Narrative, verified reviews of large diffs.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <GitHubMetadataProvider>
          {children}
        </GitHubMetadataProvider>
      </body>
    </html>
  );
}

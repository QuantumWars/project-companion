import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";

import { Toaster } from "@/components/ui/sonner";
import { ModalProvider } from "@/providers/modal-provider";
import { ThemeProvider } from "@/providers/theme-provider";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Project Companion",
  description: "Project management that runs with your coding agent",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /**
     * `suppressHydrationWarning` is required by next-themes: the theme class is
     * written to <html> by a blocking script before React hydrates, so the
     * server markup and the first client render legitimately differ.
     */
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider>
          <Toaster />
          <ModalProvider />
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}

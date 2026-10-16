// app/layout.tsx
import type { Metadata } from "next";
import { Fraunces, Inter } from "next/font/google";

import AppHeader from "@/components/AppHeader";
import QueryProvider from "@/providers/QueryProvider";
import "./globals.css";

const fontDisplay = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
  // Fraunces supports many weights; keep tight for performance.
  weight: ["400", "600", "700"],
});

const fontBody = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Tastelog",
  description: "Capture recipes and generate grocery lists.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${fontDisplay.variable} ${fontBody.variable}`}>
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <QueryProvider>
          <AppHeader />
          <main className="mx-auto max-w-5xl px-4 py-6">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}

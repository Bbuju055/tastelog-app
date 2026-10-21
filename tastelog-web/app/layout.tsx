// app/layout.tsx
import type { Metadata } from "next";
import { Cormorant_Garamond, Karla } from "next/font/google";

import AppHeader from "@/components/AppHeader";
import QueryProvider from "@/providers/QueryProvider";
import "./globals.css";

const fontDisplay = Cormorant_Garamond({
  subsets: ["latin"],
  variable: "--font-display",
  // Match the native app’s heading and body families.
  weight: ["400", "600", "700"],
});

const fontBody = Karla({
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
      <body className="min-h-screen bg-background text-foreground antialiased">
        <QueryProvider>
          <AppHeader />
          <main className="mx-auto max-w-6xl px-5 py-10 sm:px-8 sm:py-14">{children}</main>
        </QueryProvider>
      </body>
    </html>
  );
}

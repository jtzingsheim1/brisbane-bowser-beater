import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { connection } from "next/server";
import Footer from "@/components/Footer";
import MaintenanceNotice from "@/components/MaintenanceNotice";
import { isKillSwitchEngaged, isStale } from "@/lib/freshness";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Brisbane Bowser Beater",
  description:
    "A web app for Brisbane drivers, combining live fuel price data with an AI-powered fuel strategist.",
};

async function shouldShowMaintenance(): Promise<boolean> {
  // Opts the layout into dynamic rendering — env reads + the staleness
  // check both need to happen per-request, not at build time. Replaces
  // the previous `export const dynamic = "force-dynamic"`; using
  // `connection()` at the call site keeps the dynamic boundary scoped
  // to this check rather than every leaf route segment.
  await connection();

  if (isKillSwitchEngaged()) {
    return true;
  }
  try {
    return await isStale();
  } catch (error) {
    console.error(
      "[freshness] staleness check failed; degrading to maintenance",
      error,
    );
    return true;
  }
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const maintenance = await shouldShowMaintenance();

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <div className="flex flex-1 flex-col">
          {maintenance ? <MaintenanceNotice /> : children}
        </div>
        <Footer />
      </body>
    </html>
  );
}

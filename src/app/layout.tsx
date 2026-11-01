import type { ReactNode } from "react";
import { IBM_Plex_Mono, Inter, Inter_Tight } from "next/font/google";
import "./globals.css";

// Display (numbers, titles, the agent's voice), text, and mono (labels, data).
const display = Inter_Tight({ subsets: ["latin"], weight: ["500"], variable: "--font-display", display: "swap" });
const sans = Inter({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-mono", display: "swap" });

export const metadata = {
  title: "YieldPilot · Stellar",
  description: "An autonomous agent that finds the highest safe yield for idle USDC on Stellar.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${sans.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}

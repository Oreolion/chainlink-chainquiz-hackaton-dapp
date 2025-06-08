import "./globals.css";
import "@rainbow-me/rainbowkit/styles.css";
import { Geist, Geist_Mono } from 'next/font/google';
import type { Metadata } from "next";
import { headers } from "next/headers";
import { Providers } from "../src/providers/provider";

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: "ChainQuiz App",
  description: "Learn to Earn, Interact with ChainQuiz and QuizToken on Base Sepolia",
};

export default async  function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
   const hdrs = await headers();
  const cookie = hdrs.get("cookie") ?? "";
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <Providers cookie={cookie}>{children}</Providers>
      </body>
    </html>
  );
}
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "YUVIX OS",
  description: "An operating system for an independent electronic music career.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full">{children}</body>
    </html>
  );
}

import type { Metadata } from "next";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";

export const metadata: Metadata = {
  title: "Circuit-Nova",
  description: "A task-priced agent operating system.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><ConvexClientProvider>{children}</ConvexClientProvider></body></html>;
}

import type { Metadata } from "next";
import "./globals.css";
import { ConvexClientProvider } from "./ConvexClientProvider";

export const metadata: Metadata = {
  title: "Circuit-Nova",
  description: "A task-priced agent operating system.",
};

const themeScript = `
(function () {
  var KEY = 'circuit-nova-theme';
  var stored = null;
  try { stored = localStorage.getItem(KEY); } catch (e) {}
  var theme = stored === 'light' ? 'light' : stored === 'dark' ? 'dark' : null;
  if (!theme) {
    theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
  }
  document.documentElement.dataset.theme = theme;
})();
`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <ConvexClientProvider>{children}</ConvexClientProvider>
      </body>
    </html>
  );
}